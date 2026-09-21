import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import type { OutcomeCheck } from "./types.ts";
import { validateSchema } from "./schema-validator.ts";

/**
 * 验收器按快照绑定的产物内容分发（M1）：
 * - stats-acceptance-v1：JSON Schema 校验 + totals 一致性（M0 seed）
 * - test-runner-v1：在产出工作区运行固定测试命令，退出码即判据
 *   ——执行器自报完成不构成验收，测试失败不能标为任务成功（roadmap M1）
 * - hybrid-acceptance-v1（M2 预注册）：stats 形态输出走 stats 校验（与 v1 判定
 *   等价，等价性由 tests/evals 覆盖），其余输出走纯 JSON Schema 校验；
 *   用于新能力任务（如 ChangedFileSummary）的运行时验收
 */

export type EvaluatorKind = "stats-acceptance-v1" | "test-runner-v1" | "hybrid-acceptance-v1";

export function readEvaluatorKind(content: unknown): EvaluatorKind {
  if (typeof content === "object" && content !== null) {
    const kind = (content as { kind?: unknown }).kind;
    if (
      kind === "test-runner-v1" ||
      kind === "stats-acceptance-v1" ||
      kind === "hybrid-acceptance-v1"
    ) {
      return kind;
    }
  }
  return "stats-acceptance-v1";
}

export interface TestRunnerContent {
  kind: "test-runner-v1";
  /** 在产出工作区执行的测试命令，如 ["node", "--test", "tests/"] */
  command: string[];
  /** 测试通过时同时固定这些工作区相对路径的内容摘要 */
  attestPaths?: string[];
}

export function evaluateTestRunner(
  content: unknown,
  workspace: string,
): { passed: boolean; checks: OutcomeCheck[]; attestedOutputs?: Record<string, string> } {
  const command =
    typeof content === "object" &&
    content !== null &&
    Array.isArray((content as { command?: unknown }).command) &&
    (content as { command: unknown[] }).command.every((c) => typeof c === "string" && c.length > 0)
      ? ((content as { command: string[] }).command as string[])
      : null;
  if (!command) {
    return {
      passed: false,
      checks: [{ name: "tests", passed: false, detail: "验收器内容缺少合法的 command" }],
    };
  }
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  let passed = result.status === 0;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const checks: OutcomeCheck[] = [
    {
      name: "tests",
      passed,
      detail: passed
        ? undefined
        : `测试命令退出码 ${String(result.status)}：${output.slice(-400) || "(无输出)"}`,
    },
  ];
  const attestedOutputs: Record<string, string> = {};
  const attestPaths =
    typeof content === "object" &&
    content !== null &&
    Array.isArray((content as { attestPaths?: unknown }).attestPaths)
      ? (content as { attestPaths: unknown[] }).attestPaths
      : [];
  for (const path of attestPaths) {
    const valid = typeof path === "string" && path.length > 0 && !isAbsolute(path);
    const target = valid ? resolve(workspace, path) : "";
    const inWorkspace = valid && target.startsWith(`${resolve(workspace)}/`);
    if (!inWorkspace || !existsSync(target)) {
      passed = false;
      checks.push({
        name: "attested-output",
        passed: false,
        detail: `待证明产物缺失或路径越界：${String(path)}`,
      });
      continue;
    }
    attestedOutputs[path] = digestOf(readFileSync(target, "utf8"));
  }
  return {
    passed,
    checks,
    ...(Object.keys(attestedOutputs).length > 0 ? { attestedOutputs } : {}),
  };
}

/**
 * stats-acceptance-v1 验收器：JSON Schema 校验 + totals 与逐文件求和一致性。
 * 验收器由快照的 acceptance-evaluator 槽位固定，候选不能替换本轮裁判。
 */
export function evaluateStatsOutput(
  output: unknown,
  schema: unknown,
): {
  passed: boolean;
  checks: OutcomeCheck[];
} {
  const checks: OutcomeCheck[] = [];

  const schemaErrors = validateSchema(output, schema);
  checks.push({
    name: "json-schema",
    passed: schemaErrors.length === 0,
    detail:
      schemaErrors
        .slice(0, 5)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || undefined,
  });
  checks.push(checkTotalsConsistency(output));

  return { passed: checks.every((c) => c.passed), checks };
}

/** 输出呈 stats 形态（files 数组 + totals 对象）时才适用 totals 校验 */
function looksLikeStatsOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const { files, totals } = output as Record<string, unknown>;
  return Array.isArray(files) && typeof totals === "object" && totals !== null;
}

/**
 * hybrid-acceptance-v1：stats 形态走 stats 校验（与 v1 等价），
 * 其余走纯 JSON Schema 校验（schema 来自 Task，不由候选提供）。
 */
export function evaluateHybridOutput(
  output: unknown,
  schema: unknown,
): { passed: boolean; checks: OutcomeCheck[] } {
  if (looksLikeStatsOutput(output)) {
    return evaluateStatsOutput(output, schema);
  }
  const schemaErrors = validateSchema(output, schema);
  const checks: OutcomeCheck[] = [
    {
      name: "json-schema",
      passed: schemaErrors.length === 0,
      detail:
        schemaErrors
          .slice(0, 5)
          .map((e) => `${e.path}: ${e.message}`)
          .join("; ") || undefined,
    },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

/** 固定 fixture 的语义验收：忽略 JSON 对象键顺序，数组顺序仍属于合同。 */
export function evaluateExpectedOutput(output: unknown, expected: unknown): OutcomeCheck {
  const passed = canonicalJson(output) === canonicalJson(expected);
  return {
    name: "expected-output",
    passed,
    detail: passed ? undefined : "输出与评估计划固定的期望结果不一致",
  };
}

function checkTotalsConsistency(output: unknown): OutcomeCheck {
  if (typeof output !== "object" || output === null) {
    return { name: "totals-consistency", passed: false, detail: "输出不是对象" };
  }
  const { files, totals } = output as Record<string, unknown>;
  if (!Array.isArray(files) || typeof totals !== "object" || totals === null) {
    return {
      name: "totals-consistency",
      passed: false,
      detail: "输出缺少 files 数组或 totals 对象",
    };
  }
  const fileEntries = files as Array<Record<string, unknown>>;
  const totalsRecord = totals as Record<string, unknown>;
  // totals.files 是文件数量；其余字段是逐文件求和
  if (totalsRecord["files"] !== fileEntries.length) {
    return {
      name: "totals-consistency",
      passed: false,
      detail: `totals.files=${String(totalsRecord["files"])} 与实际文件数 ${fileEntries.length} 不一致`,
    };
  }
  for (const field of ["bytes", "lines", "words", "headings"]) {
    const sum = fileEntries.reduce(
      (acc, file) => acc + (typeof file[field] === "number" ? (file[field] as number) : 0),
      0,
    );
    if (totalsRecord[field] !== sum) {
      return {
        name: "totals-consistency",
        passed: false,
        detail: `totals.${field}=${String(totalsRecord[field])} 与 files 求和 ${sum} 不一致`,
      };
    }
  }
  return { name: "totals-consistency", passed: true };
}
