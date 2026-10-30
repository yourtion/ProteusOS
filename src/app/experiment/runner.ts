import type { ExecutorSetup } from "../executor-adapter.ts";
import type { ModelAdapter } from "../../model/index.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { LlmDecisionProvider, llmConfigFromEnv } from "../../adapters/decision-llm/index.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../../decision/index.ts";
import { FROZEN_LLM_POLICY } from "../../decision/llm-policy.ts";
import type { CapabilityModule } from "../../runtime/capability.ts";
import { parseCapabilityModule } from "../../runtime/capability.ts";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import type { AppInstance } from "../instance.ts";
import { openInstance } from "../instance.ts";
import { ORGANISM_ID, PRINCIPAL_ID, installSeed } from "../seed.ts";
import type { SubmitOptions, TaskSubmission } from "../../runtime/index.ts";
import { ensureExperimentGenomes, PROTOCOL_ID, type ExperimentGenomes } from "./assets.ts";
import { caseBundleDigest, loadDataset, type Dataset, type DatasetCase } from "./dataset.ts";
import { OracleDecisionProvider } from "./oracle.ts";

/**
 * manifest 驱动的实验入口（实验规范 §6/§8）。
 * 顺序：装载与预检数据 → 冻结 manifest → （可选）Oracle 正反预检 →
 * 逐 trial 执行（真实调用并发 1，R/L 先后按种子平衡）→ trials.jsonl 落盘。
 * 墙钟达到上限即停，保留部分证据并标注 incomplete（收益结论 inconclusive）。
 */

export const REPORT_ALGO_VERSION = "organism-decision-report-v1";
export const FORMAL_WALL_CLOCK_LIMIT_MS = 60 * 60 * 1000;

export interface RunExperimentOptions {
  organismId?: string;
  modelAdapter?: ModelAdapter;
  executorAdapter?: ExecutorSetup;
  actorId?: string;
  home: string;
  datasetDir: string;
  outDir: string;
  /** L 组实现：fake（管道/开发演练）| real（真实 Adapter，需 env 凭据） */
  llm: "fake" | "real";
  arms: Array<"R" | "L">;
  repeats: number;
  experimentId: string;
  seed: number;
  /** 远端调用上限（organism 域 + experiment 域同时配置） */
  organismCallLimit: number;
  experimentCallLimit: number;
  wallClockLimitMs: number;
  /** capability 模块 fixture 路径（受信执行实现） */
  capabilityModulePath: string;
  withOracle: boolean;
  /** fake 模式的逐 trial 脚本工厂（测试用；缺省按 gold 选择） */
  fakeScriptFor?: (trial: { arm: "R" | "L"; caseData: DatasetCase; repeat: number }) => unknown;
  /** 跳过 oracle（已在先前运行完成时） */
  skipOracle?: boolean;
}

export interface TrialRow {
  experimentId: string;
  arm: "R" | "L";
  caseId: string;
  familyId: string;
  stratum: string;
  repeat: number;
  decisionId: string | null;
  runId: string;
  runState: string;
  failureReason: string | null;
  /** 实际选择（决策调用终态 value；abstain/失败为 null） */
  choice: string | null;
  callState: string | null;
  /** worker 派发数（应弃权 trial 必须为 0） */
  attempts: number;
  /** 端到端成功：run succeeded（可执行样本的主指标分母构成） */
  accepted: boolean;
  /** 决策正确（选择 == gold；对 abstain 样本 = 明确 abstain 且零派发） */
  decisionCorrect: boolean;
  expectedChoiceRef: { manifestDigest: string; caseId: string };
  latencyMs: number | null;
  usage: Record<string, unknown> | null;
  errorClass: string | null;
}

export interface ExperimentRunResult {
  status: "complete" | "incomplete" | "preflight_failed";
  experimentId: string;
  outDir: string;
  trials: number;
  oraclePassed: boolean | null;
  incompleteReason: string | null;
  manifestPath: string;
  genomeBindingDiff: Record<string, unknown>;
}

