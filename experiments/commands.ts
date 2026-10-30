import type { CommonOpts } from "../src/app/commands.ts";
import { resolve } from "node:path";
import { loadModelAdapter } from "../src/app/model-adapter.ts";
import { loadExecutorAdapter } from "../src/app/executor-adapter.ts";
import { ORGANISM_ID } from "../src/app/seed.ts";
import { openInstance, resolveInstanceRoot } from "./instance.ts";
export interface ExperimentRunOpts extends CommonOpts {
  dataset: string;
  out: string;
  llm: "fake" | "real";
  arm: string[];
  repeats: number;
  experimentId?: string;
  seed: number;
  organismCalls: number;
  experimentCalls: number;
  wallClockMinutes: number;
  capabilityModule: string;
  oracle: boolean;
  skipOracle?: boolean;
}

/**
 * 实验入口（ADR 0007 §8）：manifest 驱动执行。
 * 退出码：0 完成（收益结论可能未证明）；2 工程/预检失败；3 不完整（inconclusive）。
 */
export async function experimentRunCommand(opts: ExperimentRunOpts): Promise<void> {
  const { runExperiment } = await import("./protocols/runner.ts");
  const { v7: uuidv7 } = await import("uuid");
  const result = await runExperiment({
    home: resolveInstanceRoot(opts.home),
    modelAdapter: await loadModelAdapter(opts.modelAdapter),
    executorAdapter: await loadExecutorAdapter(opts.executorsConfig ?? opts.executorAdapter),
    organismId: opts.organism,
    actorId: opts.actor,
    datasetDir: resolve(opts.dataset),
    outDir: resolve(opts.out),
    llm: opts.llm,
    arms: (opts.arm.length > 0 ? opts.arm : ["R", "L"]) as Array<"R" | "L">,
    repeats: opts.repeats,
    experimentId: opts.experimentId ?? `exp-${uuidv7().slice(0, 8)}`,
    seed: opts.seed,
    organismCallLimit: opts.organismCalls,
    experimentCallLimit: opts.experimentCalls,
    wallClockLimitMs: opts.wallClockMinutes * 60 * 1000,
    capabilityModulePath: resolve(opts.capabilityModule),
    withOracle: opts.oracle,
    skipOracle: opts.skipOracle,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`实验 ${result.experimentId} → ${result.status}（${result.trials} trials）`);
    if (result.oraclePassed !== null) {
      console.log(`  oracle 预检：${result.oraclePassed ? "通过" : "失败"}`);
    }
    if (result.incompleteReason) console.log(`  ${result.incompleteReason}`);
    if (result.manifestPath) console.log(`  manifest   ${result.manifestPath}`);
  }
  process.exitCode =
    result.status === "complete" ? 0 : result.status === "preflight_failed" ? 2 : 3;
}

export async function experimentReportCommand(
  dir: string,
  opts: CommonOpts & { dataset?: string },
): Promise<void> {
  const { generateReport } = await import("./protocols/reporter.ts");
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    modelAdapter: await loadModelAdapter(opts.modelAdapter),
    executorAdapter: await loadExecutorAdapter(opts.executorsConfig ?? opts.executorAdapter),
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const outcome = generateReport({
      dir: resolve(dir),
      organismId: opts.organism ?? ORGANISM_ID,
      storage: inst.storage,
      blobs: inst.blobs,
      datasetDir: opts.dataset ? resolve(opts.dataset) : null,
    });
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
    } else {
      console.log(
        `engineering=${outcome.engineering} realModel=${outcome.realModel} benefit=${outcome.benefit}`,
      );
      for (const g of outcome.gates) {
        console.log(
          `  ${g.passed === null ? "?" : g.passed ? "✓" : "✗"} ${g.id}: ${g.requirement}（实际 ${g.actual}）`,
        );
      }
      for (const p of outcome.problems) console.log(`  ! ${p}`);
      console.log(`  报告 ${outcome.reportPath}`);
    }
    process.exitCode = outcome.engineering === "passed" ? 0 : 2;
  } finally {
    inst.close();
  }
}
