import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import { experimentServiceConfig } from "../protocols/service-config.ts";
import { prepareObservedRunner, openObservedRunner } from "../protocols/observed-runner.ts";
import { ObservedExperiment } from "../protocols/observed.ts";
import { observedDataset } from "../protocols/observed-data.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { openInstance } from "../instance.ts";
import type { DecisionRequest, DecisionResult } from "../../src/decision/index.ts";

const args = process.argv.slice(2);
if (args[0] === "--report" && args.length === 2) {
  const out = resolve(args[1]!);
  const meta = JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as { id: string };
  const app = openInstance(join(out, "instance"));
  try {
    process.stdout.write(
      `${JSON.stringify(new ObservedExperiment(app, meta.id).report(), null, 2)}\n`,
    );
  } finally {
    app.close();
  }
} else {
  if (
    !["--fixture", "--real"].includes(args[0] ?? "") ||
    args[1] !== "--output" ||
    args.length < 3 ||
    args.length % 2 !== 1
  )
    throw new Error(
      "Usage: run-observed.ts (--fixture|--real) --output NEW_DIRECTORY [--claude-settings FILE] [--carry-stopped-round DIRECTORY | --continue-frozen-round DIRECTORY] | --report DIRECTORY",
    );
  const mode = args[0] === "--real" ? "real" : "fixture";
  const extra = new Map<string, string>();
  for (let i = 3; i < args.length; i += 2) {
    const key = args[i]!;
    if (
      ![
        "--claude-settings",
        "--carry-stopped-round",
        "--continue-frozen-round",
        "--setup-service-report",
        "--setup-runtime-report",
      ].includes(key) ||
      extra.has(key)
    )
      throw new Error("unknown/duplicate option");
    extra.set(key, args[i + 1]!);
  }
  const output = resolve(args[2]!);
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTreeDirty = !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (mode === "real" && sourceTreeDirty)
    throw new Error("Commit source changes before starting a real observed round");
  mkdirSync(output);
  class Fixture extends LlmDecisionProvider {
    readonly goals = new Map(observedDataset().map((c) => [c.task.goal, c.expectedChoice]));
    constructor() {
      super({ apiKey: "FIXTURE_NO_NETWORK", baseUrl: "https://observed.invalid" });
    }
    override countInputTokens() {
      return Promise.resolve(100);
    }
    override async decide(r: DecisionRequest): Promise<DecisionResult> {
      const value = this.goals.get(r.view!.goal)!;
      return {
        kind: "value",
        value,
        raw: canonicalJson({ kind: "value", value }),
        provenance: { provider: this.name, policyVersion: r.policy.versionId },
        evidence: { inputTokens: 100, outputTokens: 5, servedModel: "GLM-5.3-Flash" },
      };
    }
  }
  const transport =
    mode === "real"
      ? new LlmDecisionProvider({
          ...experimentServiceConfig(extra.get("--claude-settings")).config,
          requestTimeoutMs: 28_000,
        })
      : new Fixture();
  const id = `obs:${randomUUID()}`;
  const previous = extra.get("--continue-frozen-round");
  if (previous && extra.has("--carry-stopped-round"))
    throw new Error("continuation cannot reset development or add duplicate setup");
  const h = previous
    ? (() => {
        const meta = JSON.parse(readFileSync(join(previous, "run.json"), "utf8")) as {
          id: string;
          mode: string;
        };
        const summary = JSON.parse(readFileSync(join(previous, "summary.json"), "utf8")) as {
          reportDigest: string;
        };
        if (meta.mode !== mode) throw new Error("continuation transport mode must match parent");
        cpSync(join(previous, "instance"), join(output, "instance"), {
          recursive: true,
          errorOnExist: true,
        });
        const runner = openObservedRunner(join(output, "instance"), id, transport);
        try {
          const continued = runner.experiment.continueFrom(
            meta.id,
            sourceCommit,
            summary.reportDigest,
          );
          return { ...runner, ...continued };
        } catch (error) {
          runner.app.close();
          throw error;
        }
      })()
    : prepareObservedRunner(join(output, "instance"), id, transport, {
        mode,
        sourceCommit,
        stoppedRound: extra.get("--carry-stopped-round"),
        setupReports: [
          extra.get("--setup-service-report"),
          extra.get("--setup-runtime-report"),
        ].filter((x): x is string => !!x),
      });
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      {
        id,
        mode,
        sourceCommit,
        sourceTreeDirty,
        registeredAt: new Date().toISOString(),
        inputHardBound: "unverified",
        semanticIndependence: "unverified",
        independentBenefit: "inconclusive",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(output, "manifest.json"), canonicalJson(h.frozen.plan));
  process.stdout.write(
    `Frozen ${h.frozen.digest}: ${h.frozen.slots.length} Runs / ${h.frozen.plannedCalls} planned model calls, mode=${mode}\n`,
  );
  let failure: string | null = null;
  try {
    for (;;) {
      const receipt = await h.experiment.runNext();
      if (!receipt) break;
      const count = receipt.ordinal + 1;
      if (count % 10 === 0 || count === h.frozen.slots.length)
        process.stdout.write(`${count}/${h.frozen.slots.length} ${receipt.phase}\n`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : "UnknownError";
    h.experiment.stop(failure);
  }
  try {
    const report = h.experiment.report();
    writeFileSync(join(output, "report.json"), canonicalJson(report));
    rmSync(join(h.app.root, "workspaces"), { recursive: true, force: true });
    rmSync(join(h.app.root, "observed-materials"), { recursive: true, force: true });
    const reopened = openInstance(h.app.root);
    try {
      assert.deepEqual(new ObservedExperiment(reopened, id).report(), report);
    } finally {
      reopened.close();
    }
    const summary = {
      protocol: report.protocol,
      sourceCommit,
      sourceTreeDirty,
      mode,
      id,
      manifestDigest: h.frozen.digest,
      reportDigest: digestOf(canonicalJson(report)),
      engineering: report.engineering,
      ...(report.dispatchComplete !== undefined
        ? { dispatchComplete: report.dispatchComplete, continuation: report.continuation }
        : {}),
      realModel: report.realModel,
      benefit: report.benefit,
      selection: report.selection,
      qualityGate: report.qualityGate,
      arms: report.arms,
      armResources: report.armResources,
      completedRuns: report.completedRuns,
      plannedRuns: report.plannedRuns,
      sentModelCalls: report.sentModelCalls,
      setup: report.setup,
      totalModelCallsIncludingSetup: report.totalModelCallsIncludingSetup,
      totalKnownInputTokensIncludingSetup: report.totalKnownInputTokensIncludingSetup,
      totalKnownOutputTokensIncludingSetup: report.totalKnownOutputTokensIncludingSetup,
      reservedModelCalls: report.reservedModelCalls,
      countRequests: report.countRequests,
      knownInputTokens: report.knownInputTokens,
      knownOutputTokens: report.knownOutputTokens,
      unknownUsageCalls: report.unknownUsageCalls,
      unverifiedUsageCalls: report.unverifiedUsageCalls,
      unknownCostItems: report.unknownCostItems,
      criticalFailures: report.criticalFailures.length,
      ...(report.criticalMissing ? { criticalMissing: report.criticalMissing.length } : {}),
      elapsedMs: report.elapsedMs,
      cleanReopenReplay: "passed",
      activeUnchanged: report.activeUnchanged,
      formalEvaluation: report.formalEvaluation,
      adoption: report.adoption,
      originalProtocolEligible: false,
      failure,
    };
    writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\nEvidence saved to ${output}\n`);
    process.exitCode =
      report.engineering === "passed" || (report.dispatchComplete && failure === null) ? 0 : 1;
  } finally {
    h.app.close();
  }
}
