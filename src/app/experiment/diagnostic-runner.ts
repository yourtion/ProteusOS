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
} from "../../decision/index.ts";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import {
  ModelFreeNodeSandbox,
  ModelFreeProcessExecutor,
  modelFreeUsage,
} from "../../runtime/model-free.ts";
import { observedSnapshotDigest, type ObservedTransport } from "./observed.ts";
import { auditRunVerification } from "./run-verification.ts";
import { DiagnosticExperiment, type DiagnosticCondition } from "./diagnostic.ts";
import { diagnosticDataset } from "./diagnostic-data.ts";

export function openDiagnosticRunner(root: string, id: string, transport: ObservedTransport) {
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
    decisionCallTimeoutMs: 28000,
    capabilitySandbox: new ModelFreeNodeSandbox(),
    executors: new Map([
      [
        "local-process",
        new ModelFreeProcessExecutor(
          fileURLToPath(
            new URL("../../adapters/executor-process/stats-worker.mjs", import.meta.url),
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
    stage: "matrix" | "confirmation";
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
    stage?: string;
    mode: string;
    dispatchComplete: boolean;
    engineering: string;
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
  };
  check(
    prior.dispatchComplete && (opts.mode === "fixture" || prior.mode === "real"),
    "closed parent of matching real mode required",
  );
  if (opts.stage === "matrix")
    check(
      prior.protocol === "adaptive-observed-v3" && !!prior.selection,
      "matrix requires completed O1",
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
  const h = openDiagnosticRunner(root, id, transport);
  try {
    const { app, experiment } = h;
    const parentSnapshot = prior.selection?.snapshotId ?? prior.selected!.snapshotId;
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
    for (const output of [256, 512] as const) {
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
      for (const layout of [1, 2] as const)
        for (const demos of [0, 2] as const) {
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
    let selectedConditions = conditions;
    if (opts.stage === "confirmation") {
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
      deadlineMs: 28000,
      remainingAttempts: 1,
    };
    const prov = transport.callProvenance!(request);
    check(
      prov.serviceId === parentManifest.serviceId &&
        prov.adapter === parentManifest.adapter &&
        old.fixed.basePolicy.content.model === parentManifest.model,
      "parent service/model changed",
    );
    const data = diagnosticDataset(opts.stage);
    const frozen = experiment.register({
      protocol: "routing-diagnostic-v1",
      stage: opts.stage,
      mode: opts.mode,
      sourceCommit: opts.sourceCommit,
      seed: 20261028,
      serviceId: prov.serviceId,
      adapter: prov.adapter,
      model: old.fixed.basePolicy.content.model,
      repeats: opts.small ? 1 : opts.stage === "matrix" ? 2 : 3,
      cases: opts.small ? [data[0]!, data[opts.stage === "confirmation" ? 2 : 1]!] : data,
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
      runMs: 30000,
      decisionMs: 28000,
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
