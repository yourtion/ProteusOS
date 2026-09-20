import type { OutcomeCheck } from "./types.ts";
import { validateSchema } from "./schema-validator.ts";

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
