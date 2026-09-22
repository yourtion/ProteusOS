import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import { PROTOCOL_ID } from "./assets.ts";

/**
 * 实验数据集装载与校验（实验规范 §5）。
 * 全部数据为合成 fixture；case 结构、family 隔离、stratum 覆盖与
 * 期望输出完整性在此预检——固定 trial 表含错误/重复/缺失/退化样本时
 * 必须显式失败，不得静默跳过（D14）。
 */

export type Stratum = "explicit" | "paraphrase" | "distractor" | "contrast" | "abstain";
export const STRATA: readonly Stratum[] = [
  "explicit",
  "paraphrase",
  "distractor",
  "contrast",
  "abstain",
];

export type ExpectedChoice = "local-process" | "capability/changed-file-summary" | "abstain";

export interface DatasetCase {
  caseId: string;
  familyId: string;
  stratum: Stratum;
  /** 覆盖语言标记（zh/en；每组至少两种） */
  language: "zh" | "en";
  goal: string;
  /** 文本 bundle 目录（相对 dataset 根） */
  textDir: string;
  /** changed-files.json（相对 dataset 根） */
  changedFiles: string;
  expectedChoice: ExpectedChoice;
  /** contrast 对内配对 case；非 contrast 为 null */
  pairedCaseId: string | null;
  acceptance: {
    outputSchema: string;
    expectedOutput: string | null;
  };
}

export interface Dataset {
  protocol: string;
  split: string;
  datasetPurpose: "development" | "plumbing-test" | "formal";
  cases: DatasetCase[];
  /** 数据集根（绝对路径），供 runner 解析相对引用 */
  root: string;
}

export class DatasetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface CaseFileShape {
  protocol?: unknown;
  split?: unknown;
  datasetPurpose?: unknown;
  cases?: unknown;
}

