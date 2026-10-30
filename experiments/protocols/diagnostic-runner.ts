import { cpSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openInstance } from "../instance.ts";
import {
  createLlmDemosPolicy,
  parseLlmDemosPolicy,
  parseChoiceResponse,
  type DecisionProvider,
  type DecisionRequest,
} from "../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  ModelFreeNodeSandbox,
  ModelFreeProcessExecutor,
  modelFreeUsage,
} from "../../src/runtime/model-free.ts";
import { observedSnapshotDigest, type ObservedTransport } from "./observed.ts";
import { auditRunVerification } from "./run-verification.ts";
import { DiagnosticExperiment, type DiagnosticCondition } from "./diagnostic.ts";
import { diagnosticDataset } from "./diagnostic-data.ts";
import { reliabilityDataset } from "./reliability-data.ts";
import { RELIABILITY_BASELINE } from "./reliability-baseline.ts";

export function openDiagnosticRunner(
  root: string,
  id: string,
  transport: ObservedTransport,
  decisionTimeoutMs: 28000 | 85000 = 28000,
) {
  let experiment: DiagnosticExperiment;
  const provider: DecisionProvider = {
    name: "decision-llm",
    remote: true,
    capabilities: () => transport.capabilities(),
    prepareRequest: (r) => transport.prepareRequest?.(r),
    callProvenance: (r) => transport.callProvenance?.(r) ?? { adapter: "unavailable" },
    decide: (r) => experiment.provider(transport).decide(r),
  };
  const app = openInstance(root, {
    decisions: new Map([[provider.name, provider]]),
    decisionCallTimeoutMs: decisionTimeoutMs,
    capabilitySandbox: new ModelFreeNodeSandbox(),
    executors: new Map([
      [
        "local-process",
        new ModelFreeProcessExecutor(
          fileURLToPath(
            new URL("../../src/adapters/executor-process/stats-worker.mjs", import.meta.url),
          ),
        ),
      ],
    ]),
  });
  experiment = new DiagnosticExperiment(app, id);
  return { app, experiment };
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`diagnostic setup: ${message}`);
}

