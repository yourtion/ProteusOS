import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { openInstance } from "../../src/app/instance.ts";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import { experimentServiceConfig } from "../../src/app/experiment/service-config.ts";
import { prepareDiagnosticRunner } from "../../src/app/experiment/diagnostic-runner.ts";
import { DiagnosticExperiment } from "../../src/app/experiment/diagnostic.ts";
import { diagnosticDataset } from "../../src/app/experiment/diagnostic-data.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import type { DecisionRequest, DecisionResult } from "../../src/decision/index.ts";

const args = process.argv.slice(2);
if (args[0] === "--report" && args.length === 2) {
  const root = resolve(args[1]!);
  const meta = JSON.parse(readFileSync(join(root, "run.json"), "utf8")) as { id: string };
  const app = openInstance(join(root, "instance"));
  try {
    process.stdout.write(
      `${JSON.stringify(new DiagnosticExperiment(app, meta.id).report(), null, 2)}\n`,
    );
  } finally {
    app.close();
  }
} else {
  if (!["--fixture", "--real"].includes(args[0] ?? ""))
    throw new Error(
      "Use --real|--fixture --output NEW_DIR --parent SEALED_DIR --stage matrix|confirmation|fixed-output|output-cap [--claude-settings FILE]",
    );
  const extra = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!;
    if (
      !["--output", "--parent", "--stage", "--claude-settings"].includes(k) ||
      extra.has(k) ||
      !args[i + 1]
    )
      throw new Error("unknown/duplicate/missing argument");
    extra.set(k, args[i + 1]!);
  }
  const output = resolve(extra.get("--output")!);
  const parent = resolve(extra.get("--parent")!);
  const stage = extra.get("--stage");
  if (
    stage !== "matrix" &&
    stage !== "confirmation" &&
    stage !== "fixed-output" &&
    stage !== "output-cap"
  )
    throw new Error("invalid stage");
  const mode = args[0] === "--real" ? "real" : "fixture";
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTreeDirty = !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (mode === "real" && sourceTreeDirty)
    throw new Error("Commit implementation before real generation");
  const fixtureDataset = diagnosticDataset(
    stage === "fixed-output" || stage === "output-cap" ? "confirmation" : stage,
  );
  class Fixture extends LlmDecisionProvider {
    readonly labels = new Map(fixtureDataset.map((c) => [c.task.goal, c.expectedChoice]));
    constructor() {
      super({ apiKey: "FIXTURE_NO_NETWORK", baseUrl: "https://open.bigmodel.cn/api/anthropic" });
    }
    override countInputTokens() {
      return Promise.resolve(100);
    }
    override async decide(r: DecisionRequest): Promise<DecisionResult> {
      const value = this.labels.get(r.view!.goal)!;
      const raw = canonicalJson({ kind: "value", value });
      return {
        kind: "value",
        value,
        raw,
        provenance: { provider: this.name, policyVersion: r.policy.versionId },
        evidence: {
          inputTokens: 100,
          outputTokens: 10,
          servedModel: "GLM-5.3-Flash",
          serviceResponse: {
            version: "llm-service-response-v1",
            stopReason: "end_turn",
            contentBlockTypes: ["text"],
            textBytes: Buffer.byteLength(raw),
          },
        },
      };
    }
  }
  const transport =
    mode === "real"
      ? new LlmDecisionProvider({
          ...experimentServiceConfig(extra.get("--claude-settings")).config,
          requestTimeoutMs: stage === "output-cap" ? 85000 : 28000,
        })
      : new Fixture();
  mkdirSync(output);
  const id = `diag:${randomUUID()}`;
  const h = prepareDiagnosticRunner(join(output, "instance"), id, transport, {
    parent,
    stage,
    mode,
    sourceCommit,
  });
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      { id, stage, mode, sourceCommit, sourceTreeDirty, registeredAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  writeFileSync(join(output, "manifest.json"), canonicalJson(h.frozen.plan));
  process.stdout.write(
    `Frozen ${h.frozen.digest}: ${h.frozen.slots.length} generation slots, stage=${stage}, mode=${mode}\n`,
  );
  let failure: string | null = null;
  try {
    for (;;) {
      const receipt = await h.experiment.runNext();
      if (!receipt) break;
      if ((receipt.ordinal + 1) % 8 === 0)
        process.stdout.write(`${receipt.ordinal + 1}/${h.frozen.slots.length}\n`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : "UnknownError";
    h.experiment.stop(failure);
  }
  try {
    const report = h.experiment.report();
    writeFileSync(join(output, "report.json"), canonicalJson(report));
    rmSync(join(output, "instance", "workspaces"), { recursive: true, force: true });
    rmSync(join(output, "instance", "diagnostic-materials"), { recursive: true, force: true });
    const reopened = openInstance(join(output, "instance"));
    try {
      assert.deepEqual(new DiagnosticExperiment(reopened, id).report(), report);
    } finally {
      reopened.close();
    }
    const { receipts: _receipts, partialRuns: _partialRuns, ...summary } = report;
    const saved = {
      ...summary,
      id,
      sourceTreeDirty,
      reportDigest: digestOf(canonicalJson(report)),
      cleanReopenReplay: "passed",
      failure,
    };
    writeFileSync(join(output, "summary.json"), JSON.stringify(saved, null, 2) + "\n");
    process.stdout.write(JSON.stringify(saved, null, 2) + `\nEvidence: ${output}\n`);
    process.exitCode = report.engineering === "passed" ? 0 : 1;
  } finally {
    h.app.close();
  }
}
