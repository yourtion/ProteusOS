import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AppInstance } from "../instance.ts";
import type { RunRecord } from "../../runtime/types.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../../decision/index.ts";
import {
  buildDecisionViewFromInputs,
  parseDecisionViewContent,
  parseChoiceResponse,
  parseLlmDemosPolicy,
} from "../../decision/index.ts";
import {
  prepareLlmDemosRequest,
  resolveLlmDemosRequest,
} from "../../adapters/decision-llm/request.ts";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import { modelFreeUsage } from "../../runtime/model-free.ts";
import { observedCaseSchema } from "./observed-plan.ts";
import { observedSnapshotDigest, type ObservedTransport } from "./observed.ts";
import { captureTaskProjection } from "./development.ts";
import { adaptiveTaskInputDigest } from "./task-input.ts";
import { auditRunVerification } from "./run-verification.ts";

const id = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const blobSchema = z.strictObject({ ref: id, digest: sha });
const conditionSchema = z.strictObject({
  id,
  layout: z.union([z.literal(1), z.literal(2)]),
  output: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)]),
  demos: z.union([z.literal(0), z.literal(2)]),
  snapshotId: id,
  snapshotDigest: sha,
});
const planSchema = z.strictObject({
  protocol: z.enum(["routing-diagnostic-v1", "routing-fixed-output-v1", "routing-output-cap-v1"]),
  maxService5xx: z.literal(2).optional(),
  stage: z.enum(["matrix", "confirmation"]),
  mode: z.enum(["real", "fixture"]),
  sourceCommit: id,
  seed: z.number().int().nonnegative(),
  serviceId: id,
  adapter: id,
  model: id,
  repeats: z.number().int().min(1).max(3),
  cases: z.array(observedCaseSchema).min(2).max(20),
  conditions: z.array(conditionSchema).min(2).max(8),
  prior: z.strictObject({
    experimentId: id,
    report: blobSchema,
    modelCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    unknownUsageCalls: z.number().int().nonnegative(),
    unknownCostItems: z.number().int().nonnegative(),
    instanceModelReservations: z.number().int().nonnegative(),
  }),
  inputPerCall: z.literal(2048),
  runMs: z.union([z.literal(30000), z.literal(90000)]),
  decisionMs: z.union([z.literal(28000), z.literal(85000)]),
  visibility: z.literal("developer-visible"),
  semanticIndependence: z.literal("unverified"),
});
export type DiagnosticPlan = z.infer<typeof planSchema>;
export type DiagnosticCondition = DiagnosticPlan["conditions"][number];
type Deps = Pick<AppInstance, "storage" | "kernel" | "blobs">;
type Blob = z.infer<typeof blobSchema>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`diagnostic: ${message}`);
}
function read<T>(app: Deps, blob: Blob): T {
  const raw = app.blobs.read(blob.ref);
  check(digestOf(raw) === blob.digest, "blob digest drift");
  return JSON.parse(raw) as T;
}
function verifyCondition(app: Deps, condition: DiagnosticCondition, model: string) {
  const snapshot = app.kernel.resolveSnapshot(condition.snapshotId);
  check(
    observedSnapshotDigest(app, condition.snapshotId) === condition.snapshotDigest,
    "configuration digest drift",
  );
  const v = snapshot.versions.get("routing-policy")!;
  const policy = parseLlmDemosPolicy(JSON.parse(app.blobs.read(v.contentRef)));
  check(
    policy.schemaVersion === condition.layout &&
      policy.fixed.basePolicy.content.model === model &&
      policy.fixed.basePolicy.content.sampling.maxOutputTokens === condition.output,
    "configuration label/policy drift",
  );
  check(
    policy.pool.demonstrations.length === 2 &&
      same(
        policy.parameters.demoIds,
        condition.demos ? policy.pool.demonstrations.map((d) => d.id) : [],
      ),
    "frozen example selection drift",
  );
  return canonicalJson({
    bindings: Object.fromEntries(
      Object.entries(snapshot.snapshot.bindings).filter(([slot]) => slot !== "routing-policy"),
    ),
    fixed: {
      ...policy.fixed,
      basePolicy: {
        content: {
          ...policy.fixed.basePolicy.content,
          sampling: { ...policy.fixed.basePolicy.content.sampling, maxOutputTokens: null },
        },
      },
    },
    pool: policy.pool,
  });
}
export function diagnosticSlots(plan: DiagnosticPlan) {
  const slots: Array<{ ordinal: number; caseId: string; conditionId: string; repeat: number }> = [];
  const push = (c: DiagnosticPlan["cases"][number], repeat: number, offset: number) => {
    for (let k = 0; k < plan.conditions.length; k++) {
      const condition = plan.conditions[(k + offset + plan.seed) % plan.conditions.length]!;
      slots.push({ ordinal: slots.length, caseId: c.id, conditionId: condition.id, repeat });
    }
  };
  // First sixteen matrix calls cover both target capabilities and all eight cells.
  for (const [i, c] of plan.cases.slice(0, 2).entries()) push(c, 1, i);
  for (let repeat = 1; repeat <= plan.repeats; repeat++)
    for (const [i, c] of plan.cases.entries())
      if (repeat !== 1 || i >= 2) push(c, repeat, i + repeat - 1);
  return slots;
}
export function freezeDiagnosticPlan(input: unknown) {
  const plan = planSchema.parse(input);
  check(
    (plan.protocol !== "routing-diagnostic-v1") === (plan.maxService5xx === 2),
    "explicit fixed-output failure policy required",
  );
  const capComparison = plan.protocol === "routing-output-cap-v1";
  check(
    capComparison
      ? plan.runMs === 90000 && plan.decisionMs === 85000
      : plan.runMs === 30000 &&
          plan.decisionMs === 28000 &&
          plan.conditions.every((c) => c.output === 256 || c.output === 512),
    "protocol output/time bounds drift",
  );
  if (plan.protocol !== "routing-diagnostic-v1") {
    check(
      plan.stage === "confirmation" &&
        same(
          plan.conditions.map((c) => ({
            id: c.id,
            layout: c.layout,
            output: c.output,
            demos: c.demos,
          })),
          (capComparison ? [1024, 2048] : [512, 256]).map((output) => ({
            id: `v1-t${output}-d0`,
            layout: 1,
            output,
            demos: 0,
          })),
        ),
      "fixed output comparison conditions drift",
    );
  }
  check(new Set(plan.cases.map((c) => c.id)).size === plan.cases.length, "duplicate case");
  check(
    new Set(plan.conditions.map((c) => c.id)).size === plan.conditions.length,
    "duplicate condition",
  );
  for (const c of plan.cases) {
    check(c.split === "search", "development-only cases required");
    adaptiveTaskInputDigest(c.task);
    check(
      c.task.inputs.every((f) => !f.name.includes("/") && !f.name.startsWith("private-")),
      "unsafe task filename",
    );
  }
  if (plan.stage === "matrix") {
    check(
      plan.conditions.length === 8 &&
        new Set(plan.conditions.map((c) => `${c.layout}/${c.output}/${c.demos}`)).size === 8,
      "complete factorial matrix required",
    );
  } else check(plan.conditions.length === 2, "confirmation requires two frozen conditions");
  if (plan.mode === "real") {
    check(plan.cases.length === (plan.stage === "matrix" ? 10 : 20), "real case count drift");
    check(plan.repeats === (plan.stage === "matrix" ? 2 : 3), "real repeat count drift");
    check(
      new Set(plan.cases.map((c) => c.familyId)).size === 10,
      "ten declared template families required",
    );
    check(
      plan.cases.filter((c) => c.expectedChoice === "local-process").length ===
        plan.cases.length / 2,
      "balanced target capabilities required",
    );
  }
  const slots = diagnosticSlots(plan);
  return {
    plan,
    slots,
    digest: digestOf(canonicalJson(plan)),
    wallMs: slots.length * plan.runMs + 300000,
  };
}
function events(app: Deps, experimentId: string) {
  return app.storage
    .listEvents({ streamId: `diagnostic-${experimentId}` }, Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.seq - b.seq);
}
function state(app: Deps, experimentId: string) {
  const log = events(app, experimentId);
  const registered = log[0];
  check(registered?.type === "diagnostic.registered", "experiment not registered");
  const frozen = freezeDiagnosticPlan(read(app, registered.payload.plan as Blob));
  check(frozen.digest === registered.payload.digest, "manifest drift");
  const admitted = log
    .filter((e) => e.type === "diagnostic.admitted")
    .map((e) => {
      const ordinal = e.payload.ordinal as number;
      return {
        ordinal,
        runId: e.runId!,
        started: log.some((x) => x.type === "diagnostic.started" && x.runId === e.runId),
        closed: log.find((x) => x.type === "diagnostic.closed" && x.runId === e.runId)?.payload
          .receipt as Blob | undefined,
      };
    });
  check(
    admitted.every((a, i) => a.ordinal === i) &&
      new Set(admitted.map((a) => a.runId)).size === admitted.length,
    "admission order drift",
  );
  return {
    log,
    frozen,
    admitted,
    registered,
    terminal: log.find((e) => ["diagnostic.finished", "diagnostic.stopped"].includes(e.type)),
    deadlineAt: registered.occurredAt + frozen.wallMs,
  };
}
export function guardDiagnosticRun(
  app: Deps,
  run: RunRecord,
  phase: "admit" | "start" | "dispatch",
) {
  if (!run.experimentId?.startsWith("diag:")) return;
  const s = state(app, run.experimentId);
  const a = s.admitted.at(-1);
  check(
    run.organismId === "organism-default" && !s.terminal && Date.now() < s.deadlineAt,
    "closed/expired/foreign experiment",
  );
  check(a?.runId === run.id && !a.closed, "Run lacks active slot binding");
  const slot = s.frozen.slots[a.ordinal]!;
  const condition = s.frozen.plan.conditions.find((c) => c.id === slot.conditionId)!;
  verifyCondition(app, condition, s.frozen.plan.model);
  check(
    run.snapshotId === condition.snapshotId &&
      observedSnapshotDigest(app, run.snapshotId) === condition.snapshotDigest,
    "snapshot drift",
  );
  check(
    run.purpose === "normal" &&
      run.budget.maxAttempts === 1 &&
      run.budget.maxWallClockSeconds * 1000 === s.frozen.plan.runMs &&
      run.deadlineAt <= s.deadlineAt,
    "Run bounds drift",
  );
  const c = s.frozen.plan.cases.find((c) => c.id === slot.caseId)!;
  const task = app.storage.getTask(run.taskId)!;
  check(
    task.familyId === c.familyId &&
      same(captureTaskProjection(task), {
        ...c.task,
        inputs: [...c.task.inputs].sort((a, b) => a.name.localeCompare(b.name)),
      }),
    "task drift",
  );
  check(
    digestOf(readFileSync(task.acceptance.outputSchema, "utf8")) === digestOf(c.schema) &&
      digestOf(readFileSync(task.acceptance.expectedOutput!, "utf8")) === digestOf(c.expected),
    "judge material drift",
  );
  for (const v of app.kernel.resolveSnapshot(run.snapshotId).versions.values()) {
    app.kernel.assertVersionAccess(v.id, "principal-local");
    check(digestOf(app.blobs.read(v.contentRef)) === v.contentDigest, "snapshot blob drift");
  }
  if (phase === "start") {
    check(!a.started, "start already consumed");
    app.storage.appendEvent({
      streamId: `diagnostic-${run.experimentId}`,
      type: "diagnostic.started",
      payload: { ordinal: a.ordinal },
      organismId: run.organismId,
      runId: run.id,
      occurredAt: Date.now(),
    });
  } else check(phase === "admit" ? !a.started : a.started, "invalid dispatch state");
}

