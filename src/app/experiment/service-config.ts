import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { llmConfigFromEnv, type LlmAdapterConfig } from "../../adapters/decision-llm/index.ts";

/** 凭据只留内存；读取其他应用配置必须由调用者显式指定文件。 */
export function experimentServiceConfig(settingsPath?: string): {
  config: LlmAdapterConfig;
  source: string;
} {
  if (!settingsPath) {
    const config = llmConfigFromEnv();
    if (!config) throw new Error("PROTEUS_LLM_API_KEY required");
    return { config, source: "PROTEUS_LLM_*" };
  }
  const settings = JSON.parse(readFileSync(resolve(settingsPath), "utf8")) as {
    env?: Record<string, string>;
  };
  const env = settings.env;
  if (!env?.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL)
    throw new Error("Selected settings have no Anthropic credential/endpoint");
  const url = new URL(env.ANTHROPIC_BASE_URL);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:")
    throw new Error("Experiment endpoint must be HTTPS without embedded credentials or query");
  return {
    config: {
      apiKey: env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: url.href.replace(/\/$/, ""),
      requestTimeoutMs: 15_000,
    },
    source: "explicit-claude-settings",
  };
}
