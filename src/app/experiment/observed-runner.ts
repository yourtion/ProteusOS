import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openInstance } from "../instance.ts";
import { installSeed } from "../seed.ts";
import { ensureExperimentGenomes, makeExperimentGraphContent } from "./assets.ts";
import { ModelFreeNodeSandbox, ModelFreeProcessExecutor } from "../../runtime/model-free.ts";
import { parseCapabilityModule } from "../../runtime/capability.ts";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import type { DecisionProvider, DecisionRequest } from "../../decision/index.ts";
import { ObservedExperiment, observedSnapshotDigest, type ObservedTransport } from "./observed.ts";
import { observedDataset } from "./observed-data.ts";
import { OBSERVED_PROTOCOL } from "./observed-plan.ts";

export function openObservedRunner(root: string, id: string, transport: ObservedTransport) {
  let experiment: ObservedExperiment;
  const model: DecisionProvider = {
    name: "decision-llm",
    remote: true,
    capabilities: () => transport.capabilities(),
    prepareRequest: (r) => transport.prepareRequest?.(r),
    callProvenance: (r) => transport.callProvenance?.(r) ?? { adapter: "unavailable" },
    decide: (r) => experiment.provider(transport).decide(r),
  };
  const teacher: DecisionProvider = {
    name: "decision-observed-source",
    capabilities: () => ({ problems: ["choice"] }),
    decide: (r) => experiment.teacher(r),
    callProvenance: () => ({
      adapter: "observed-deterministic-teacher-v1",
      reproducibility: "pinned",
    }),
  };
  const app = openInstance(root, {
    decisions: new Map([
      [model.name, model],
      [teacher.name, teacher],
    ]),
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
    capabilitySandbox: new ModelFreeNodeSandbox(),
    decisionCallTimeoutMs: 28_000,
  });
  experiment = new ObservedExperiment(app, id);
  return { app, experiment };
}

export function prepareObservedRunner(
  root: string,
  id: string,
  transport: ObservedTransport,
  opts: { mode: "fixture" | "real"; sourceCommit: string; small?: boolean },
) {
  const h = openObservedRunner(root, id, transport);
  try {
    const { app, experiment } = h;
    installSeed({ ...app, clock: { now: Date.now } });
    const parsed = parseCapabilityModule(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../../tests/fixtures/decision/capability/changed-file-summary.module.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      ),
    );
    if (!parsed.ok) throw new Error("invalid repository capability");
    const genomes = ensureExperimentGenomes(
      { ...app, clock: { now: Date.now } },
      { createdBy: "principal-local", capabilityModule: parsed.module },
    );
    const base = app.kernel.resolveSnapshot(genomes.llm.snapshot.id);
    const original = base.versions.get("task-graph")!;
    const blob = app.blobs.write(
      canonicalJson(makeExperimentGraphContent("decision-observed-source")),
    );
    const graph = app.kernel.registerVersion({
      artifact: app.storage.getArtifact(original.artifactId)!,
      schemaVersion: 2,
      contentDigest: blob.digest,
      contentRef: blob.ref,
      parents: [original.id],
      dependencies: [],
      scope: "organism:organism-default",
      createdBy: "principal-local",
    });
    const source = app.kernel.createSnapshot(
      { ...base.snapshot.bindings, "task-graph": graph.id },
      "principal-local",
    );
    const data = observedDataset();
    const cases = opts.small
      ? data.filter((c) =>
          ["train-0-0", "search-0-0", "formal-0-0", "regression-0-0"].includes(c.id),
        )
      : data;
    const p = JSON.parse(app.blobs.read(base.versions.get("routing-policy")!.contentRef));
    const req: DecisionRequest = {
      problem: "choice",
      options: ["local-process", "capability/changed-file-summary"],
      context: {},
      view: {
        viewVersion: "decision-view-v1",
        goal: "compatibility metadata",
        options: [],
        inputs: [],
        features: {},
      },
      policy: { versionId: base.versions.get("routing-policy")!.id, content: p },
      deadlineMs: 15000,
      remainingAttempts: 1,
    };
    const prov = transport.callProvenance!(req);
    const setup = {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      unknownCostItems: 0,
      evidence: [] as Array<{ ref: string; digest: string }>,
    };
    if (opts.mode === "real")
      for (const name of ["adaptive-service-v1", "adaptive-runtime-v1"]) {
        const raw = readFileSync(
          fileURLToPath(
            new URL(`../../../docs/experiments/results/${name}/report.json`, import.meta.url),
          ),
          "utf8",
        );
        const prior = JSON.parse(raw) as {
          serviceId: string;
          actualUsage: { inputTokens: number; outputTokens: number };
        };
        if (prior.serviceId !== prov.serviceId)
          throw new Error("setup evidence service differs from frozen endpoint");
        setup.modelCalls++;
        setup.inputTokens += prior.actualUsage.inputTokens;
        setup.outputTokens += prior.actualUsage.outputTokens;
        setup.evidence.push(app.blobs.write(raw));
      }
    if (opts.mode === "real") setup.unknownCostItems = 5;
    const f = experiment.register({
      protocol: OBSERVED_PROTOCOL,
      mode: opts.mode,
      visibility: "developer-visible",
      semanticIndependence: "unverified",
      sourceCommit: opts.sourceCommit,
      seed: 20261028,
      repeats: 3,
      serviceId: prov.serviceId,
      model: p.model,
      adapter: prov.adapter,
      environmentDigest: digestOf(
        canonicalJson({
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          worker: digestOf(
            readFileSync(
              fileURLToPath(
                new URL("../../adapters/executor-process/stats-worker.mjs", import.meta.url),
              ),
              "utf8",
            ),
          ),
          capability: genomes.capabilityVersionId,
        }),
      ),
      setup,
      snapshots: { base: base.snapshot.id, source: source.id },
      snapshotDigests: {
        base: observedSnapshotDigest(app, base.snapshot.id),
        source: observedSnapshotDigest(app, source.id),
      },
      demoCaseIds: opts.small ? ["train-0-0"] : ["train-0-0", "train-1-0"],
      selection: "qualified-search-else-prespecified-demo-ablation",
      cases,
      limits: {
        calls: 800,
        inputPerCall: 2048,
        outputPerCall: 256,
        wallClockMs: 3600000,
        runMs: 30000,
        decisionMs: 28000,
      },
    });
    app.storage.setDecisionCallLimit({ organismId: "organism-default" }, 800, Date.now());
    return { ...h, frozen: f };
  } catch (error) {
    h.app.close();
    throw error;
  }
}
