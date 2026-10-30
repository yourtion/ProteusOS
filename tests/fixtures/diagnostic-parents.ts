import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import type { DecisionRequest, DecisionResult } from "../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  prepareObservedRunner,
  openObservedRunner,
} from "../../experiments/protocols/observed-runner.ts";
import { observedDataset } from "../../experiments/protocols/observed-data.ts";
import { diagnosticDataset } from "../../experiments/protocols/diagnostic-data.ts";
import { prepareDiagnosticRunner } from "../../experiments/protocols/diagnostic-runner.ts";

class Model extends LlmDecisionProvider {
  fault: "none" | "lost" | "service" | "prefer-v2" = "none";
  constructor() {
    super({ apiKey: "SYNTHETIC_NO_NETWORK", baseUrl: "https://open.bigmodel.cn/api/anthropic" });
  }
  override countInputTokens() {
    return Promise.resolve(100);
  }
  override async decide(r: DecisionRequest): Promise<DecisionResult> {
    if (this.fault === "lost") {
      this.fault = "none";
      throw new Error("fixture lost response");
    }
    if (this.fault === "service")
      throw Object.assign(new Error("503 fixture overload"), { status: 503 });
    const c = [
      ...observedDataset(),
      ...diagnosticDataset("matrix"),
      ...diagnosticDataset("confirmation"),
    ].find((c) => c.task.goal === r.view!.goal)!;
    const raw =
      this.fault === "prefer-v2" &&
      (r.policy.content as { schemaVersion?: number }).schemaVersion === 1
        ? ""
        : canonicalJson({ kind: "value", value: c.expectedChoice });
    const evidence = {
      inputTokens: 100,
      outputTokens: 10,
      servedModel: "GLM-5.3-Flash",
      serviceResponse: {
        version: "llm-service-response-v1" as const,
        stopReason: "end_turn",
        contentBlockTypes: ["text"],
        textBytes: Buffer.byteLength(raw),
      },
    };
    const provenance = { provider: this.name, policyVersion: r.policy.versionId };
    return raw
      ? { kind: "value", value: c.expectedChoice, raw, provenance, evidence }
      : { kind: "invalid_output", detail: "fixture layout failure", raw, provenance, evidence };
  }
}
function seal(out: string, id: string, plan: unknown, report: unknown) {
  const raw = canonicalJson(report);
  writeFileSync(join(out, "run.json"), JSON.stringify({ id }));
  writeFileSync(join(out, "manifest.json"), canonicalJson(plan));
  writeFileSync(join(out, "report.json"), raw);
  writeFileSync(join(out, "summary.json"), JSON.stringify({ reportDigest: digestOf(raw) }));
}
/** Generate every parent via real Runtime calls. No historical DB, archive or network. */
export async function diagnosticParents(root: string) {
  const parent = join(root, "observed");
  mkdirSync(parent);
  const model = new Model();
  const h = prepareObservedRunner(join(parent, "instance"), "obs:fixture-v2", model, {
    mode: "fixture",
    sourceCommit: "synthetic",
    fixtureCaseIds: ["train-0-0", "train-1-0", "search-0-0", "formal-0-0", "regression-0-0"],
  });
  try {
    while (!h.experiment.report().selection) await h.experiment.runNext();
    model.fault = "lost";
    try {
      await h.experiment.runNext();
    } catch {
      /* Seal unknown before continuation. */
    }
    const child = openObservedRunner(h.app.root, "obs:fixture-v3", model);
    try {
      const continued = child.experiment.continueFrom("obs:fixture-v2", "synthetic");
      while (await child.experiment.runNext()) {}
      seal(parent, "obs:fixture-v3", continued.frozen.plan, child.experiment.report());
    } finally {
      child.app.close();
    }
  } finally {
    h.app.close();
  }
  const build = async (
    name: string,
    from: string,
    stage: Parameters<typeof prepareDiagnosticRunner>[3]["stage"],
    fault: Model["fault"],
    small = true,
  ) => {
    const out = join(root, name);
    mkdirSync(out);
    model.fault = fault;
    const runner = prepareDiagnosticRunner(join(out, "instance"), `diag:${name}`, model, {
      parent: from,
      stage,
      mode: "fixture",
      sourceCommit: "synthetic",
      small,
    });
    try {
      if (fault === "service") {
        try {
          await runner.experiment.runNext();
        } catch {
          /* Required sealed service failure. */
        }
      } else while (await runner.experiment.runNext()) {}
      const report = runner.experiment.report();
      seal(out, `diag:${name}`, runner.frozen.plan, report);
      return out;
    } finally {
      runner.app.close();
    }
  };
  const stopped = await build("stopped", parent, "matrix", "service");
  const fixedParent = await build("fixed", stopped, "fixed-output", "none", false);
  const capParent = await build("cap", fixedParent, "output-cap", "none");
  const layout = await build("layout", capParent, "layout", "prefer-v2");
  const reliabilityParent = await build("demos", layout, "demo-increment", "none");
  return { parent, fixedParent, capParent, reliabilityParent };
}
