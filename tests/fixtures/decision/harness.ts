import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppInstance } from "../../../src/app/instance.ts";
import { openInstance } from "../../../src/app/instance.ts";
import { installSeed } from "../../../src/app/seed.ts";
import type { ExperimentGenomes } from "../../../src/app/experiment/assets.ts";
import { ensureExperimentGenomes } from "../../../src/app/experiment/assets.ts";
import { OracleDecisionProvider } from "../../../src/app/experiment/oracle.ts";
import { parseCapabilityModule } from "../../../src/runtime/capability.ts";
import type { DecisionProvider } from "../../../src/decision/index.ts";
import { FakeLlmDecisionProvider } from "./fake-llm.ts";
import { tempInstanceRoot } from "../../helpers.ts";

export const DECISION_FIXTURES = fileURLToPath(new URL(".", import.meta.url));
export const DEV_DATASET = join(DECISION_FIXTURES, "dev");
export const CAPABILITY_MODULE = join(
  DECISION_FIXTURES,
  "capability",
  "changed-file-summary.module.json",
);

export interface ExperimentHarness {
  inst: AppInstance;
  genomes: ExperimentGenomes;
  fake: FakeLlmDecisionProvider;
  oracle: OracleDecisionProvider;
  root: string;
}

/** 临时实例 + seed + 实验快照（R/L/oracle）+ fake LLM 与 oracle Provider */
export function bootExperimentHarness(root = tempInstanceRoot()): ExperimentHarness {
  const fake = new FakeLlmDecisionProvider();
  const oracle = new OracleDecisionProvider();
  const inst = openInstance(root, {
    decisions: new Map<string, DecisionProvider>([
      ["decision-llm", fake],
      ["decision-oracle", oracle],
    ]),
    // 测试用短超时：永不 resolve 的 fake 也能在 250ms 结束本地等待（D05）
    decisionCallTimeoutMs: 250,
  });
  installSeed({
    kernel: inst.kernel,
    storage: inst.storage,
    blobs: inst.blobs,
    clock: { now: Date.now },
  });
  const parsedModule = parseCapabilityModule(
    JSON.parse(readFileSync(CAPABILITY_MODULE, "utf8")) as unknown,
  );
  if (!parsedModule.ok) throw new Error(`capability 模块 fixture 不合法：${parsedModule.error}`);
  const genomes = ensureExperimentGenomes(
    { kernel: inst.kernel, storage: inst.storage, blobs: inst.blobs, clock: { now: Date.now } },
    {
      createdBy: "principal-local",
      capabilityModule: parsedModule.module,
      withOracle: true,
    },
  );
  return { inst, genomes, fake, oracle, root };
}

/** 提交一个实验任务（默认绑 L 组快照；goal/inputs 可覆盖以构造特定场景） */
export function experimentSubmission(input: {
  goal: string;
  inputs: string[];
  genomes: ExperimentGenomes;
  arm?: "R" | "L" | "oracle";
  schema: string;
  expected?: string;
  experimentId?: string;
  budget?: { maxAttempts: number; maxWallClockSeconds: number };
}) {
  const snapshot =
    input.arm === "R"
      ? input.genomes.rule.snapshot.id
      : input.arm === "oracle"
        ? input.genomes.oracle!.snapshot.id
        : input.genomes.llm.snapshot.id;
  return {
    input: {
      requestedBy: "principal-local",
      goal: input.goal,
      inputs: input.inputs,
      budget: input.budget ?? { maxAttempts: 1, maxWallClockSeconds: 30 },
      requires: ["changed-file-summary"],
      acceptance: {
        outputSchema: input.schema,
        expectedOutput: input.expected,
        verifier: "experiment-acceptance",
      },
    },
    options: {
      purpose: "evaluation" as const,
      snapshotId: snapshot,
      experimentId: input.experimentId ?? "exp-test",
    },
  };
}