export async function runExperiment(opts: RunExperimentOptions): Promise<ExperimentRunResult> {
  const organismId = opts.organismId ?? ORGANISM_ID;
  const actorId = opts.actorId ?? PRINCIPAL_ID;
  const oldManifest = join(opts.outDir, "manifest.json");
  if (existsSync(oldManifest)) {
    const previous = JSON.parse(readFileSync(oldManifest, "utf8")) as {
      organismId?: string;
      actorId?: string;
    };
    if (
      (previous.organismId ?? ORGANISM_ID) !== organismId ||
      (previous.actorId ?? PRINCIPAL_ID) !== actorId
    )
      return fail(opts, "输出目录属于其他个体/操作者，不能复用其验证记录");
  }
  mkdirSync(opts.outDir, { recursive: true });

  // ---- 装配（fake 或 real LLM；oracle 仅显式请求时装配）----
  const fakeProvider = opts.llm === "fake" ? new FakeRunnerLlm() : null;
  const oracleProvider = opts.withOracle ? new OracleDecisionProvider() : null;
  const decisions = new Map<string, DecisionProvider>();
  if (fakeProvider) decisions.set("decision-llm", fakeProvider);
  if (opts.llm === "real") {
    const config = llmConfigFromEnv();
    if (!config && !opts.modelAdapter) {
      return {
        status: "preflight_failed",
        experimentId: opts.experimentId,
        outDir: opts.outDir,
        trials: 0,
        oraclePassed: null,
        incompleteReason:
          "真实 LLM 配置缺失：需要 PROTEUS_LLM_API_KEY（可选 PROTEUS_LLM_BASE_URL；代理见执行说明）",
        manifestPath: "",
        genomeBindingDiff: {},
      };
    }
    decisions.set(
      "decision-llm",
      new LlmDecisionProvider(opts.modelAdapter ? { adapter: opts.modelAdapter } : config!),
    );
  }
  if (oracleProvider) decisions.set("decision-oracle", oracleProvider);

  const inst = openInstance(opts.home, {
    decisions,
    organismId,
    actorId,
    executorAdapter: opts.executorAdapter,
  });
  try {
    // 保留普通 seed 与既有 M0–M2 行为（实验规范 §1）：临时实验实例幂等安装
    installSeed(
      {
        kernel: inst.kernel,
        storage: inst.storage,
        blobs: inst.blobs,
        clock: { now: Date.now },
      },
      { organismId, ownerId: actorId },
    );
    // ---- 数据预检 + capability 模块 + 冻结 manifest ----
    const dataset = loadDataset(opts.datasetDir);
    const moduleContent = JSON.parse(readFileSync(opts.capabilityModulePath, "utf8")) as unknown;
    const parsed = parseCapabilityModule(moduleContent);
    if (!parsed.ok) {
      return fail(opts, `capability 模块 fixture 不合法：${parsed.error}`);
    }
    const genomes = ensureExperimentGenomes(
      {
        kernel: inst.kernel,
        storage: inst.storage,
        blobs: inst.blobs,
        clock: { now: Date.now },
      },
      {
        createdBy: actorId,
        capabilityModule: parsed.module,
        llmPolicy: FROZEN_LLM_POLICY,
        withOracle: opts.withOracle,
      },
    );

    const manifest = buildManifest(opts, dataset, genomes, parsed.module);
    const manifestPath = join(opts.outDir, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // ---- 额度（持久化，进程重启/换 experimentId 不重置 organism 域）----
    inst.storage.setDecisionCallLimit({ organismId }, opts.organismCallLimit, Date.now());
    inst.storage.setDecisionCallLimit(
      { organismId, experimentId: opts.experimentId },
      opts.experimentCallLimit,
      Date.now(),
    );

    // ---- Oracle 预检：80/80 可执行任务正反各一次（不调模型）----
    let oraclePassed: boolean | null = null;
    if (opts.withOracle && !opts.skipOracle) {
      oraclePassed = await runOraclePrecheck(inst, dataset, genomes, oracleProvider!, opts);
      if (!oraclePassed) {
        return {
          status: "preflight_failed",
          experimentId: opts.experimentId,
          outDir: opts.outDir,
          trials: 0,
          oraclePassed: false,
          incompleteReason: "Oracle 预检失败：执行/裁判装配与正确选项不符（见上方日志）",
          manifestPath,
          genomeBindingDiff: genomes.bindingDiff,
        };
      }
    }

    // ---- 正式 trial 循环：并发 1，R/L 先后按种子平衡 ----
    // 恢复只执行尚未开始的单元，不覆盖旧结果（§6 步骤 6）
    const trialsPath = join(opts.outDir, "trials.jsonl");
    const resumeFrom = existsSync(trialsPath) ? await readTrialKeys(trialsPath) : new Set<string>();
    const startedAt = Date.now();
    let rows = 0;
    if (!existsSync(trialsPath)) writeFileSync(trialsPath, "", "utf8");
    let incompleteReason: string | null = null;

    outer: for (let repeat = 1; repeat <= opts.repeats; repeat++) {
      for (const caseData of dataset.cases) {
        for (const arm of armOrder(opts.seed, caseData.caseId, repeat)) {
          if (!opts.arms.includes(arm)) continue;
          const key = `${opts.experimentId}|${arm}|${caseData.caseId}|${repeat}`;
          if (resumeFrom.has(key)) continue; // 已有结果不覆盖
          if (Date.now() - startedAt > opts.wallClockLimitMs) {
            incompleteReason = `单轮墙钟达到上限（${opts.wallClockLimitMs}ms），保留已有证据，收益结论 inconclusive`;
            break outer;
          }
          const row = await runTrial(inst, {
            actorId,
            arm,
            caseData,
            dataset,
            repeat,
            genomes,
            experimentId: opts.experimentId,
            manifestDigest: manifest.digest,
            fakeProvider,
            fakeScript: opts.fakeScriptFor,
          });
          appendFileSync(trialsPath, `${JSON.stringify(row)}\n`, "utf8");
          rows++;
        }
      }
    }

    return {
      status: incompleteReason ? "incomplete" : "complete",
      experimentId: opts.experimentId,
      outDir: opts.outDir,
      trials: rows,
      oraclePassed,
      incompleteReason,
      manifestPath,
      genomeBindingDiff: genomes.bindingDiff,
    };
  } finally {
    inst.close();
  }
}

// ---- Oracle 预检 ----

async function runOraclePrecheck(
  inst: AppInstance,
  dataset: Dataset,
  genomes: ExperimentGenomes,
  oracle: OracleDecisionProvider,
  opts: RunExperimentOptions,
): Promise<boolean> {
  const executable = dataset.cases.filter((c) => c.expectedChoice !== "abstain");
  const results: Array<{ caseId: string; forced: string; state: string }> = [];
  for (const caseData of executable) {
    for (const forced of [caseData.expectedChoice, wrongOption(caseData.expectedChoice)]) {
      oracle.arm(forced);
      const { input, options } = trialSubmission(
        dataset,
        caseData,
        {
          purpose: "evaluation",
          snapshotId: genomes.oracle!.snapshot.id,
          experimentId: `oracle-${opts.experimentId}`,
        },
        opts.actorId ?? PRINCIPAL_ID,
      );
      const summary = await inst.runtime.submitTask(input, options);
      results.push({ caseId: caseData.caseId, forced, state: summary.state });
      const expectedState = forced === caseData.expectedChoice ? "succeeded" : "failed";
      if (summary.state !== expectedState) {
        const failedCheck = summary.checks.find((c) => !c.passed);
        console.error(
          `[oracle] case ${caseData.caseId} 强制 ${forced} → ${summary.state}（期望 ${expectedState}，原因 ${summary.failureReason ?? "无"}${failedCheck ? `；失败检查 ${failedCheck.name}: ${failedCheck.detail ?? ""}` : ""}）；任一预期不符即停止`,
        );
        return false;
      }
    }
  }
  console.error(
    `[oracle] ${results.length} 个预检 Run 全部符合预期（正确→succeeded，错误→failed）`,
  );
  return true;
}

function wrongOption(expected: string): string {
  return expected === "local-process" ? "capability/changed-file-summary" : "local-process";
}

// ---- 单个 trial ----

async function runTrial(
  inst: AppInstance,
  args: {
    actorId: string;
    arm: "R" | "L";
    caseData: DatasetCase;
    dataset: Dataset;
    repeat: number;
    genomes: ExperimentGenomes;
    experimentId: string;
    manifestDigest: string;
    fakeProvider: FakeRunnerLlm | null;
    fakeScript?: RunExperimentOptions["fakeScriptFor"];
  },
): Promise<TrialRow> {
  const { arm, caseData, dataset, repeat, genomes, experimentId, manifestDigest } = args;
  // L 组 fake：按 trial 设置脚本（缺省按 gold 行为——管道演练验证全链路；
  // abstain 样本缺省明确弃权）
  if (args.fakeProvider && arm === "L") {
    const script =
      args.fakeScript?.({ arm, caseData, repeat }) ??
      (caseData.expectedChoice === "abstain"
        ? { type: "abstain", reason: "信息不足（runner fake 缺省）" }
        : { type: "value", value: caseData.expectedChoice });
    args.fakeProvider.arm(script);
  }
  const snapshotId = arm === "R" ? genomes.rule.snapshot.id : genomes.llm.snapshot.id;
  const { input, options } = trialSubmission(
    dataset,
    caseData,
    {
      purpose: "evaluation",
      snapshotId,
      experimentId,
    },
    args.actorId,
  );
  const summary = await inst.runtime.submitTask(input, options);
  const calls = inst.storage.listDecisionCalls(summary.runId);
  const call = calls.length > 0 ? calls[calls.length - 1]! : null;
  const attempts = inst.storage
    .listProcesses(summary.runId)
    .flatMap((p) => inst.storage.listAttempts(p.id));
  const choice = call?.state === "value" ? valueOf(inst, call.responseRef) : null;
  const decisionCorrect =
    caseData.expectedChoice === "abstain"
      ? call?.state === "abstain" && attempts.length === 0
      : choice === caseData.expectedChoice;
  return {
    experimentId,
    arm,
    caseId: caseData.caseId,
    familyId: caseData.familyId,
    stratum: caseData.stratum,
    repeat,
    decisionId: call?.id ?? null,
    runId: summary.runId,
    runState: summary.state,
    failureReason: summary.failureReason,
    choice,
    callState: call?.state ?? null,
    attempts: attempts.length,
    accepted: summary.state === "succeeded",
    decisionCorrect,
    expectedChoiceRef: { manifestDigest, caseId: caseData.caseId },
    latencyMs: call?.durationMs ?? null,
    usage: call?.usage ? (JSON.parse(JSON.stringify(call.usage)) as Record<string, unknown>) : null,
    errorClass: call?.errorClass ?? null,
  };
}

function valueOf(inst: AppInstance, responseRef: string | null): string | null {
  if (!responseRef || !inst.blobs.has(responseRef)) return null;
  try {
    const parsed = JSON.parse(inst.blobs.read(responseRef)) as { kind?: string; value?: unknown };
    return parsed.kind === "value" && typeof parsed.value === "string" ? parsed.value : null;
  } catch {
    return null;
  }
}

function trialSubmission(
  dataset: Dataset,
  caseData: DatasetCase,
  options: { purpose: "evaluation"; snapshotId: string; experimentId: string },
  actorId: string = PRINCIPAL_ID,
): { input: TaskSubmission; options: SubmitOptions } {
  const input: TaskSubmission = {
    requestedBy: actorId,
    familyId: caseData.familyId,
    goal: caseData.goal,
    inputs: [join(dataset.root, caseData.textDir), join(dataset.root, caseData.changedFiles)],
    budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
    requires: ["changed-file-summary"],
    acceptance: {
      outputSchema: join(dataset.root, caseData.acceptance.outputSchema),
      expectedOutput: caseData.acceptance.expectedOutput
        ? join(dataset.root, caseData.acceptance.expectedOutput)
        : undefined,
      verifier: "experiment-acceptance",
    },
  };
  return {
    input,
    options: {
      purpose: options.purpose,
      snapshotId: options.snapshotId,
      experimentId: options.experimentId,
    },
  };
}

// ---- manifest ----

function buildManifest(
  opts: RunExperimentOptions,
  dataset: Dataset,
  genomes: ExperimentGenomes,
  module: CapabilityModule,
): { digest: string } & Record<string, unknown> {
  const cases = dataset.cases.map((c) => ({
    caseId: c.caseId,
    familyId: c.familyId,
    stratum: c.stratum,
    language: c.language,
    goalDigest: digestOf(c.goal),
    textDir: c.textDir,
    changedFiles: c.changedFiles,
    bundleDigest: caseBundleDigest(dataset, c),
    expectedChoice: c.expectedChoice,
    schemaDigest: digestOf(readFileSync(join(dataset.root, c.acceptance.outputSchema), "utf8")),
    expectedDigest: c.acceptance.expectedOutput
      ? digestOf(readFileSync(join(dataset.root, c.acceptance.expectedOutput), "utf8"))
      : null,
  }));
  const manifest = {
    protocolId: PROTOCOL_ID,
    organismId: opts.organismId ?? ORGANISM_ID,
    actorId: opts.actorId ?? PRINCIPAL_ID,
    frozenAt: new Date().toISOString(),
    implementationCommit: process.env.PROTEUS_COMMIT ?? null,
    datasetPurpose: dataset.datasetPurpose,
    split: dataset.split,
    cases,
    arms: {
      R: {
        provider: "decision-rule",
        policyVersionId: genomes.rule.policyVersionId,
        snapshotId: genomes.rule.snapshot.id,
        snapshotDigest: genomes.rule.snapshot.digest,
      },
      L: {
        provider: "decision-llm",
        policyVersionId: genomes.llm.policyVersionId,
        snapshotId: genomes.llm.snapshot.id,
        snapshotDigest: genomes.llm.snapshot.digest,
      },
    },
    sharedVersions: {
      acceptanceEvaluator: genomes.evaluatorVersionId,
      decisionView: genomes.decisionViewVersionId,
      capability: genomes.capabilityVersionId,
      capabilityDigest: digestOf(canonicalJson(module)),
    },
    bindingDiff: genomes.bindingDiff,
    llmConfig: {
      service: FROZEN_LLM_POLICY.service,
      model: FROZEN_LLM_POLICY.model,
      sampling: FROZEN_LLM_POLICY.sampling,
      promptDigest: digestOf(FROZEN_LLM_POLICY.promptTemplate),
      llmImpl: opts.llm,
    },
    seed: opts.seed,
    repeats: opts.repeats,
    limits: {
      organismCalls: opts.organismCallLimit,
      experimentCalls: opts.experimentCallLimit,
      wallClockMs: opts.wallClockLimitMs,
    },
    reportAlgo: REPORT_ALGO_VERSION,
  };
  const digest = digestOf(canonicalJson(manifest));
  return { digest, ...manifest };
}

// ---- 工具 ----

/** R/L 先后按 (seed, caseId, repeat) 确定性平衡 */
function armOrder(seed: number, caseId: string, repeat: number): Array<"R" | "L"> {
  const h = digestOf(`${seed}:${caseId}:${repeat}`).codePointAt(0)!;
  return h % 2 === 0 ? ["R", "L"] : ["L", "R"];
}

async function readTrialKeys(trialsPath: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const rl = createInterface({ input: createReadStream(trialsPath) });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line) as TrialRow;
      keys.add(`${row.experimentId}|${row.arm}|${row.caseId}|${row.repeat}`);
    } catch {
      // 损坏行交给 reporter 显式列出；runner 恢复时跳过不可解析行
    }
  }
  return keys;
}