export function loadDataset(dir: string): Dataset {
  const caseFile = join(dir, "cases.json");
  if (!existsSync(caseFile)) {
    throw new DatasetError("manifest_missing", `数据集缺少 cases.json：${caseFile}`);
  }
  let parsed: CaseFileShape;
  try {
    parsed = JSON.parse(readFileSync(caseFile, "utf8")) as CaseFileShape;
  } catch (err) {
    throw new DatasetError("manifest_invalid", `cases.json 不可解析：${String(err)}`);
  }
  if (parsed.protocol !== PROTOCOL_ID) {
    throw new DatasetError(
      "protocol_mismatch",
      `数据集协议 ${String(parsed.protocol)} 与实现协议 ${PROTOCOL_ID} 不一致`,
    );
  }
  const purpose = parsed.datasetPurpose;
  if (purpose !== "development" && purpose !== "plumbing-test" && purpose !== "formal") {
    throw new DatasetError("purpose_invalid", `datasetPurpose 不合法：${String(purpose)}`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new DatasetError("cases_missing", "cases.json 缺少 cases 数组");
  }
  const cases: DatasetCase[] = [];
  for (const raw of parsed.cases) {
    cases.push(parseCase(raw));
  }
  validateDataset({
    protocol: parsed.protocol!,
    split: String(parsed.split ?? ""),
    datasetPurpose: purpose,
    cases,
    root: dir,
  });
  return {
    protocol: parsed.protocol!,
    split: String(parsed.split ?? ""),
    datasetPurpose: purpose,
    cases,
    root: dir,
  };
}

function parseCase(raw: unknown): DatasetCase {
  if (typeof raw !== "object" || raw === null) {
    throw new DatasetError("case_invalid", "case 条目不是对象");
  }
  const c = raw as Record<string, unknown>;
  const stratum = c["stratum"];
  const expected = c["expectedChoice"];
  if (
    typeof c["caseId"] !== "string" ||
    typeof c["familyId"] !== "string" ||
    typeof c["goal"] !== "string" ||
    typeof c["textDir"] !== "string" ||
    typeof c["changedFiles"] !== "string"
  ) {
    throw new DatasetError("case_invalid", `case 缺少必需字段：${JSON.stringify(c).slice(0, 200)}`);
  }
  if (!STRATA.includes(stratum as Stratum)) {
    throw new DatasetError(
      "stratum_invalid",
      `case ${c["caseId"]} 的 stratum 不合法：${String(stratum)}`,
    );
  }
  if (
    expected !== "local-process" &&
    expected !== "capability/changed-file-summary" &&
    expected !== "abstain"
  ) {
    throw new DatasetError(
      "expected_invalid",
      `case ${c["caseId"]} 的 expectedChoice 不合法：${String(expected)}`,
    );
  }
  if (c["goal"].length === 0) {
    throw new DatasetError("degenerate_case", `case ${c["caseId"]} 的 goal 为空（退化样本）`);
  }
  const schema = c["acceptance"] as
    | { outputSchema?: unknown; expectedOutput?: unknown }
    | undefined;
  if (!schema || typeof schema.outputSchema !== "string") {
    throw new DatasetError(
      "acceptance_invalid",
      `case ${c["caseId"]} 缺少 acceptance.outputSchema`,
    );
  }
  if (expected !== "abstain" && typeof schema.expectedOutput !== "string") {
    throw new DatasetError(
      "acceptance_invalid",
      `可执行 case ${c["caseId"]} 必须有期望输出（abstain case 才允许为空）`,
    );
  }
  return {
    caseId: c["caseId"],
    familyId: c["familyId"],
    stratum: stratum as Stratum,
    language: c["language"] === "en" ? "en" : "zh",
    goal: c["goal"],
    textDir: c["textDir"],
    changedFiles: c["changedFiles"],
    expectedChoice: expected as ExpectedChoice,
    pairedCaseId: typeof c["pairedCaseId"] === "string" ? (c["pairedCaseId"] as string) : null,
    acceptance: {
      outputSchema: schema.outputSchema,
      expectedOutput: typeof schema.expectedOutput === "string" ? schema.expectedOutput : null,
    },
  };
}

function validateDataset(dataset: Dataset): void {
  const { cases } = dataset;
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.caseId)) {
      throw new DatasetError("duplicate_case", `caseId 重复：${c.caseId}（重复行不静默跳过）`);
    }
    seen.add(c.caseId);
  }
  // 物理文件完整性：bundle、changed-files、schema 与期望输出必须存在
  for (const c of cases) {
    if (!statSync(join(dataset.root, c.textDir)).isDirectory()) {
      throw new DatasetError("bundle_missing", `case ${c.caseId} 的文本目录缺失：${c.textDir}`);
    }
    for (const rel of [c.changedFiles, c.acceptance.outputSchema]) {
      if (!existsSync(join(dataset.root, rel))) {
        throw new DatasetError("bundle_missing", `case ${c.caseId} 引用的文件缺失：${rel}`);
      }
    }
    if (
      c.acceptance.expectedOutput &&
      !existsSync(join(dataset.root, c.acceptance.expectedOutput))
    ) {
      throw new DatasetError(
        "bundle_missing",
        `case ${c.caseId} 的期望输出缺失：${c.acceptance.expectedOutput}`,
      );
    }
    const textFiles = readdirSync(join(dataset.root, c.textDir)).filter(
      (f) => f.endsWith(".txt") || f.endsWith(".md"),
    );
    if (textFiles.length === 0) {
      throw new DatasetError("degenerate_case", `case ${c.caseId} 的文本目录没有 .txt/.md 文件`);
    }
  }
  // family 规则：非 contrast 每项来自不同 family；contrast 对内共享 family 与输入包
  const byFamily = new Map<string, DatasetCase[]>();
  for (const c of cases) {
    byFamily.set(c.familyId, [...(byFamily.get(c.familyId) ?? []), c]);
  }
  for (const [family, members] of byFamily) {
    if (members.length !== 2) {
      if (members.some((m) => m.stratum === "contrast")) {
        throw new DatasetError(
          "family_invalid",
          `contrast family ${family} 必须恰好两个成员（成对任务），实际 ${members.length}`,
        );
      }
      if (members.length > 1) {
        throw new DatasetError(
          "family_invalid",
          `非 contrast family ${family} 包含 ${members.length} 个成员（须一 family 一样本）`,
        );
      }
      continue;
    }
    const [a, b] = members;
    if (a!.stratum !== "contrast" || b!.stratum !== "contrast") {
      throw new DatasetError(
        "family_invalid",
        `family ${family} 有两个成员但不是 contrast（非 contrast 样本须各自独立 family）`,
      );
    }
    if (a!.textDir !== b!.textDir || a!.changedFiles !== b!.changedFiles) {
      throw new DatasetError(
        "family_invalid",
        `contrast 对 ${family} 必须共享同一输入包（textDir/changedFiles 一致）`,
      );
    }
    if (a!.expectedChoice === b!.expectedChoice) {
      throw new DatasetError(
        "family_invalid",
        `contrast 对 ${family} 两个任务的正确选项必须不同（只改变目标就应改变选择）`,
      );
    }
    if (a!.pairedCaseId !== b!.caseId || b!.pairedCaseId !== a!.caseId) {
      throw new DatasetError(
        "family_invalid",
        `contrast 对 ${family} 的 pairedCaseId 必须互相指向`,
      );
    }
  }
  // contrast 案例的 pairedCaseId 已由 family 校验覆盖；语言覆盖
  for (const stratum of STRATA) {
    const members = cases.filter((c) => c.stratum === stratum);
    if (members.length === 0) continue;
    const langs = new Set(members.map((m) => m.language));
    if (langs.size < 2) {
      throw new DatasetError(
        "language_coverage",
        `stratum ${stratum} 至少覆盖两种语言表达（zh/en）`,
      );
    }
  }
}

/** 输入包摘要：bundle 文本内容 + changed-files 内容的规范寻址（runner 与 reporter 共用） */
export function bundleDigestFrom(root: string, textDir: string, changedFiles: string): string {
  const dir = join(root, textDir);
  const entries = readdirSync(dir)
    .sort()
    .map((name) => ({ name, digest: digestOf(readFileSync(join(dir, name), "utf8")) }));
  return digestOf(
    canonicalJson({
      textDir,
      entries,
      changedFiles: digestOf(readFileSync(join(root, changedFiles), "utf8")),
    }),
  );
}

export function caseBundleDigest(dataset: Dataset, c: DatasetCase): string {
  return bundleDigestFrom(dataset.root, c.textDir, c.changedFiles);
}

/** 与另一 split 的 family 完全不重叠（开发/正式隔离） */
export function assertFamilyIsolation(a: Dataset, b: { families: string[] }, bLabel: string): void {
  const aFamilies = new Set(a.cases.map((c) => c.familyId));
  for (const family of b.families) {
    if (aFamilies.has(family)) {
      throw new DatasetError(
        "family_overlap",
        `family ${family} 同时出现在 ${a.datasetPurpose} 与 ${bLabel}（split 间必须完全隔离）`,
      );
    }
  }
}

export function datasetFamilies(dataset: Dataset): string[] {
  return [...new Set(dataset.cases.map((c) => c.familyId))];
}