export function prepareDiagnosticRunner(
  root: string,
  id: string,
  transport: ObservedTransport,
  opts: {
    parent: string;
    stage:
      | "matrix"
      | "confirmation"
      | "fixed-output"
      | "output-cap"
      | "layout"
      | "demo-increment"
      | "reliability";
    mode: "real" | "fixture";
    sourceCommit: string;
    small?: boolean;
  },
) {
  const parentRaw = readFileSync(join(opts.parent, "report.json"), "utf8");
  const parentSummary = JSON.parse(readFileSync(join(opts.parent, "summary.json"), "utf8")) as {
    reportDigest: string;
  };
  check(digestOf(parentRaw) === parentSummary.reportDigest, "parent report digest mismatch");
  const prior = JSON.parse(parentRaw) as {
    protocol: string;
    manifestDigest?: string;
    stage?: string;
    mode: string;
    dispatchComplete: boolean;
    engineering: string;
    stopReason?: string | null;
    partialRuns?: unknown[];
    receipts?: Array<{ runId: string }>;
    metrics?: DiagnosticCondition[];
    developmentRecommendation?: string | null;
    selection?: { snapshotId: string };
    selected?: DiagnosticCondition | null;
    prior?: { experimentId: string };
    totalModelCallsIncludingSetup?: number;
    totalKnownInputTokensIncludingSetup?: number;
    totalKnownOutputTokensIncludingSetup?: number;
    unknownUsageCalls: number;
    unknownCostItems: number;
    totalUnknownCostItemsIncludingHistory?: number;
    totalModelCallsIncludingHistory?: number;
    totalKnownInputTokensIncludingHistory?: number;
    totalKnownOutputTokensIncludingHistory?: number;
    totalUnknownUsageCallsIncludingHistory?: number;
  };
  const meta = JSON.parse(readFileSync(join(opts.parent, "run.json"), "utf8")) as { id: string };
  const parentManifest = JSON.parse(readFileSync(join(opts.parent, "manifest.json"), "utf8")) as {
    serviceId: string;
    adapter: string;
    model: string;
    cases: ReturnType<typeof diagnosticDataset>;
  };
  check(
    (opts.stage === "fixed-output"
      ? !!prior.stopReason && prior.partialRuns?.length === 0
      : prior.dispatchComplete) &&
      (opts.mode === "fixture" || prior.mode === "real"),
    "closed parent of matching real mode required",
  );
  if (opts.stage === "matrix")
    check(
      prior.protocol === "adaptive-observed-v3" && !!prior.selection,
      "matrix requires completed O1",
    );
  else if (opts.stage === "fixed-output")
    check(
      prior.protocol === "routing-diagnostic-v1" &&
        prior.stage === "matrix" &&
        !prior.dispatchComplete,
      "fixed comparison requires sealed incomplete matrix",
    );
  else if (opts.stage === "output-cap")
    check(
      prior.protocol === "routing-fixed-output-v1" &&
        prior.stage === "confirmation" &&
        prior.dispatchComplete &&
        prior.engineering === "passed",
      "output cap calibration requires complete metered fixed-output parent",
    );
  else if (opts.stage === "layout" || opts.stage === "demo-increment")
    check(
      prior.protocol ===
        (opts.stage === "layout" ? "routing-output-cap-v1" : "routing-layout-v1") &&
        prior.engineering === "passed" &&
        prior.dispatchComplete &&
        (opts.stage === "layout"
          ? prior.developmentRecommendation === "v1-t1024-d0"
          : ["v1-t1024-d0", "v2-t1024-d0"].includes(prior.developmentRecommendation ?? "")),
      "factor comparison requires qualified sealed parent",
    );
  else if (opts.stage === "reliability")
    check(
      prior.protocol === "routing-demo-increment-v1" &&
        prior.engineering === "passed" &&
        prior.dispatchComplete &&
        prior.developmentRecommendation === RELIABILITY_BASELINE.conditionId,
      "reliability requires qualified sealed baseline parent",
    );
  else
    check(
      prior.protocol === "routing-diagnostic-v1" &&
        prior.stage === "matrix" &&
        prior.engineering === "passed" &&
        !!prior.selected,
      "confirmation requires qualified closed matrix",
    );
  const wal = join(opts.parent, "instance", "metadata.sqlite-wal");
  check(!existsSync(wal) || statSync(wal).size === 0, "parent must be closed and checkpointed");
  mkdirSync(root);
  cpSync(join(opts.parent, "instance", "metadata.sqlite"), join(root, "metadata.sqlite"));
  cpSync(join(opts.parent, "instance", "blobs"), join(root, "blobs"), { recursive: true });
  const capComparison = opts.stage === "output-cap";
  const factorComparison = opts.stage === "layout" || opts.stage === "demo-increment";
  const reliability = opts.stage === "reliability";
  const extended = capComparison || factorComparison || reliability;
  if (extended)
    check(
      digestOf(canonicalJson(parentManifest)) === prior.manifestDigest,
      "parent manifest drift",
    );
  const h = openDiagnosticRunner(root, id, transport, extended ? 85000 : 28000);
  try {
    const { app, experiment } = h;
    if (opts.stage === "fixed-output" || extended) {
      check(
        same(new DiagnosticExperiment(app, meta.id).report(), prior),
        "sealed parent report replay drift",
      );
    }
    if (opts.stage === "fixed-output") {
      const last = prior.receipts?.at(-1);
      const call = last && app.storage.listDecisionCalls(last.runId)[0];
      check(
        call?.state === "transport_error" && !!call.responseRef,
        "fixed comparison requires terminal service error",
      );
      const error = JSON.parse(app.blobs.read(call.responseRef)) as { message?: string };
      check(
        /^(500|502|503|504)\b/.test(error.message ?? ""),
        "parent failure is not a service 5xx",
      );
    }
    const parentSnapshot =
      opts.stage === "fixed-output" || extended
        ? prior.metrics!.find(
            (c) =>
              c.id ===
              (factorComparison || reliability ? prior.developmentRecommendation : "v1-t512-d0"),
          )!.snapshotId
        : (prior.selection?.snapshotId ?? prior.selected!.snapshotId);
    if (reliability)
      check(
        (opts.mode === "fixture" ||
          observedSnapshotDigest(app, parentSnapshot) === RELIABILITY_BASELINE.snapshotDigest) &&
          parentManifest.model === RELIABILITY_BASELINE.model &&
          parentManifest.serviceId === RELIABILITY_BASELINE.endpoint,
        "frozen candidate baseline drift",
      );
    const base = app.kernel.resolveSnapshot(parentSnapshot);
    const routing = base.versions.get("routing-policy")!;
    const old = parseLlmDemosPolicy(JSON.parse(app.blobs.read(routing.contentRef)));
    check(old.pool.demonstrations.length === 2, "exact frozen two-demo pool required");
    for (const demo of old.pool.demonstrations) {
      const call = app.storage.getDecisionCall(demo.source.decisionId)!;
      check(
        call && call.runId === demo.source.runId && call.state === "value",
        "source call binding invalid",
      );
      const rawRequest = app.blobs.read(call.requestRef!);
      const rawResponse = app.blobs.read(call.responseRef!);
      check(
        digestOf(rawRequest) === call.requestDigest &&
          digestOf(rawResponse) === call.responseDigest,
        "source raw digest drift",
      );
      check(same(JSON.parse(rawRequest).view, demo.view), "source view drift");
      const response = parseChoiceResponse(rawResponse, old.fixed.options);
      check(
        response.kind === "value" &&
          demo.response.kind === "value" &&
          response.value === demo.response.value,
        "source response drift",
      );
      check(
        auditRunVerification(
          { ...app, organismId: "organism-default", actorId: "principal-local" },
          call.runId,
        ).verifiedAcceptance,
        "source JSON verification failed",
      );
      check(
        app.runtime
          .getRunSummary(call.runId)
          .attempts.every((a) => modelFreeUsage(a.evidence, app.blobs)?.modelCalls === 0),
        "source worker model use unbounded",
      );
    }
    const conditions: DiagnosticCondition[] = [];
    for (const output of reliability
      ? ([] as const)
      : factorComparison
        ? ([1024] as const)
        : capComparison
          ? ([1024, 2048] as const)
          : ([256, 512] as const)) {
      const original = app.storage.getArtifactVersion(old.fixed.basePolicy.versionId)!;
      const content = {
        ...old.fixed.basePolicy.content,
        sampling: { ...old.fixed.basePolicy.content.sampling, maxOutputTokens: output },
      };
      const raw = app.blobs.write(canonicalJson(content));
      const baseVersion = app.kernel.registerVersion({
        artifact: app.storage.getArtifact(original.artifactId)!,
        schemaVersion: 1,
        contentDigest: raw.digest,
        contentRef: raw.ref,
        parents: [original.id],
        dependencies: [],
        scope: "organism:organism-default",
        createdBy: "principal-local",
      });
      for (const layout of reliability
        ? ([2] as const)
        : capComparison
          ? ([1] as const)
          : factorComparison && opts.stage === "demo-increment"
            ? ([prior.developmentRecommendation!.startsWith("v2") ? 2 : 1] as const)
            : ([1, 2] as const))
        for (const demos of reliability || capComparison || opts.stage === "layout"
          ? ([0] as const)
          : ([0, 2] as const)) {
          const policy = createLlmDemosPolicy({
            basePolicy: { versionId: baseVersion.id, contentDigest: raw.digest, content },
            decisionView: old.fixed.decisionView,
            options: old.fixed.options,
            demonstrations: old.pool.demonstrations,
            demoIds: demos ? old.pool.demonstrations.map((d) => d.id) : [],
            ...(layout === 2 ? { requestFormat: "current-user-v2" as const } : {}),
          });
          const blob = app.blobs.write(canonicalJson(policy));
          const version = app.kernel.registerVersion({
            artifact: app.storage.getArtifact(routing.artifactId)!,
            schemaVersion: policy.schemaVersion,
            contentDigest: blob.digest,
            contentRef: blob.ref,
            parents: [routing.id],
            dependencies: [baseVersion.id, old.fixed.decisionView.versionId],
            scope: "organism:organism-default",
            createdBy: "principal-local",
          });
          const snapshot = app.kernel.createSnapshot(
            { ...base.snapshot.bindings, "routing-policy": version.id },
            "principal-local",
          );
          conditions.push({
            id: `v${layout}-t${output}-d${demos}`,
            layout,
            output,
            demos,
            snapshotId: snapshot.id,
            snapshotDigest: observedSnapshotDigest(app, snapshot.id),
          });
        }
    }
    const candidate = reliability
      ? prior.metrics!.find((c) => c.id === RELIABILITY_BASELINE.conditionId)!
      : null;
    let selectedConditions = candidate
      ? [
          {
            id: candidate.id,
            layout: candidate.layout,
            output: candidate.output,
            demos: candidate.demos,
            snapshotId: candidate.snapshotId,
            snapshotDigest: candidate.snapshotDigest,
          },
        ]
      : conditions;
    if (opts.stage === "fixed-output") {
      selectedConditions = [
        conditions.find((c) => c.id === "v1-t512-d0")!,
        conditions.find((c) => c.id === "v1-t256-d0")!,
      ];
    } else if (opts.stage === "confirmation") {
      const chosen = prior.selected!;
      const controlId = chosen.demos
        ? `v${chosen.layout}-t${chosen.output}-d0`
        : chosen.layout === 2
          ? `v1-t${chosen.output}-d0`
          : chosen.output === 512
            ? "v1-t256-d0"
            : null;
      check(
        controlId && controlId !== chosen.id,
        "unchanged baseline won; no distinct improvement to confirm",
      );
      selectedConditions = [
        conditions.find((c) => c.id === chosen.id)!,
        conditions.find((c) => c.id === controlId)!,
      ];
    }
    const first = app.kernel
      .resolveSnapshot(selectedConditions[0]!.snapshotId)
      .versions.get("routing-policy")!;
    const request: DecisionRequest = {
      problem: "choice",
      options: old.fixed.options,
      context: {},
      policy: { versionId: first.id, content: JSON.parse(app.blobs.read(first.contentRef)) },
      view: old.pool.demonstrations[0]!.view,
      viewSource: {
        versionId: old.fixed.decisionView.versionId,
        contentDigest: old.fixed.decisionView.contentDigest,
      },
      deadlineMs: extended ? 85000 : 28000,
      remainingAttempts: 1,
    };
    const prov = transport.callProvenance!(request);
    check(
      prov.serviceId === parentManifest.serviceId &&
        prov.adapter === parentManifest.adapter &&
        old.fixed.basePolicy.content.model === parentManifest.model,
      "parent service/model changed",
    );
    const stage =
      opts.stage === "fixed-output" || extended
        ? "confirmation"
        : (opts.stage as "matrix" | "confirmation");
    // Reuse the parent's frozen tasks and judges; do not regenerate a post-observation cohort.
    const data = reliability
      ? reliabilityDataset()
      : extended
        ? parentManifest.cases
        : diagnosticDataset(stage);
    if (extended) check(Array.isArray(data) && data.length >= 2, "parent cases missing");
    const frozen = experiment.register({
      protocol: reliability
        ? "routing-reliability-v1"
        : factorComparison
          ? opts.stage === "layout"
            ? "routing-layout-v1"
            : "routing-demo-increment-v1"
          : capComparison
            ? "routing-output-cap-v1"
            : opts.stage === "fixed-output"
              ? "routing-fixed-output-v1"
              : "routing-diagnostic-v1",
      ...(opts.stage === "fixed-output" || extended ? { maxService5xx: 2 } : {}),
      stage,
      ...(reliability && opts.mode === "fixture"
        ? { fixtureBaselineDigest: observedSnapshotDigest(app, parentSnapshot) }
        : {}),
      mode: opts.mode,
      sourceCommit: opts.sourceCommit,
      seed: 20261028,
      serviceId: prov.serviceId,
      adapter: prov.adapter,
      model: old.fixed.basePolicy.content.model,
      repeats: opts.small ? 1 : stage === "matrix" ? 2 : 3,
      cases: opts.small
        ? [data[0]!, data[stage === "confirmation" && data.length > 2 ? 2 : 1]!]
        : data,
      conditions: selectedConditions,
      prior: {
        experimentId: meta.id,
        report: app.blobs.write(parentRaw),
        modelCalls: prior.totalModelCallsIncludingHistory ?? prior.totalModelCallsIncludingSetup!,
        inputTokens:
          prior.totalKnownInputTokensIncludingHistory ?? prior.totalKnownInputTokensIncludingSetup!,
        outputTokens:
          prior.totalKnownOutputTokensIncludingHistory ??
          prior.totalKnownOutputTokensIncludingSetup!,
        unknownUsageCalls: prior.totalUnknownUsageCallsIncludingHistory ?? prior.unknownUsageCalls,
        unknownCostItems: prior.totalUnknownCostItemsIncludingHistory ?? prior.unknownCostItems,
        instanceModelReservations: app.storage.countDecisionQuotaCalls({
          organismId: "organism-default",
        }),
      },
      inputPerCall: 2048,
      runMs: extended ? 90000 : 30000,
      decisionMs: extended ? 85000 : 28000,
      visibility: "developer-visible",
      semanticIndependence: "unverified",
    });
    return { ...h, frozen };
  } catch (error) {
    h.app.close();
    throw error;
  }
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