export class DiagnosticExperiment {
  readonly app: AppInstance;
  readonly id: string;
  constructor(app: AppInstance, id: string) {
    check(id.startsWith("diag:"), "reserved diagnostic prefix required");
    this.app = app;
    this.id = id;
  }
  private access() {
    this.app.kernel.assertOrganismAccess("organism-default", "principal-local");
  }
  private append(type: string, payload: Record<string, unknown>, runId?: string) {
    return this.app.storage.appendEvent({
      streamId: `diagnostic-${this.id}`,
      type: `diagnostic.${type}`,
      payload,
      organismId: "organism-default",
      ...(runId ? { runId } : {}),
      occurredAt: Date.now(),
    });
  }
  register(input: unknown) {
    this.access();
    const f = freezeDiagnosticPlan(input);
    read(this.app, f.plan.prior.report);
    const signatures = f.plan.conditions.map((c) => verifyCondition(this.app, c, f.plan.model));
    check(new Set(signatures).size === 1, "only layout/output/example factors may differ");
    this.app.storage.tx(() => {
      check(!events(this.app, this.id).length, "already registered; never restart");
      this.append("registered", {
        plan: this.app.blobs.write(canonicalJson(f.plan)),
        digest: f.digest,
        active: this.app.kernel.getOrganism("organism-default")!.activeGenomeId,
      });
      this.app.storage.setDecisionCallLimit(
        { organismId: "organism-default", experimentId: this.id },
        f.slots.length,
        Date.now(),
      );
      this.app.storage.setDecisionCallLimit(
        { organismId: "organism-default" },
        f.plan.prior.instanceModelReservations + f.slots.length,
        Date.now(),
      );
    });
    return f;
  }
  provider(transport: ObservedTransport): DecisionProvider {
    return {
      name: "decision-llm",
      remote: true,
      capabilities: () => transport.capabilities(),
      prepareRequest: (r) => transport.prepareRequest?.(r),
      callProvenance: (r) => transport.callProvenance?.(r) ?? { adapter: "unavailable" },
      decide: async (request) => {
        const lease = this.app.storage.tx(() => {
          this.access();
          const s = state(this.app, this.id);
          const a = s.admitted.at(-1);
          check(
            a?.started && !a.closed && !s.terminal && !request.signal?.aborted,
            "no generation lease",
          );
          check(
            !s.log.some((e) => e.type === "diagnostic.counting" && e.runId === a.runId),
            "lease already consumed; never resend",
          );
          check(
            s.log.filter((e) => e.type === "diagnostic.counting").length < s.frozen.slots.length,
            "reservation exhausted",
          );
          const slot = s.frozen.slots[a.ordinal]!;
          const condition = s.frozen.plan.conditions.find((c) => c.id === slot.conditionId)!;
          const body = resolveLlmDemosRequest(request);
          const prov = transport.callProvenance?.(request);
          check(
            body.max_tokens === condition.output &&
              body.model === s.frozen.plan.model &&
              request.deadlineMs <= s.frozen.plan.decisionMs,
            "generation bounds drift",
          );
          check(
            prov?.serviceId === s.frozen.plan.serviceId && prov.adapter === s.frozen.plan.adapter,
            "transport drift",
          );
          const calls = this.app.storage.listDecisionCalls(a.runId);
          check(
            calls.length === 1 &&
              calls[0]!.state === "started" &&
              calls[0]!.policyVersionId === request.policy.versionId,
            "unique Runtime call required",
          );
          const stored = read<DecisionRequest>(this.app, {
            ref: calls[0]!.requestRef!,
            digest: calls[0]!.requestDigest!,
          });
          check(same(stored.prepared?.body, body), "request differs from frozen Runtime body");
          const bodyDigest = digestOf(canonicalJson(body));
          this.append(
            "counting",
            { bodyDigest, inputReserved: 2048, outputReserved: condition.output },
            a.runId,
          );
          return { runId: a.runId, bodyDigest, deadlineAt: s.deadlineAt };
        });
        try {
          const count = await transport.countInputTokens(request);
          this.app.storage.tx(() => {
            this.append(
              "counted",
              { inputTokens: Number.isSafeInteger(count) ? count : null },
              lease.runId,
            );
            const s = state(this.app, this.id);
            this.access();
            check(
              !s.terminal && Date.now() < lease.deadlineAt && !request.signal?.aborted,
              "cancelled/expired before generation",
            );
            check(
              Number.isSafeInteger(count) && count >= 0 && count <= 2048,
              "input precheck invalid/over limit",
            );
            check(
              digestOf(canonicalJson(resolveLlmDemosRequest(request))) === lease.bodyDigest,
              "body changed after count",
            );
            for (const v of this.app.kernel
              .resolveSnapshot(this.app.storage.getRun(lease.runId)!.snapshotId)
              .versions.values())
              this.app.kernel.assertVersionAccess(v.id, "principal-local");
            this.append("sending", {}, lease.runId);
          });
          const result = await transport.decide(request);
          const blob = this.app.blobs.write(canonicalJson(result));
          this.app.storage.tx(() =>
            this.append(
              request.signal?.aborted ? "received-late" : "received",
              { result: blob },
              lease.runId,
            ),
          );
          return result;
        } catch (error) {
          const status =
            typeof error === "object" && error !== null
              ? (error as { status?: unknown }).status
              : null;
          this.app.storage.tx(() =>
            this.append(
              "transport-unknown",
              {
                errorType: error instanceof Error ? error.name : "UnknownError",
                httpStatus:
                  typeof status === "number" &&
                  Number.isInteger(status) &&
                  status >= 100 &&
                  status <= 599
                    ? status
                    : null,
              },
              lease.runId,
            ),
          );
          throw error;
        }
      },
    };
  }
  async runNext() {
    this.access();
    let s = state(this.app, this.id);
    if (s.terminal) return null;
    check(!s.admitted.at(-1) || s.admitted.at(-1)!.closed, "unfinished slot; never resend");
    const slot = s.frozen.slots[s.admitted.length];
    if (!slot) {
      this.app.storage.tx(() => this.append("finished", {}));
      return null;
    }
    if (Date.now() + s.frozen.plan.runMs > s.deadlineAt) {
      this.stop("insufficient full Run time; no next send");
      return null;
    }
    if (s.frozen.plan.stage === "matrix" && slot.ordinal === 16) {
      const first = this.report().receipts;
      if (!first.some((r) => r.decision === "value")) {
        this.stop("first sixteen cells contain no valid value");
        return null;
      }
    }
    const c = s.frozen.plan.cases.find((c) => c.id === slot.caseId)!;
    const condition = s.frozen.plan.conditions.find((c) => c.id === slot.conditionId)!;
    const root = join(this.app.root, "diagnostic-materials", this.id.replaceAll(":", "-"), c.id);
    mkdirSync(root, { recursive: true });
    for (const f of c.task.inputs) writeFileSync(join(root, f.name), f.content);
    writeFileSync(join(root, "private-schema.json"), c.schema);
    writeFileSync(join(root, "private-expected.json"), c.expected);
    const admitted = this.app.runtime.admitTask(
      {
        requestedBy: "principal-local",
        goal: c.task.goal,
        familyId: c.familyId,
        inputs: c.task.inputs.map((f) => join(root, f.name)),
        requires: ["changed-file-summary"],
        budget: { maxAttempts: 1, maxWallClockSeconds: s.frozen.plan.runMs / 1000 },
        acceptance: {
          verifier: "experiment-acceptance",
          outputSchema: join(root, "private-schema.json"),
          expectedOutput: join(root, "private-expected.json"),
        },
      },
      {
        purpose: "normal",
        snapshotId: condition.snapshotId,
        experimentId: this.id,
        deadlineAt: s.deadlineAt,
      },
      (runId) => {
        const fresh = state(this.app, this.id);
        check(
          !fresh.terminal &&
            fresh.admitted.length === slot.ordinal &&
            (!fresh.admitted.at(-1) || fresh.admitted.at(-1)!.closed),
          "admission race",
        );
        this.append("admitted", { ordinal: slot.ordinal }, runId);
      },
    );
    try {
      await this.app.runtime.executeRun(admitted.runId);
      const receipt = this.audit(admitted.runId, slot.ordinal);
      this.app.storage.tx(() => {
        s = state(this.app, this.id);
        check(!s.terminal && !s.admitted[slot.ordinal]!.closed, "closure race");
        this.append(
          "closed",
          { ordinal: slot.ordinal, receipt: this.app.blobs.write(canonicalJson(receipt)) },
          admitted.runId,
        );
      });
      if (!receipt.meteringComplete || !receipt.serviceEvidenceComplete) {
        const current = state(this.app, this.id);
        const errors = current.log.filter(
          (e) =>
            e.type === "diagnostic.transport-unknown" &&
            [500, 502, 503, 504].includes(e.payload.httpStatus as number),
        );
        const tolerated =
          current.frozen.plan.protocol !== "routing-diagnostic-v1" &&
          receipt.decision === "transport_error" &&
          errors.some((e) => e.runId === receipt.runId) &&
          errors.length <= 2 &&
          current.log.some((e) => e.type === "diagnostic.sending" && e.runId === receipt.runId);
        check(
          tolerated,
          "unknown/over-limit usage or missing service metadata; stop without retry",
        );
      }
      return receipt;
    } catch (error) {
      this.stop(error instanceof Error ? error.message : "unknown");
      throw error;
    }
  }
  stop(reason: string) {
    this.access();
    this.app.storage.tx(() => {
      if (!state(this.app, this.id).terminal) this.append("stopped", { reason });
    });
  }
  private audit(runId: string, ordinal: number) {
    const s = state(this.app, this.id);
    const p = s.frozen.plan;
    const slot = s.frozen.slots[ordinal]!;
    const c = p.cases.find((c) => c.id === slot.caseId)!;
    const condition = p.conditions.find((c) => c.id === slot.conditionId)!;
    const run = this.app.storage.getRun(runId)!;
    check(
      run.experimentId === this.id &&
        run.snapshotId === condition.snapshotId &&
        ["succeeded", "failed", "cancelled"].includes(run.state),
      "raw Run ownership/state drift",
    );
    check(
      observedSnapshotDigest(this.app, run.snapshotId) === condition.snapshotDigest,
      "raw configuration drift",
    );
    const task = this.app.storage.getTask(run.taskId)!;
    check(task.goal === c.task.goal && task.familyId === c.familyId, "raw task drift");
    const calls = this.app.storage.listDecisionCalls(runId);
    check(calls.length === 1, "exactly one decision required");
    const call = calls[0]!;
    const snapshot = this.app.kernel.resolveSnapshot(run.snapshotId);
    const policy = snapshot.versions.get("routing-policy")!;
    for (const v of snapshot.versions.values()) {
      this.app.kernel.assertVersionAccess(v.id, "principal-local");
      check(
        digestOf(this.app.blobs.read(v.contentRef)) === v.contentDigest,
        "raw snapshot blob drift",
      );
    }
    const req = read<DecisionRequest>(this.app, {
      ref: call.requestRef!,
      digest: call.requestDigest!,
    });
    const viewVersion = snapshot.versions.get("decision-view")!;
    const view = buildDecisionViewFromInputs({
      content: parseDecisionViewContent(JSON.parse(this.app.blobs.read(viewVersion.contentRef))),
      goal: c.task.goal,
      options: ["local-process", "capability/changed-file-summary"],
      inputs: c.task.inputs.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.content) })),
    });
    check(
      same(req.view, view) && call.policyVersionId === policy.id,
      "raw decision view/policy drift",
    );
    const expected = prepareLlmDemosRequest({
      ...req,
      policy: { versionId: policy.id, content: JSON.parse(this.app.blobs.read(policy.contentRef)) },
      viewSource: { versionId: viewVersion.id, contentDigest: viewVersion.contentDigest },
      view,
    });
    check(same(req.prepared, expected), "raw prepared body drift");
    const responses = s.log.filter(
      (e) =>
        ["diagnostic.received", "diagnostic.received-late"].includes(e.type) && e.runId === runId,
    );
    check(responses.length <= 1, "duplicate service result");
    const result = responses[0]
      ? read<DecisionResult>(this.app, responses[0].payload.result as Blob)
      : null;
    if (result) {
      check(
        result.provenance.provider === "decision-llm" &&
          result.provenance.policyVersion === call.policyVersionId,
        "service result policy/provider drift",
      );
      if (responses[0]!.type === "diagnostic.received") {
        check(
          result.kind === "value"
            ? call.state === "value"
            : result.kind === "abstain"
              ? call.state === "abstain"
              : call.state === "invalid_output",
          "service result/Runtime state drift",
        );
      }
    }
    const counted = s.log.find((e) => e.type === "diagnostic.counted" && e.runId === runId)?.payload
      .inputTokens;
    const inputTokens = call.usage?.inputTokens ?? result?.evidence?.inputTokens ?? null;
    const outputTokens = call.usage?.outputTokens ?? result?.evidence?.outputTokens ?? null;
    let choice: string | null = null;
    if (call.responseRef) {
      const raw = this.app.blobs.read(call.responseRef);
      check(digestOf(raw) === call.responseDigest, "response digest drift");
      if (result?.raw !== undefined) check(raw === result.raw, "Runtime/service response drift");
      if (call.state === "value") {
        const parsed = parseChoiceResponse(raw, [
          "local-process",
          "capability/changed-file-summary",
        ]);
        check(parsed.kind === "value", "raw value mismatch");
        choice = parsed.value;
      }
    }
    const attempts = this.app.runtime.getRunSummary(runId).attempts;
    for (const a of attempts)
      check(
        modelFreeUsage(a.evidence, this.app.blobs)?.modelCalls === 0 &&
          a.evidence?.inputDigest === adaptiveTaskInputDigest(c.task) &&
          a.evidence.executor === choice,
        "worker constraint/input/choice drift",
      );
    const verification = auditRunVerification(
      { ...this.app, organismId: "organism-default", actorId: "principal-local" },
      runId,
    );
    for (const r of verification.receipts)
      check(
        r.evaluatorDigest ===
          digestOf(
            canonicalJson({
              verifier: "experiment-acceptance",
              outputSchemaDigest: digestOf(c.schema),
              expectedOutputDigest: digestOf(c.expected),
            }),
          ),
        "JSON evaluator drift",
      );
    const evidence = result?.evidence?.serviceResponse;
    if (evidence && result && !(result.kind === "abstain" && result.origin === "service_refusal")) {
      check(
        evidence.textBytes === Buffer.byteLength(result.raw ?? "", "utf8"),
        "service text byte count drift",
      );
    }
    const evidenceEvents = this.app.storage.runEventsByType(runId, "decision.response_evidence");
    const serviceEvidenceComplete =
      !!evidence &&
      evidence.stopReason !== null &&
      evidence.contentBlockTypes !== null &&
      evidenceEvents.length === 1 &&
      same(evidenceEvents[0]!.payload.serviceResponse, evidence) &&
      evidenceEvents[0]!.payload.decisionId === call.id &&
      evidenceEvents[0]!.payload.servedModel === result?.evidence?.servedModel;
    const meteringComplete =
      !!result &&
      !!call.usage &&
      Number.isSafeInteger(inputTokens) &&
      inputTokens! >= 0 &&
      inputTokens! <= 2048 &&
      counted === inputTokens &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens! >= 0 &&
      outputTokens! <= condition.output &&
      result.evidence?.inputTokens === inputTokens &&
      result.evidence.outputTokens === outputTokens &&
      result.evidence.servedModel?.toLowerCase() === p.model.toLowerCase();
    return {
      ordinal,
      runId,
      callId: call.id,
      caseId: c.id,
      familyId: c.familyId,
      conditionId: condition.id,
      repeat: slot.repeat,
      decision: call.state,
      choice,
      jsonValid:
        result?.kind === "value" || (result?.kind === "abstain" && result.origin === "model"),
      accepted: choice === c.expectedChoice && verification.verifiedAcceptance,
      misrouted: choice !== null && choice !== c.expectedChoice,
      inputTokens,
      outputTokens,
      meteringComplete,
      serviceEvidenceComplete,
      serviceResponse: evidence ?? null,
      latencyMs: run.updatedAt - run.createdAt,
      executionAttempts: attempts.length,
      verificationDigest: digestOf(canonicalJson(verification)),
      responseDigest: call.responseDigest,
    };
  }
  report() {
    this.access();
    const s = state(this.app, this.id);
    const p = s.frozen.plan;
    read(this.app, p.prior.report);
    const receipts = s.admitted
      .filter((a) => a.closed)
      .map((a) => {
        const actual = this.audit(a.runId, a.ordinal);
        check(same(actual, read(this.app, a.closed!)), "receipt/raw drift");
        return actual;
      });
    const received = s.log
      .filter((e) => ["diagnostic.received", "diagnostic.received-late"].includes(e.type))
      .map((e) => ({
        runId: e.runId!,
        result: read<DecisionResult>(this.app, e.payload.result as Blob),
      }));
    check(new Set(received.map((r) => r.runId)).size === received.length, "duplicate result");
    const sends = s.log.filter((e) => e.type === "diagnostic.sending");
    const token = (runId: string, key: "inputTokens" | "outputTokens") =>
      this.app.storage.listDecisionCalls(runId)[0]?.usage?.[key] ??
      received.find((r) => r.runId === runId)?.result.evidence?.[key] ??
      null;
    const known = (key: "inputTokens" | "outputTokens") =>
      sends.reduce((n, e) => n + (token(e.runId!, key) ?? 0), 0);
    const executionAttempts = s.admitted.reduce(
      (n, a) => n + this.app.runtime.getRunSummary(a.runId).attempts.length,
      0,
    );
    const unknown = sends.filter(
      (e) => token(e.runId!, "inputTokens") === null || token(e.runId!, "outputTokens") === null,
    ).length;
    const metrics = p.conditions.map((condition) => {
      const got = receipts.filter((r) => r.conditionId === condition.id);
      const planned = s.frozen.slots.filter((r) => r.conditionId === condition.id).length;
      const rate = (f: (r: (typeof got)[number]) => boolean) =>
        [...new Set(p.cases.map((c) => c.familyId))].reduce((n, family) => {
          const ids = p.cases.filter((c) => c.familyId === family).map((c) => c.id);
          return (
            n + got.filter((r) => ids.includes(r.caseId) && f(r)).length / (ids.length * p.repeats)
          );
        }, 0) / new Set(p.cases.map((c) => c.familyId)).size;
      return {
        ...condition,
        planned,
        completed: got.length,
        accepted: got.filter((r) => r.accepted).length,
        successRate: rate((r) => r.accepted),
        jsonValidRate: rate((r) => r.jsonValid),
        misrouteRate: rate((r) => r.misrouted),
        knownInputTokens: got.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
        knownOutputTokens: got.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
        stopReasons: Object.fromEntries(
          [...new Set(got.map((r) => r.serviceResponse?.stopReason ?? "unavailable"))].map(
            (reason) => [
              reason,
              got.filter((r) => (r.serviceResponse?.stopReason ?? "unavailable") === reason).length,
            ],
          ),
        ),
        criticalFailures: got.filter(
          (r) => !r.accepted && p.cases.find((c) => c.id === r.caseId)!.critical,
        ).length,
      };
    });
    const dispatchComplete =
      s.terminal?.type === "diagnostic.finished" && receipts.length === s.frozen.slots.length;
    const complete =
      dispatchComplete &&
      !unknown &&
      receipts.every((r) => r.meteringComplete && r.serviceEvidenceComplete);
    const eligible = complete
      ? metrics.filter(
          (c) =>
            c.jsonValidRate >= 0.95 - 1e-12 &&
            c.successRate >= 0.9 - 1e-12 &&
            c.misrouteRate <= 0.05 + 1e-12,
        )
      : [];
    eligible.sort(
      (a, b) =>
        b.successRate - a.successRate ||
        a.output - b.output ||
        a.demos - b.demos ||
        a.knownInputTokens + a.knownOutputTokens - (b.knownInputTokens + b.knownOutputTokens) ||
        p.conditions.findIndex((c) => c.id === a.id) - p.conditions.findIndex((c) => c.id === b.id),
    );
    const selected = p.stage === "matrix" ? (eligible[0] ?? null) : null;
    const confirmationPassed =
      p.stage === "confirmation" &&
      p.protocol !== "routing-output-cap-v1" &&
      complete &&
      metrics[0]!.jsonValidRate >= 0.95 - 1e-12 &&
      metrics[0]!.successRate >= 0.9 - 1e-12 &&
      metrics[0]!.criticalFailures === 0 &&
      metrics[0]!.successRate - metrics[1]!.successRate >= 0.05 - 1e-12;
    return {
      protocol: p.protocol,
      stage: p.stage,
      mode: p.mode,
      manifestDigest: s.frozen.digest,
      sourceCommit: p.sourceCommit,
      dispatchComplete: !!dispatchComplete,
      engineering: complete ? "passed" : "incomplete",
      engineeringScope: "current-stage-only",
      benefit: p.mode === "real" ? "inconclusive" : "not_evaluated",
      formalEvaluation: "not_run",
      adoption: "not_run",
      inputHardBound: "unverified",
      semanticIndependence: "unverified",
      plannedRuns: s.frozen.slots.length,
      completedRuns: receipts.length,
      reservedModelCalls: s.log.filter((e) => e.type === "diagnostic.counting").length,
      sentModelCalls: sends.length,
      countRequests: s.log.filter((e) => e.type === "diagnostic.counting").length,
      reservedInputTokens: s.log.filter((e) => e.type === "diagnostic.counting").length * 2048,
      reservedOutputTokens: s.log
        .filter((e) => e.type === "diagnostic.counting")
        .reduce((n, e) => n + (e.payload.outputReserved as number), 0),
      knownInputTokens: known("inputTokens"),
      knownOutputTokens: known("outputTokens"),
      unknownUsageCalls: unknown,
      unverifiedUsageCalls:
        receipts.filter((r) => !r.meteringComplete).length +
        s.admitted.filter((a) => !a.closed).length,
      unknownCostItems: sends.length + executionAttempts,
      totalUnknownCostItemsIncludingHistory:
        p.prior.unknownCostItems + sends.length + executionAttempts,
      fiatCost: "unknown",
      prior: p.prior,
      totalModelCallsIncludingHistory: p.prior.modelCalls + sends.length,
      totalKnownInputTokensIncludingHistory: p.prior.inputTokens + known("inputTokens"),
      totalKnownOutputTokensIncludingHistory: p.prior.outputTokens + known("outputTokens"),
      totalUnknownUsageCallsIncludingHistory: p.prior.unknownUsageCalls + unknown,
      activeUnchanged:
        this.app.kernel.getOrganism("organism-default")!.activeGenomeId ===
        s.registered.payload.active,
      stopReason: s.terminal?.type === "diagnostic.stopped" ? s.terminal.payload.reason : null,
      elapsedMs: (s.terminal?.occurredAt ?? s.log.at(-1)!.occurredAt) - s.registered.occurredAt,
      metrics,
      selected,
      confirmationPassed,
      ...(p.protocol === "routing-fixed-output-v1"
        ? {
            selectionSource: "prespecified-output-comparison",
            service5xxPolicy: "up-to-two-failed-slots-counted-unknown-no-retry",
            descriptiveQualityGate:
              !!dispatchComplete &&
              metrics[0]!.jsonValidRate >= 0.95 - 1e-12 &&
              metrics[0]!.successRate >= 0.9 - 1e-12 &&
              metrics[0]!.criticalFailures === 0 &&
              metrics[0]!.successRate - metrics[1]!.successRate >= 0.05 - 1e-12,
          }
        : {}),
      ...(p.protocol === "routing-output-cap-v1"
        ? {
            selectionSource: "prespecified-output-cap-calibration",
            service5xxPolicy: "up-to-two-failed-slots-counted-unknown-no-retry",
            historical512: "reference-only-different-time-window",
            qualityGates: metrics.map((c) => ({
              conditionId: c.id,
              passed:
                !!complete &&
                c.jsonValidRate >= 0.95 - 1e-12 &&
                c.successRate >= 0.9 - 1e-12 &&
                c.misrouteRate <= 0.05 + 1e-12 &&
                c.criticalFailures === 0,
            })),
            developmentRecommendation: complete
              ? ([...metrics]
                  .sort((a, b) => a.output - b.output)
                  .find(
                    (c) =>
                      c.jsonValidRate >= 0.95 - 1e-12 &&
                      c.successRate >= 0.9 - 1e-12 &&
                      c.misrouteRate <= 0.05 + 1e-12 &&
                      c.criticalFailures === 0,
                  )?.id ?? null)
              : null,
          }
        : {}),
      receipts,
      partialRuns: s.admitted
        .filter((a) => !a.closed)
        .map((a) => ({
          ordinal: a.ordinal,
          runId: a.runId,
          calls: this.app.storage
            .listDecisionCalls(a.runId)
            .map((c) => ({ id: c.id, state: c.state, sent: c.sent, usage: c.usage })),
        })),
    };
  }
}