function fail(opts: RunExperimentOptions, reason: string): ExperimentRunResult {
  return {
    status: "preflight_failed",
    experimentId: opts.experimentId,
    outDir: opts.outDir,
    trials: 0,
    oraclePassed: null,
    incompleteReason: reason,
    manifestPath: "",
    genomeBindingDiff: {},
  };
}

// ---- runner 内置 fake（管道演练；比测试替身少失败模式，只按脚本回放）----

type RunnerScript =
  | { type: "value"; value: string }
  | { type: "abstain"; reason?: string }
  | unknown;

class FakeRunnerLlm implements DecisionProvider {
  readonly name = "decision-llm";
  readonly remote = true;
  private script: RunnerScript = { type: "abstain", reason: "runner fake 未设置脚本" };

  arm(script: RunnerScript): void {
    this.script = script;
  }

  capabilities(): { problems: Array<"choice" | "gate" | "rank"> } {
    return { problems: ["choice"] };
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    const provenance = { provider: this.name, policyVersion: request.policy.versionId };
    const script = this.script as { type?: string; value?: unknown; reason?: unknown };
    if (script?.type === "value" && typeof script.value === "string") {
      return Promise.resolve({
        kind: "value",
        value: script.value,
        provenance,
        raw: JSON.stringify({ kind: "value", value: script.value }),
      } as const);
    }
    if (script?.type === "abstain") {
      return Promise.resolve({
        kind: "abstain",
        reason: typeof script.reason === "string" ? script.reason : "runner fake 弃权",
        provenance,
        origin: "model",
        raw: JSON.stringify({ kind: "abstain" }),
      } as const);
    }
    return Promise.resolve({
      kind: "invalid_output",
      detail: "runner fake 收到未知脚本",
      provenance,
      raw: JSON.stringify(script),
    } as const);
  }

  callProvenance() {
    return {
      adapter: "decision-llm-runner-fake",
      serviceId: "fake://runner",
      requestedModel: "fake",
      sampling: { temperature: 0, maxOutputTokens: 256 },
      promptDigest: null,
      reproducibility: "pinned" as const,
    };
  }
}
