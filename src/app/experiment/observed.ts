import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppInstance } from "../instance.ts";
import type { RunRecord, EventRecord } from "../../runtime/types.ts";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  LlmDemosPolicyContent,
} from "../../decision/index.ts";
import {
  createLlmDemosPolicy,
  parseChoiceResponse,
  parseLlmPolicy,
  isLlmDemosPolicy,
  buildDecisionViewFromInputs,
  parseDecisionViewContent,
} from "../../decision/index.ts";
import { buildLlmChoiceBody, resolveLlmDemosRequest } from "../../adapters/decision-llm/request.ts";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import { modelFreeUsage } from "../../runtime/model-free.ts";
import { captureTaskProjection } from "./development.ts";
import { adaptiveTaskInputDigest } from "./task-input.ts";
import { auditRunVerification } from "./run-verification.ts";
import { selectAdaptiveChoice } from "./adaptive.ts";
import {
  freezeObservedPlan,
  OBSERVED_ARMS,
  type ObservedPlan,
  type ObservedSlot,
  type FrozenObservedPlan,
} from "./observed-plan.ts";

type Deps = Pick<AppInstance, "storage" | "kernel" | "blobs">;
export function observedSnapshotDigest(deps: Deps, id: string) {
  const s = deps.kernel.resolveSnapshot(id);
  return digestOf(
    canonicalJson({
      bindings: s.snapshot.bindings,
      versions: [...s.versions]
        .map(([slot, v]) => ({ slot, id: v.id, digest: v.contentDigest }))
        .sort((a, b) => a.slot.localeCompare(b.slot)),
    }),
  );
}
type Blob = { ref: string; digest: string };
type SlotState = { ordinal: number; runId: string; started: boolean; closed?: Blob };
const stream = (id: string) => `observed-${id}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`observed: ${message}`);
}
function read<T>(deps: Deps, blob: Blob): T {
  const raw = deps.blobs.read(blob.ref);
  check(digestOf(raw) === blob.digest, "blob digest drift");
  return JSON.parse(raw) as T;
}
function events(deps: Deps, id: string) {
  return deps.storage
    .listEvents({ streamId: stream(id) }, Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.seq - b.seq);
}
interface ObservedState {
  log: EventRecord[];
  callLog: EventRecord[];
  frozen: FrozenObservedPlan;
  slots: SlotState[];
  configs: { base: string; demo: string; demoDigest: string } | undefined;
  selection: { snapshotId: string; kind: string } | undefined;
  terminal: EventRecord | undefined;
  organismId: string;
  deadlineAt: number;
  importedCount: number;
}
function state(deps: Deps, id: string): ObservedState {
  const log = events(deps, id);
  check(log[0]?.type === "observed.registered", "unregistered experiment");
  const plan = read<ObservedPlan>(deps, log[0]!.payload.plan as Blob);
  const frozen = freezeObservedPlan(plan);
  check(frozen.digest === log[0]!.payload.manifestDigest, "manifest drift");
  const organismId = log[0]!.organismId!;
  check(
    log.every((e, i) => e.seq === i + 1 && e.organismId === organismId),
    "event sequence/ownership drift",
  );
  const slots: SlotState[] = [];
  let configs: { base: string; demo: string; demoDigest: string } | undefined;
  let selection: { snapshotId: string; kind: string } | undefined;
  let terminal: EventRecord | undefined;
  let importedCount = 0;
  let inheritedLog: EventRecord[] = [];
  for (const e of log.slice(1)) {
    if (e.type === "observed.imported-prefix") {
      const ref = plan.continuedFrom;
      check(
        ref && ref.experimentId !== id && !slots.length && e.payload.parentId === ref.experimentId,
        "invalid continuation parent",
      );
      const parent = state(deps, ref.experimentId);
      check(
        parent.frozen.plan.protocol === "adaptive-observed-v2" &&
          parent.frozen.digest === ref.manifestDigest &&
          parent.terminal &&
          parent.slots.every((r) => r.closed),
        "parent must be a sealed v2 prefix",
      );
      check(e.payload.count === parent.slots.length, "parent prefix length drift");
      check(
        ref.prefixLength === parent.slots.length &&
          ref.configurationDigest === digestOf(canonicalJson(parent.configs ?? null)) &&
          ref.selectionDigest === digestOf(canonicalJson(parent.selection ?? null)),
        "frozen continuation configuration drift",
      );
      slots.push(...parent.slots.map((r) => ({ ...r })));
      configs = parent.configs;
      selection = parent.selection;
      importedCount = slots.length;
      inheritedLog = parent.callLog;
    } else if (e.type === "observed.admitted") {
      check(
        e.payload.ordinal === slots.length &&
          !terminal &&
          (!slots.at(-1) || !!slots.at(-1)!.closed) &&
          e.runId === e.payload.runId &&
          !slots.some((r) => r.runId === e.runId),
        "non-sequential admission",
      );
      slots.push({ ordinal: slots.length, runId: e.payload.runId as string, started: false });
    } else if (e.type === "observed.started") {
      const slot = slots[e.payload.ordinal as number];
      check(slot && !slot.started && !terminal && slot.runId === e.runId, "duplicate start");
      slot.started = true;
    } else if (e.type === "observed.closed") {
      const slot = slots[e.payload.ordinal as number];
      check(
        slot?.started && !slot.closed && !terminal && slot.runId === e.runId,
        "invalid closure",
      );
      slot.closed = e.payload.receipt as Blob;
    } else if (e.type === "observed.configurations") {
      check(!configs && !terminal, "duplicate configurations");
      configs = e.payload.snapshots as typeof configs;
    } else if (e.type === "observed.selection") {
      check(!selection && !terminal, "duplicate selection");
      selection = e.payload.selection as typeof selection;
    } else if (e.type === "observed.finished" || e.type === "observed.stopped") {
      check(!terminal, "duplicate terminal");
      terminal = e;
    } else
      check(
        [
          "observed.counting",
          "observed.counted",
          "observed.sending",
          "observed.received",
          "observed.received-late",
          "observed.transport-unknown",
        ].includes(e.type),
        "unknown event type",
      );
  }
  return {
    log,
    callLog: [...inheritedLog, ...log],
    importedCount,
    frozen,
    slots,
    configs,
    selection,
    terminal,
    organismId,
    deadlineAt: log[0]!.occurredAt + plan.limits.wallClockMs,
  };
}
function expectedSnapshot(s: ReturnType<typeof state>, slot: ObservedSlot) {
  if (slot.phase === "source") return s.frozen.plan.snapshots.source;
  check(s.configs, "configurations not frozen");
  if (slot.phase === "search") return slot.configuration === 0 ? s.configs.base : s.configs.demo;
  check(s.selection, "measurement before development closure");
  return slot.arm === "compiled" ? s.selection.snapshotId : s.configs.base;
}
function verifySnapshot(deps: Deps, s: ReturnType<typeof state>, slot: ObservedSlot) {
  const id = expectedSnapshot(s, slot);
  const digest =
    slot.phase === "source"
      ? s.frozen.plan.snapshotDigests.source
      : id === s.configs?.demo
        ? s.configs.demoDigest
        : s.frozen.plan.snapshotDigests.base;
  check(observedSnapshotDigest(deps, id) === digest, "frozen snapshot binding drift");
}

/** 应用默认装配：即使另一 Host 重开实例也不能绕过已登记观测槽位。 */
export function guardObservedRun(
  deps: Deps,
  run: RunRecord,
  phase: "admit" | "start" | "dispatch",
) {
  if (!run.experimentId?.startsWith("obs:")) return;
  const s = state(deps, run.experimentId);
  check(
    s.organismId === run.organismId && !s.terminal && Date.now() < s.deadlineAt,
    "closed/expired/foreign experiment",
  );
  const slot = s.slots.find((r) => r.runId === run.id);
  check(
    slot && slot.ordinal === s.slots.length - 1 && !slot.closed,
    "Run lacks active admission binding",
  );
  const planned = s.frozen.slots[slot.ordinal]!;
  verifySnapshot(deps, s, planned);
  check(
    run.snapshotId === expectedSnapshot(s, planned) &&
      run.budget.maxAttempts === 1 &&
      run.deadlineAt <= s.deadlineAt,
    "Run configuration drift",
  );
  check(
    run.purpose === (planned.phase === "measurement" ? "evaluation" : "normal"),
    "Run purpose drift",
  );
  const task = deps.storage.getTask(run.taskId)!;
  const c = s.frozen.plan.cases.find((c) => c.id === planned.caseId)!;
  check(
    same(captureTaskProjection(task), {
      ...c.task,
      inputs: [...c.task.inputs].sort((a, b) => a.name.localeCompare(b.name)),
    }),
    "task projection drift",
  );
  const judge = deps.kernel.resolveSnapshot(run.snapshotId).versions.get("acceptance-evaluator")!;
  check(
    task.acceptance.verifier === judge.artifactId &&
      digestOf(readFileSync(task.acceptance.outputSchema, "utf8")) === digestOf(c.schema) &&
      digestOf(readFileSync(task.acceptance.expectedOutput!, "utf8")) === digestOf(c.expected),
    "evaluator material drift",
  );
  for (const version of deps.kernel.resolveSnapshot(run.snapshotId).versions.values())
    check(
      digestOf(deps.blobs.read(version.contentRef)) === version.contentDigest,
      "snapshot content drift",
    );
  if (phase === "start") {
    check(!slot.started, "start already consumed");
    deps.storage.appendEvent({
      streamId: stream(run.experimentId),
      type: "observed.started",
      payload: { ordinal: slot.ordinal },
      organismId: run.organismId,
      runId: run.id,
      occurredAt: Date.now(),
    });
  } else check(phase === "admit" ? !slot.started : slot.started, "invalid dispatch state");
}

export interface ObservedTransport extends DecisionProvider {
  countInputTokens(request: DecisionRequest): Promise<number>;
}

/** 独立于原正式协议：服务计数是预检，绝不对输入签发硬限额证明。 */
export class ObservedExperiment {
  private readonly app: AppInstance;
  private readonly id: string;
  private readonly actorId: string;
  private readonly organismId: string;
  constructor(
    app: AppInstance,
    id: string,
    actorId = "principal-local",
    organismId = "organism-default",
  ) {
    check(id.startsWith("obs:"), "reserved id prefix required");
    this.app = app;
    this.id = id;
    this.actorId = actorId;
    this.organismId = organismId;
  }
  private access() {
    this.app.kernel.assertOrganismAccess(this.organismId, this.actorId);
  }
  private append(type: string, payload: Record<string, unknown>, runId?: string) {
    return this.app.storage.appendEvent({
      streamId: stream(this.id),
      type: `observed.${type}`,
      payload,
      organismId: this.organismId,
      ...(runId ? { runId } : {}),
      occurredAt: Date.now(),
    });
  }
  register(input: unknown) {
    this.access();
    const f = freezeObservedPlan(input);
    const blob = this.app.blobs.write(canonicalJson(f.plan));
    const parent = f.plan.continuedFrom
      ? state(this.app, f.plan.continuedFrom.experimentId)
      : undefined;
    if (parent) {
      check(
        parent.frozen.plan.protocol === "adaptive-observed-v2" &&
          parent.terminal &&
          parent.slots.every((s) => s.closed),
        "continuation requires a closed prefix without in-flight Runs",
      );
      const { continuedFrom, ...plain } = f.plan;
      check(
        same(
          {
            ...plain,
            protocol: parent.frozen.plan.protocol,
            sourceCommit: parent.frozen.plan.sourceCommit,
          },
          parent.frozen.plan,
        ),
        "continuation cannot change model/data/policies/selector/limits",
      );
      check(continuedFrom!.manifestDigest === parent.frozen.digest, "continuation manifest drift");
    }
    this.app.storage.tx(() => {
      check(events(this.app, this.id).length === 0, "already registered; never overwrite/restart");
      for (const snapshot of Object.values(f.plan.snapshots))
        for (const v of this.app.kernel.resolveSnapshot(snapshot).versions.values())
          this.app.kernel.assertVersionAccess(v.id, this.actorId);
      this.append("registered", {
        plan: blob,
        manifestDigest: f.digest,
        active: this.app.kernel.getOrganism(this.organismId)!.activeGenomeId,
      });
      if (parent)
        this.append("imported-prefix", {
          parentId: f.plan.continuedFrom!.experimentId,
          count: parent.slots.length,
        });
      this.app.storage.setDecisionCallLimit(
        { organismId: this.organismId, experimentId: this.id },
        f.plan.limits.calls -
          f.plan.setup.modelCalls -
          (parent?.callLog.filter((e) => e.type === "observed.counting").length ?? 0),
        Date.now(),
      );
    });
    return f;
  }
  continueFrom(parentId: string, sourceCommit: string, expectedReportDigest?: string) {
    this.access();
    const p = state(this.app, parentId);
    check(
      p.frozen.plan.protocol === "adaptive-observed-v2" &&
        p.terminal &&
        p.slots.every((r) => r.closed),
      "continuation parent must be sealed v2",
    );
    check(p.slots.length < p.frozen.slots.length, "parent has no unstarted slots");
    const report = new ObservedExperiment(
      this.app,
      parentId,
      this.actorId,
      this.organismId,
    ).report();
    check(
      p.configs && p.selection && report.development.every((r) => r.meteringComplete),
      "continuation requires frozen selection and verified development",
    );
    const raw = canonicalJson(report);
    if (expectedReportDigest)
      check(digestOf(raw) === expectedReportDigest, "parent report differs from saved evidence");
    const blob = this.app.blobs.write(raw);
    const frozen = this.register({
      ...p.frozen.plan,
      protocol: "adaptive-observed-v3",
      sourceCommit,
      continuedFrom: {
        experimentId: parentId,
        manifestDigest: p.frozen.digest,
        report: blob,
        configurationDigest: digestOf(canonicalJson(p.configs ?? null)),
        selectionDigest: digestOf(canonicalJson(p.selection ?? null)),
        prefixLength: p.slots.length,
      },
    });
    return { frozen, importedRuns: p.slots.length };
  }
  teacher(request: DecisionRequest): Promise<DecisionResult> {
    const s = state(this.app, this.id);
    const slot = s.slots.at(-1);
    check(
      slot?.started &&
        !slot.closed &&
        !s.terminal &&
        s.frozen.slots[slot.ordinal]!.phase === "source",
      "local teacher only allowed in source phase",
    );
    const c = s.frozen.plan.cases.find((c) => c.id === s.frozen.slots[slot.ordinal]!.caseId)!;
    check(request.view?.goal === c.task.goal, "teacher request mismatch");
    return Promise.resolve({
      kind: "value",
      value: c.expectedChoice,
      raw: canonicalJson({ kind: "value", value: c.expectedChoice }),
      provenance: { provider: "decision-observed-source", policyVersion: request.policy.versionId },
    });
  }
  /** 每个远端生成前独立计数，发送许可先持久化；未知结果保留预留且禁止重发。 */
  provider(transport: ObservedTransport): DecisionProvider {
    return {
      name: "decision-llm",
      remote: true,
      capabilities: () => transport.capabilities(),
      prepareRequest: (r) => transport.prepareRequest?.(r),
      callProvenance: (r) => transport.callProvenance?.(r) ?? { adapter: "unavailable" },
      decide: async (request) => {
        const before = this.app.storage.tx(() => {
          this.access();
          const s = state(this.app, this.id);
          const current = s.slots.at(-1);
          check(
            current?.started && !current.closed && !s.terminal && Date.now() < s.deadlineAt,
            "no generation lease",
          );
          check(s.frozen.slots[current.ordinal]!.phase !== "source", "source must be local");
          check(
            request.deadlineMs > 0 && request.deadlineMs <= s.frozen.plan.limits.decisionMs,
            "decision deadline exceeds frozen limit",
          );
          check(
            !s.callLog.some((e) => e.runId === current.runId && e.type === "observed.counting"),
            "generation lease already consumed",
          );
          const count = s.callLog.filter((e) => e.type === "observed.counting").length;
          check(
            count + s.frozen.plan.setup.modelCalls < s.frozen.plan.limits.calls,
            "cumulative generation reservation exhausted",
          );
          const body = isLlmDemosPolicy(request.policy.content)
            ? resolveLlmDemosRequest(request)
            : buildLlmChoiceBody(
                parseLlmPolicy(request.policy.content)!,
                request.view!,
                request.options,
              );
          check(
            body.max_tokens <= 256 && body.model === s.frozen.plan.model,
            "model/output limit drift",
          );
          const prov = transport.callProvenance?.(request);
          check(
            prov?.serviceId === s.frozen.plan.serviceId && prov.adapter === s.frozen.plan.adapter,
            "transport drift",
          );
          const call = this.app.storage.listDecisionCalls(current.runId);
          check(
            call.length === 1 &&
              call[0]!.state === "started" &&
              call[0]!.policyVersionId === request.policy.versionId,
            "request lacks unique Runtime call binding",
          );
          this.append(
            "counting",
            {
              bodyDigest: digestOf(canonicalJson(body)),
              reservation: { inputTokens: 2048, outputTokens: 256 },
            },
            current.runId,
          );
          return {
            runId: current.runId,
            deadlineAt: s.deadlineAt,
            bodyDigest: digestOf(canonicalJson(body)),
          };
        });
        try {
          const count = await transport.countInputTokens(request);
          this.app.storage.tx(() =>
            this.append(
              "counted",
              { inputTokens: Number.isFinite(count) ? count : null },
              before.runId,
            ),
          );
          this.app.storage.tx(() => {
            this.access();
            const s = state(this.app, this.id);
            check(
              !s.terminal && Date.now() < before.deadlineAt && !request.signal?.aborted,
              "cancelled/expired before generation",
            );
            check(
              Number.isSafeInteger(count) && count >= 0 && count <= 2048,
              "service input precheck exceeded/invalid",
            );
            const currentRun = this.app.storage.getRun(before.runId)!;
            for (const v of this.app.kernel
              .resolveSnapshot(currentRun.snapshotId)
              .versions.values())
              this.app.kernel.assertVersionAccess(v.id, this.actorId);
            const body = isLlmDemosPolicy(request.policy.content)
              ? resolveLlmDemosRequest(request)
              : buildLlmChoiceBody(
                  parseLlmPolicy(request.policy.content)!,
                  request.view!,
                  request.options,
                );
            check(digestOf(canonicalJson(body)) === before.bodyDigest, "body drift after counting");
            this.append("sending", {}, before.runId);
          });
          const result = await transport.decide(request);
          const blob = this.app.blobs.write(canonicalJson(result));
          this.app.storage.tx(() =>
            this.append(
              request.signal?.aborted ? "received-late" : "received",
              { result: blob },
              before.runId,
            ),
          );
          return result;
        } catch (error) {
          this.app.storage.tx(() =>
            this.append(
              "transport-unknown",
              { errorType: error instanceof Error ? error.name : "UnknownError" },
              before.runId,
            ),
          );
          throw error;
        }
      },
    };
  }

  private policyVersion(content: LlmDemosPolicyContent, baseVersionId: string) {
    const base = this.app.storage.getArtifactVersion(baseVersionId)!;
    const blob = this.app.blobs.write(canonicalJson(content));
    return this.app.kernel.registerVersion({
      artifact: this.app.storage.getArtifact(base.artifactId)!,
      schemaVersion: 1,
      contentDigest: blob.digest,
      contentRef: blob.ref,
      parents: [base.id],
      dependencies: [base.id, content.fixed.decisionView.versionId],
      scope: `organism:${this.organismId}`,
      createdBy: this.actorId,
    });
  }
  configure() {
    this.access();
    const s = state(this.app, this.id);
    if (s.configs) return s.configs;
    const source = s.frozen.slots.filter((s) => s.phase === "source");
    check(
      s.slots.length === source.length && s.slots.every((s) => s.closed),
      "all deterministic sources must close first",
    );
    const base = this.app.kernel.resolveSnapshot(s.frozen.plan.snapshots.base);
    const policy = base.versions.get("routing-policy")!;
    const view = base.versions.get("decision-view")!;
    const demonstrations = s.frozen.plan.demoCaseIds.map((id) => {
      const c = s.frozen.plan.cases.find((c) => c.id === id)!;
      const slot = s.slots[source.findIndex((s) => s.caseId === id)]!;
      const receipt = this.auditRun(slot.runId, source[slot.ordinal]!);
      check(
        receipt.accepted && receipt.choice === c.expectedChoice,
        "training demonstration failed raw verification",
      );
      const call = this.app.storage.listDecisionCalls(slot.runId)[0]!;
      const request = JSON.parse(this.app.blobs.read(call.requestRef!)) as DecisionRequest;
      const response = { kind: "value" as const, value: c.expectedChoice };
      return {
        id: c.id,
        view: request.view!,
        response,
        source: {
          purpose: "development" as const,
          split: "train" as const,
          permission: "synthetic" as const,
          datasetId: this.id,
          caseId: c.id,
          familyId: c.familyId,
          runId: slot.runId,
          decisionId: call.id,
          verificationRef: slot.closed!.ref,
          viewDigest: digestOf(canonicalJson(request.view)),
          responseDigest: digestOf(canonicalJson(response)),
        },
      };
    });
    const demo = createLlmDemosPolicy({
      basePolicy: {
        versionId: policy.id,
        contentDigest: policy.contentDigest,
        content: JSON.parse(this.app.blobs.read(policy.contentRef)),
      },
      decisionView: {
        versionId: view.id,
        contentDigest: view.contentDigest,
        content: JSON.parse(this.app.blobs.read(view.contentRef)),
      },
      options: ["local-process", "capability/changed-file-summary"],
      demonstrations,
      demoIds: demonstrations.map((d) => d.id),
    });
    const v = this.policyVersion(demo, policy.id);
    const snapshot = this.app.kernel.createSnapshot(
      { ...base.snapshot.bindings, "routing-policy": v.id },
      this.actorId,
    );
    const configs = {
      base: base.snapshot.id,
      demo: snapshot.id,
      demoDigest: observedSnapshotDigest(this.app, snapshot.id),
    };
    this.app.storage.tx(() => {
      check(!state(this.app, this.id).configs, "concurrent configuration");
      this.append("configurations", { snapshots: configs });
    });
    return configs;
  }
  select() {
    const s = state(this.app, this.id);
    if (s.selection) return s.selection;
    const search = s.frozen.slots.filter((s) => s.phase === "search");
    check(s.configs && search.every((p) => s.slots[p.ordinal]?.closed), "search incomplete");
    const scores = [0, 1].map((configuration) => {
      const rows = search.filter((p) => p.configuration === configuration);
      const groups = [
        ...new Set(rows.map((p) => s.frozen.plan.cases.find((c) => c.id === p.caseId)!.familyId)),
      ];
      return (
        groups.reduce((sum, family) => {
          const members = rows.filter(
            (p) => s.frozen.plan.cases.find((c) => c.id === p.caseId)!.familyId === family,
          );
          return (
            sum +
            members.filter(
              (p) =>
                read<RunReceipt>(this.app, s.slots[p.ordinal]!.closed!).choice ===
                s.frozen.plan.cases.find((c) => c.id === p.caseId)!.expectedChoice,
            ).length /
              members.length
          );
        }, 0) / groups.length
      );
    });
    const qualified = scores[1]! >= 0.9 && scores[1]! - scores[0]! >= 0.05 - 1e-12;
    const selection = {
      snapshotId: s.configs.demo,
      kind: qualified ? "development-qualified-demo-selection" : "prespecified-fixed-demo-ablation",
    };
    this.app.storage.tx(() => {
      check(!state(this.app, this.id).selection, "concurrent selection");
      this.append("selection", {
        selection,
        scores,
        qualified,
        independentBenefit: "inconclusive",
      });
    });
    return selection;
  }

  private submission(slot: ObservedSlot) {
    const s = state(this.app, this.id);
    const c = s.frozen.plan.cases.find((c) => c.id === slot.caseId)!;
    const root = join(this.app.root, "observed-materials", this.id.replaceAll(":", "-"), c.id);
    mkdirSync(root, { recursive: true });
    for (const f of c.task.inputs) writeFileSync(join(root, f.name), f.content);
    writeFileSync(join(root, "private-schema.json"), c.schema);
    writeFileSync(join(root, "private-expected.json"), c.expected);
    return {
      requestedBy: this.actorId,
      goal: c.task.goal,
      familyId: c.familyId,
      inputs: c.task.inputs.map((f) => join(root, f.name)),
      requires: ["changed-file-summary"],
      budget: { maxAttempts: 1, maxWallClockSeconds: Math.ceil(s.frozen.plan.limits.runMs / 1000) },
      acceptance: {
        verifier: "experiment-acceptance",
        outputSchema: join(root, "private-schema.json"),
        expectedOutput: join(root, "private-expected.json"),
      },
    };
  }
  async runNext() {
    this.access();
    let s = state(this.app, this.id);
    if (s.terminal) return null;
    check(
      !s.slots.at(-1) || !!s.slots.at(-1)!.closed,
      "unfinished slot; recover unknown, never resend",
    );
    const slot = s.frozen.slots[s.slots.length];
    if (!slot) {
      this.app.storage.tx(() => this.append("finished", {}));
      return null;
    }
    if (slot.phase === "search" && !s.configs) this.configure();
    if (slot.phase === "measurement" && !s.selection) this.select();
    s = state(this.app, this.id);
    const input = this.submission(slot);
    const admitted = this.app.runtime.admitTask(
      input,
      {
        purpose: slot.phase === "measurement" ? "evaluation" : "normal",
        snapshotId: expectedSnapshot(s, slot),
        experimentId: this.id,
        deadlineAt: s.deadlineAt,
      },
      (runId) => {
        const fresh = state(this.app, this.id);
        check(
          !fresh.terminal &&
            fresh.slots.length === slot.ordinal &&
            (!fresh.slots.at(-1) || !!fresh.slots.at(-1)!.closed),
          "admission race",
        );
        this.append("admitted", { ordinal: slot.ordinal, runId }, runId);
      },
    );
    try {
      await this.app.runtime.executeRun(admitted.runId);
      const receipt = this.auditRun(admitted.runId, slot);
      const blob = this.app.blobs.write(canonicalJson(receipt));
      this.app.storage.tx(() => {
        const fresh = state(this.app, this.id);
        check(
          !fresh.terminal &&
            fresh.slots[slot.ordinal]?.runId === admitted.runId &&
            !fresh.slots[slot.ordinal]?.closed,
          "closure race",
        );
        this.append("closed", { ordinal: slot.ordinal, receipt: blob }, admitted.runId);
      });
      check(
        receipt.meteringComplete,
        "unknown/over-limit usage or count drift; stop without retry",
      );
      if (slot.phase === "source") check(receipt.accepted, "deterministic source failed");
      return receipt;
    } catch (error) {
      this.stop(error instanceof Error ? error.message : "unknown");
      throw error;
    }
  }
  stop(reason = "host interrupted") {
    this.access();
    this.app.storage.tx(() => {
      if (!state(this.app, this.id).terminal) this.append("stopped", { reason });
    });
  }

  auditRun(runId: string, slot: ObservedSlot) {
    const s = state(this.app, this.id);
    const c = s.frozen.plan.cases.find((c) => c.id === slot.caseId)!;
    const run = this.app.storage.getRun(runId)!;
    verifySnapshot(this.app, s, slot);
    check(
      run &&
        run.organismId === this.organismId &&
        (run.experimentId === this.id ||
          (slot.ordinal < s.importedCount &&
            run.experimentId === s.frozen.plan.continuedFrom?.experimentId)),
      "raw Run ownership",
    );
    check(
      ["succeeded", "failed", "cancelled"].includes(run.state) &&
        run.snapshotId === expectedSnapshot(s, slot),
      "Run terminal/snapshot mismatch",
    );
    const task = this.app.storage.getTask(run.taskId)!;
    check(task.goal === c.task.goal && task.familyId === c.familyId, "raw task mismatch");
    const calls = this.app.storage.listDecisionCalls(runId);
    check(calls.length === 1, "must retain unique decision");
    const call = calls[0]!;
    check(!["prepared", "started", "unknown"].includes(call.state), "unclosed decision");
    check(
      call.snapshotId === run.snapshotId &&
        call.policyVersionId ===
          this.app.kernel.resolveSnapshot(run.snapshotId).versions.get("routing-policy")!.id,
      "call snapshot binding",
    );
    const req = read<{ view: DecisionRequest["view"]; prepared?: DecisionRequest["prepared"] }>(
      this.app,
      { ref: call.requestRef!, digest: call.requestDigest! },
    );
    const snapshot = this.app.kernel.resolveSnapshot(run.snapshotId);
    for (const v of snapshot.versions.values()) {
      this.app.kernel.assertVersionAccess(v.id, this.actorId);
      check(digestOf(this.app.blobs.read(v.contentRef)) === v.contentDigest, "raw snapshot drift");
    }
    const view = JSON.parse(
      this.app.blobs.read(snapshot.versions.get("decision-view")!.contentRef),
    );
    check(
      same(
        req.view,
        buildDecisionViewFromInputs({
          content: parseDecisionViewContent(view),
          goal: c.task.goal,
          options: ["local-process", "capability/changed-file-summary"],
          inputs: c.task.inputs.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.content) })),
        }),
      ),
      "raw decision view mismatch",
    );
    let choice: string | null = null;
    if (call.responseRef)
      check(
        digestOf(this.app.blobs.read(call.responseRef)) === call.responseDigest,
        "raw decision response drift",
      );
    if (call.state === "value") {
      const raw = this.app.blobs.read(call.responseRef!);
      check(digestOf(raw) === call.responseDigest, "raw decision response drift");
      const parsed = parseChoiceResponse(raw, ["local-process", "capability/changed-file-summary"]);
      check(parsed.kind === "value", "value response mismatch");
      choice = parsed.value;
    }
    const attempts = this.app.runtime.getRunSummary(runId).attempts;
    check(
      attempts.every((a) => ["succeeded", "failed", "cancelled"].includes(a.state)),
      "unknown Attempt",
    );
    for (const a of attempts) {
      check(
        modelFreeUsage(a.evidence, this.app.blobs)?.modelCalls === 0,
        "unbounded worker model usage",
      );
      check(a.evidence!.inputDigest === adaptiveTaskInputDigest(c.task), "worker input drift");
      check(a.evidence!.executor === choice, "worker does not match decision");
    }
    const verification = auditRunVerification(
      { ...this.app, organismId: this.organismId, actorId: this.actorId },
      runId,
    );
    for (const receipt of verification.receipts)
      check(
        receipt.evaluatorDigest ===
          digestOf(
            canonicalJson({
              verifier: "experiment-acceptance",
              outputSchemaDigest: digestOf(c.schema),
              expectedOutputDigest: digestOf(c.expected),
            }),
          ),
        "raw evaluator drift",
      );
    const log = s.callLog.filter((e) => e.runId === runId);
    const sending = log.filter((e) => e.type === "observed.sending");
    const received = log.filter((e) => e.type === "observed.received");
    let modelCalls = 0,
      inputTokens: number | null = 0,
      outputTokens: number | null = 0,
      meteringComplete = true;
    if (slot.phase === "source")
      check(
        call.kind === "local" && !call.sent && !sending.length,
        "source must be deterministic local",
      );
    else {
      check(call.kind === "model" && call.sent, "measurement/search must use model provider");
      const counting = log.filter((e) => e.type === "observed.counting");
      check(counting.length === 1, "missing/duplicate request reservation");
      const policyVersion = snapshot.versions.get("routing-policy")!;
      const content = JSON.parse(this.app.blobs.read(policyVersion.contentRef));
      const rebuild: DecisionRequest = {
        problem: "choice",
        options: ["local-process", "capability/changed-file-summary"],
        context: {},
        view: req.view,
        viewSource: {
          versionId: snapshot.versions.get("decision-view")!.id,
          contentDigest: snapshot.versions.get("decision-view")!.contentDigest,
        },
        policy: { versionId: policyVersion.id, content },
        deadlineMs: 1,
        remainingAttempts: 1,
        ...(req.prepared ? { prepared: req.prepared } : {}),
      };
      const body = isLlmDemosPolicy(content)
        ? resolveLlmDemosRequest(rebuild)
        : buildLlmChoiceBody(parseLlmPolicy(content)!, req.view!, rebuild.options);
      check(
        digestOf(canonicalJson(body)) === counting[0]!.payload.bodyDigest,
        "raw request body drift",
      );
      check(
        call.provenance.serviceId === s.frozen.plan.serviceId &&
          call.provenance.adapter === s.frozen.plan.adapter &&
          call.provenance.requestedModel === s.frozen.plan.model,
        "raw transport drift",
      );
      check(sending.length <= 1 && received.length <= 1, "duplicate network request");
      modelCalls = sending.length;
      inputTokens = call.usage?.inputTokens ?? null;
      outputTokens = call.usage?.outputTokens ?? null;
      const counted = log.filter((e) => e.type === "observed.counted");
      if (sending.length)
        check(
          counted.length === 1 &&
            counting[0]!.seq < counted[0]!.seq &&
            counted[0]!.seq < sending[0]!.seq,
          "counter/send order drift",
        );
      meteringComplete =
        sending.length === 1 &&
        received.length === 1 &&
        counted.length === 1 &&
        inputTokens !== null &&
        outputTokens !== null &&
        inputTokens === counted[0]!.payload.inputTokens &&
        inputTokens <= 2048 &&
        outputTokens <= 256 &&
        (s.frozen.plan.protocol !== "adaptive-observed-v1" ||
          s.frozen.plan.mode === "fixture" ||
          call.provenance.servedModel?.toLowerCase() === s.frozen.plan.model.toLowerCase());
      if (received.length) {
        const result = read<DecisionResult>(this.app, received[0]!.payload.result as Blob);
        if (s.frozen.plan.protocol !== "adaptive-observed-v1")
          meteringComplete =
            meteringComplete &&
            result.evidence?.servedModel?.toLowerCase() === s.frozen.plan.model.toLowerCase();
        check(
          result.evidence?.inputTokens === inputTokens &&
            result.evidence?.outputTokens === outputTokens,
          "service result/ledger metering drift",
        );
        check(
          result.provenance.policyVersion === call.policyVersionId,
          "service result policy drift",
        );
        check(
          result.kind === "value"
            ? call.state === "value" && result.value === choice
            : result.kind === "abstain"
              ? call.state === "abstain"
              : call.state === "invalid_output",
          "service result/decision state drift",
        );
      }
    }
    const selectable = choice !== null && attempts.at(-1)?.state === "succeeded" ? choice : null;
    return {
      runId,
      ordinal: slot.ordinal,
      phase: slot.phase,
      choice,
      selectable,
      accepted: choice === c.expectedChoice && verification.verifiedAcceptance,
      decision: call.state,
      inputTokens,
      outputTokens,
      modelCalls,
      meteringComplete,
      attempts: attempts.length,
      unknownCostItems: attempts.length + (slot.phase === "source" ? 0 : 1),
      latencyMs: run.updatedAt - run.createdAt,
      verificationDigest: verification.digest,
      callId: call.id,
      requestDigest: call.requestDigest,
      responseDigest: call.responseDigest,
    };
  }
  report() {
    this.access();
    const s = state(this.app, this.id);
    for (const e of s.frozen.plan.setup.evidence) read(this.app, e);
    const inherited = s.frozen.plan.continuedFrom
      ? read<{ receipts: RunReceipt[]; elapsedMs: number }>(
          this.app,
          s.frozen.plan.continuedFrom.report,
        )
      : null;
    const receipts = s.slots
      .filter((r) => r.closed)
      .map((r) => {
        const actual = this.auditRun(r.runId, s.frozen.slots[r.ordinal]!);
        check(same(actual, read(this.app, r.closed!)), "receipt/raw evidence drift");
        if (r.ordinal < s.importedCount)
          check(same(actual, inherited!.receipts[r.ordinal]), "frozen parent receipt drift");
        return actual;
      });
    const rows = s.frozen.slots
      .filter((p) => p.phase === "measurement" && p.position === 0)
      .map((p) => {
        const planned = s.frozen.slots.filter((q) => q.unitId === p.unitId);
        const got = planned.map((q) => receipts.find((r) => r.ordinal === q.ordinal));
        const choices = got.map((r) => r?.selectable ?? null);
        const choice = selectAdaptiveChoice(choices);
        const selected = got[choices.indexOf(choice)];
        return {
          unitId: p.unitId,
          caseId: p.caseId,
          arm: p.arm,
          repeat: p.repeat,
          complete: got.every(Boolean),
          choice,
          accepted: got.every(Boolean) && choice !== null && selected?.accepted === true,
          misrouted:
            choice !== null &&
            choice !== s.frozen.plan.cases.find((c) => c.id === p.caseId)!.expectedChoice,
          latencyMs: got.every(Boolean) ? got.reduce((n, r) => n + r!.latencyMs, 0) : null,
        };
      });
    const metrics = (arm: (typeof OBSERVED_ARMS)[number], split: "formal" | "regression") => {
      const cases = s.frozen.plan.cases.filter((c) => c.split === split);
      const families = [...new Set(cases.map((c) => c.familyId))];
      const all = rows.filter((r) => r.arm === arm && cases.some((c) => c.id === r.caseId));
      const rate = (f: (r: (typeof all)[number]) => boolean) =>
        families.reduce((sum, family) => {
          const ids = cases.filter((c) => c.familyId === family).map((c) => c.id);
          const rs = all.filter((r) => ids.includes(r.caseId));
          return sum + rs.filter(f).length / rs.length;
        }, 0) / families.length;
      const latencies = all
        .map((r) => r.latencyMs)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      return {
        planned: all.length,
        completed: all.filter((r) => r.complete).length,
        cases: cases.length,
        families: families.length,
        successRate: rate((r) => r.accepted),
        misrouteRate: rate((r) => r.misrouted),
        failureRate: rate((r) => !r.accepted),
        p95Ms:
          latencies.length === all.length
            ? latencies[Math.ceil(latencies.length * 0.95) - 1]!
            : null,
      };
    };
    const arms = Object.fromEntries(
      OBSERVED_ARMS.map((arm) => [
        arm,
        { formal: metrics(arm, "formal"), regression: metrics(arm, "regression") },
      ]),
    ) as Record<
      (typeof OBSERVED_ARMS)[number],
      { formal: ReturnType<typeof metrics>; regression: ReturnType<typeof metrics> }
    >;
    const partial = s.slots
      .filter((r) => !r.closed)
      .map((r) => ({
        runId: r.runId,
        ordinal: r.ordinal,
        decisionCalls: this.app.storage
          .listDecisionCalls(r.runId)
          .map((c) => ({ id: c.id, kind: c.kind, state: c.state, sent: c.sent, usage: c.usage })),
        attempts: this.app.runtime.getRunSummary(r.runId).attempts,
      }));
    const generations = s.callLog.filter((e) => e.type === "observed.sending");
    const lateUsage = s.callLog
      .filter((e) => e.type === "observed.received-late")
      .map((e) => ({
        runId: e.runId!,
        result: read<DecisionResult>(this.app, e.payload.result as Blob),
      }));
    const returned = s.callLog
      .filter((e) => ["observed.received", "observed.received-late"].includes(e.type))
      .map((e) => ({
        runId: e.runId!,
        result: read<DecisionResult>(this.app, e.payload.result as Blob),
      }));
    check(
      new Set(returned.map((r) => r.runId)).size === returned.length,
      "duplicate service result",
    );
    const actualUsage = (runId: string, key: "inputTokens" | "outputTokens") =>
      receipts.find((r) => r.runId === runId)?.[key] ??
      partial.find((p) => p.runId === runId)?.decisionCalls[0]?.usage?.[key] ??
      returned.find((r) => r.runId === runId)?.result.evidence?.[key] ??
      null;
    const known = (key: "inputTokens" | "outputTokens") =>
      generations.reduce((n, e) => n + (actualUsage(e.runId!, key) ?? 0), 0);
    const criticalFailures = rows
      .filter(
        (r) =>
          r.arm === "compiled" &&
          !r.accepted &&
          (s.frozen.plan.protocol === "adaptive-observed-v1" || r.complete) &&
          s.frozen.plan.cases.some((c) => c.id === r.caseId && c.critical),
      )
      .map((r) => r.unitId);
    const dispatchComplete =
      !!s.terminal &&
      s.terminal.type === "observed.finished" &&
      receipts.length === s.frozen.slots.length;
    const complete = dispatchComplete && receipts.every((r) => r.meteringComplete);
    const c = arms.compiled;
    const qualityGate =
      complete &&
      c.formal.successRate >= 0.9 &&
      c.formal.successRate - arms.single.formal.successRate >= 0.05 - 1e-12 &&
      c.formal.successRate - arms["budget-matched"].formal.successRate >= 0.05 - 1e-12 &&
      c.formal.misrouteRate <= 0.05 &&
      c.formal.failureRate <= 0.05 &&
      (c.formal.p95Ms ?? Infinity) <= 30000 &&
      !criticalFailures.length &&
      c.regression.successRate >=
        Math.max(arms.single.regression.successRate, arms["budget-matched"].regression.successRate);
    return {
      protocol: s.frozen.plan.protocol,
      manifestDigest: s.frozen.digest,
      mode: s.frozen.plan.mode,
      engineering: complete ? "passed" : "incomplete",
      ...(s.frozen.plan.protocol === "adaptive-observed-v3"
        ? {
            dispatchComplete,
            continuation: {
              parent: s.frozen.plan.continuedFrom!,
              importedRuns: s.importedCount,
              newRuns: receipts.length - s.importedCount,
              totalActiveElapsedMs:
                (inherited?.elapsedMs ?? 0) +
                (s.terminal?.occurredAt ?? s.log.at(-1)!.occurredAt) -
                s.log[0]!.occurredAt,
              latencyScope: "sum-active-run-times-excludes-continuation-pause",
            },
          }
        : {}),
      realModel: s.frozen.plan.mode === "real" && generations.length ? "ran" : "not_run",
      benefit: s.frozen.plan.mode === "real" ? "inconclusive" : "not_evaluated",
      formalEvaluation: "not_run",
      adoption: "not_run",
      visibility: "developer-visible",
      semanticIndependence: "unverified",
      inputHardBound: "unverified",
      originalProtocolEligible: false,
      selector: "plurality-first-tie-no-gold-v1",
      selection: s.selection ?? null,
      qualityGate,
      arms,
      armResources: Object.fromEntries(
        OBSERVED_ARMS.map((arm) => {
          const rs = receipts.filter((r) => s.frozen.slots[r.ordinal]!.arm === arm);
          return [
            arm,
            {
              modelCalls: rs.reduce((n, r) => n + r.modelCalls, 0),
              knownInputTokens: rs.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
              knownOutputTokens: rs.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
              executionAttempts: rs.reduce((n, r) => n + r.attempts, 0),
              cumulativeRunMs: rs.reduce((n, r) => n + r.latencyMs, 0),
            },
          ];
        }),
      ),
      criticalFailures,
      ...(s.frozen.plan.protocol !== "adaptive-observed-v1"
        ? {
            criticalMissing: rows
              .filter(
                (r) =>
                  r.arm === "compiled" &&
                  !r.complete &&
                  s.frozen.plan.cases.some((c) => c.id === r.caseId && c.critical),
              )
              .map((r) => r.unitId),
          }
        : {}),
      plannedRuns: s.frozen.slots.length,
      completedRuns: receipts.length,
      plannedModelCalls: s.frozen.plannedCalls,
      reservedModelCalls: s.callLog.filter((e) => e.type === "observed.counting").length,
      sentModelCalls: generations.length,
      setup: s.frozen.plan.setup,
      totalModelCallsIncludingSetup: generations.length + s.frozen.plan.setup.modelCalls,
      totalKnownInputTokensIncludingSetup: known("inputTokens") + s.frozen.plan.setup.inputTokens,
      totalKnownOutputTokensIncludingSetup:
        known("outputTokens") + s.frozen.plan.setup.outputTokens,
      countRequests: s.callLog.filter((e) => e.type === "observed.counting").length,
      reservedInputTokens:
        (s.callLog.filter((e) => e.type === "observed.counting").length +
          s.frozen.plan.setup.modelCalls) *
        2048,
      reservedOutputTokens:
        (s.callLog.filter((e) => e.type === "observed.counting").length +
          s.frozen.plan.setup.modelCalls) *
        256,
      knownInputTokens: known("inputTokens"),
      knownOutputTokens: known("outputTokens"),
      unverifiedUsageCalls: generations.filter(
        (e) => !receipts.some((r) => r.runId === e.runId && r.meteringComplete),
      ).length,
      unknownUsageCalls: generations.filter(
        (e) =>
          actualUsage(e.runId!, "inputTokens") === null ||
          actualUsage(e.runId!, "outputTokens") === null,
      ).length,
      unknownCostItems:
        s.frozen.plan.setup.unknownCostItems +
        receipts.reduce((n, r) => n + r.unknownCostItems, 0) +
        partial.reduce(
          (n, p) =>
            n + p.attempts.length + p.decisionCalls.filter((c) => c.kind === "model").length,
          0,
        ) +
        s.callLog.filter((e) => e.type === "observed.counting").length,
      lateUsage,
      elapsedMs: (s.terminal?.occurredAt ?? s.log.at(-1)!.occurredAt) - s.log[0]!.occurredAt,
      development: receipts.filter((r) => r.phase !== "measurement"),
      partial,
      rows,
      receipts,
      stopReason: s.terminal?.payload.reason ?? null,
      activeUnchanged:
        this.app.kernel.getOrganism(this.organismId)!.activeGenomeId === s.log[0]!.payload.active,
    };
  }
}
type RunReceipt = ReturnType<ObservedExperiment["auditRun"]>;
