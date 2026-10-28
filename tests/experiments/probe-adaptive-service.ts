import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import {
  LlmDecisionProvider,
  llmConfigFromEnv,
  type LlmAdapterConfig,
} from "../../src/adapters/decision-llm/index.ts";
import { buildLlmChoiceBody } from "../../src/adapters/decision-llm/request.ts";
import { FROZEN_LLM_POLICY, type DecisionRequest } from "../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";

// 显式选择配置来源，不扫描其他应用的认证文件；凭据只留内存。
const args = process.argv.slice(2);
if (args.length !== 2 && args.length !== 4)
  throw new Error(
    "Usage: probe-adaptive-service.ts --output NEW_DIRECTORY [--claude-settings FILE]",
  );
if (args[0] !== "--output" || (args.length === 4 && args[2] !== "--claude-settings"))
  throw new Error("Invalid probe arguments");
const out = resolve(args[1]!);
mkdirSync(out);
let config: LlmAdapterConfig | null = llmConfigFromEnv();
let configurationSource = "PROTEUS_LLM_*";
if (args[3]) {
  const settings = JSON.parse(readFileSync(resolve(args[3]), "utf8")) as {
    env?: Record<string, string>;
  };
  const env = settings.env;
  if (!env?.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL)
    throw new Error("Selected settings have no Anthropic credential/endpoint");
  config = {
    apiKey: env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: env.ANTHROPIC_BASE_URL,
    requestTimeoutMs: 15_000,
  };
  configurationSource = "explicit-claude-settings";
}
if (!config) throw new Error("PROTEUS_LLM_API_KEY required");
const provider = new LlmDecisionProvider(config);
const options = ["local-process", "capability/changed-file-summary"];
const request: DecisionRequest = {
  problem: "choice",
  options,
  context: {},
  policy: { versionId: "compatibility-probe-v1", content: FROZEN_LLM_POLICY },
  view: {
    viewVersion: "decision-view-v1",
    goal: "Count words and lines in the release notes.",
    options: options.map((id) => ({
      id,
      description: id === "local-process" ? "Count text statistics" : "Summarize changed files",
    })),
    inputs: [{ name: "release.md", type: "file", bytes: 32 }],
    features: { hasStatsIntent: true },
  },
  deadlineMs: 15_000,
  remainingAttempts: 1,
  signal: AbortSignal.timeout(15_000),
};
const body = buildLlmChoiceBody(FROZEN_LLM_POLICY, request.view!, options);
const record: Record<string, unknown> = {
  version: "adaptive-service-probe-v1",
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTreeDirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  configurationSource,
  serviceId: config.baseUrl,
  requestedModel: FROZEN_LLM_POLICY.model,
  requestDigest: digestOf(canonicalJson(body)),
  maximumGeneratedCalls: 1,
  inputThreshold: 2048,
  outputLimit: FROZEN_LLM_POLICY.sampling.maxOutputTokens,
  retries: 0,
  formalEvaluation: "not_run",
  independentBenefit: "not_evaluated",
  // counter + max_tokens 不证明输入硬上界；不得据此签发 real 许可。
  realExperimentAdmission: "blocked",
  inputHardBound: "unverified",
};
let counted: number | null = null;
let sent = false;
try {
  counted = await provider.countInputTokens(request);
  record.countedInputTokens = counted;
  writeFileSync(join(out, "request.json"), canonicalJson(body));
  if (counted > 2048) throw new Error("probe_input_threshold_exceeded");
  // 写入开始记录再发送，进程中断也不允许自动重放。
  record.status = "generation-started";
  writeFileSync(join(out, "report.json"), JSON.stringify(record, null, 2));
  sent = true;
  const result = await provider.decide(request);
  writeFileSync(join(out, "response.json"), canonicalJson(result));
  record.status = "completed";
  record.resultKind = result.kind;
  record.actualUsage = result.evidence ?? null;
  record.countMatchesUsage = counted === result.evidence?.inputTokens;
  record.choice = result.kind === "value" ? result.value : null;
  record.responseDigest = digestOf(canonicalJson(result));
} catch (error) {
  record.status = sent ? "generation-unknown" : "preflight-failed";
  record.errorType = error instanceof Error ? error.name : "UnknownError";
  record.httpStatus = typeof error === "object" && error && "status" in error ? error.status : null;
}
record.sentGenerationCalls = sent ? 1 : 0;
record.finishedAt = new Date().toISOString();
writeFileSync(join(out, "report.json"), `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record, null, 2)}\nEvidence saved to ${out}\n`);
