import type {
  ExecutionAccounting,
  ExecutionTokenTotals,
  ExecutionUsage,
} from "../../runtime/execution-evidence.ts";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = (values: Array<number | null>): number | null =>
  values.every((n) => n !== null) &&
  Number.isSafeInteger(values.reduce<number>((a, b) => a + (b ?? 0), 0))
    ? values.reduce<number>((a, b) => a + b!, 0)
    : null;
function totals(
  input: unknown,
  output: unknown,
  read: unknown,
  write: unknown,
): ExecutionTokenTotals {
  const uncachedInputTokens = count(input),
    outputTokens = count(output),
    cachedReadTokens = count(read),
    cachedWriteTokens = count(write);
  const inputTokens = sum([uncachedInputTokens, cachedReadTokens, cachedWriteTokens]);
  return {
    uncachedInputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens: sum([inputTokens, outputTokens]),
  };
}
function usageFields(value: unknown) {
  const u = object(value);
  return u
    ? {
        input_tokens: count(u.input_tokens),
        output_tokens: count(u.output_tokens),
        cache_read_input_tokens: count(u.cache_read_input_tokens),
        cache_creation_input_tokens: count(u.cache_creation_input_tokens),
      }
    : null;
}

/** One fresh ACP session / one prompt. SDK modelUsage is cumulative, so readings replace, not add. */
export class AcpAccounting {
  private responses = new Map<string, Record<string, unknown>>();
  private result: Record<string, unknown> | null = null;
  private resultTotals: ExecutionTokenTotals | null = null;
  private prompt: Record<string, unknown> | null = null;
  private promptTotals: ExecutionTokenTotals | null = null;
  private models = new Set<string>();
  private issues = new Set<string>();
  private cost: ExecutionAccounting["reportedCost"] = null;

  private readonly claude: boolean;
  constructor(claude: boolean) {
    this.claude = claude;
  }

  observeSdk(params: unknown): void {
    if (!this.claude) return;
    const message = object(object(params)?.message);
    if (!message) return;
    if (message.type === "assistant") {
      const m = object(message.message);
      if (typeof m?.id !== "string" || m.id.length > 256 || typeof m.model !== "string") return;
      if (this.responses.size >= 128 && !this.responses.has(m.id)) {
        this.issues.add("response_limit");
        return;
      }
      this.models.add(m.model.slice(0, 256));
      // Repeated content blocks carry the same ID; retain the latest numeric receipt once.
      this.responses.set(m.id, {
        kind: "assistant",
        id: m.id,
        model: m.model.slice(0, 256),
        usage: usageFields(m.usage),
      });
    } else if (message.type === "result") {
      const previous = this.resultTotals;
      this.resultTotals = null;
      this.cost = null;
      const modelUsage = object(message.modelUsage);
      const rows = Object.entries(modelUsage ?? {})
        .slice(0, 32)
        .map(([model, value]) => {
          const row = object(value);
          this.models.add(model.slice(0, 256));
          return {
            model: model.slice(0, 256),
            ...totals(
              row?.inputTokens,
              row?.outputTokens,
              row?.cacheReadInputTokens,
              row?.cacheCreationInputTokens,
            ),
          };
        });
      if (Object.keys(modelUsage ?? {}).length > 32) this.issues.add("model_limit");
      if (rows.length) {
        const keys: Array<keyof ExecutionTokenTotals> = [
          "uncachedInputTokens",
          "outputTokens",
          "cachedReadTokens",
          "cachedWriteTokens",
          "inputTokens",
          "totalTokens",
        ];
        this.resultTotals = Object.fromEntries(
          keys.map((key) => [key, sum(rows.map((row) => row[key]))]),
        ) as unknown as ExecutionTokenTotals;
        if (Object.keys(modelUsage ?? {}).length > 32) this.resultTotals = null;
      }
      if (
        previous &&
        this.resultTotals &&
        Object.keys(previous).some((key) => {
          const before = previous[key as keyof ExecutionTokenTotals],
            after = this.resultTotals![key as keyof ExecutionTokenTotals];
          return before !== null && after !== null && after < before;
        })
      )
        this.issues.add("cumulative_usage_regressed");
      if (!rows.length) this.issues.add("missing_model_usage");
      const amount = message.total_cost_usd;
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
        this.cost = { amount, currency: "USD", source: "claude-sdk-estimate", verified: false };
      this.result = {
        kind: "sdk-result",
        id: typeof message.uuid === "string" ? message.uuid.slice(0, 256) : null,
        subtype: typeof message.subtype === "string" ? message.subtype.slice(0, 128) : null,
        numTurns: count(message.num_turns),
        usage: usageFields(message.usage),
        modelUsage: rows,
      };
    }
  }

  observeResponse(value: unknown): void {
    const response = object(value),
      u = object(response?.usage);
    if (!u) return;
    this.prompt = {
      kind: "prompt-response",
      inputTokens: count(u.inputTokens),
      outputTokens: count(u.outputTokens),
      cachedReadTokens: count(u.cachedReadTokens),
      cachedWriteTokens: count(u.cachedWriteTokens),
      totalTokens: count(u.totalTokens),
    };
    // Cache semantics are documented for the explicitly selected Claude adapter only.
    if (this.claude) {
      this.promptTotals = totals(
        u.inputTokens,
        u.outputTokens,
        u.cachedReadTokens,
        u.cachedWriteTokens,
      );
      if (this.promptTotals.totalTokens !== count(u.totalTokens)) {
        this.issues.add("prompt_usage_mismatch");
        this.promptTotals = null;
      }
    } else this.issues.add("unspecified_cache_semantics");
  }

  snapshot(terminal: boolean): ExecutionAccounting {
    const value = this.result ? this.resultTotals : this.promptTotals;
    const issues = [...this.issues];
    if (!terminal) issues.push("execution_not_terminal");
    if (!this.result && this.promptTotals) issues.push("prompt_scope_only");
    if (value && Object.values(value).some((n) => n === null)) issues.push("missing_token_fields");
    return {
      version: "execution-accounting-v1",
      tokenStatus:
        value?.totalTokens !== null &&
        value !== null &&
        terminal &&
        !issues.some((issue) =>
          [
            "model_limit",
            "cumulative_usage_regressed",
            "prompt_scope_only",
            "missing_model_usage",
          ].includes(issue),
        )
          ? "complete"
          : value || this.result || this.prompt || this.responses.size
            ? "partial"
            : "unavailable",
      source: this.resultTotals
        ? "claude-sdk-model-usage"
        : !this.result && this.promptTotals
          ? "acp-prompt-usage"
          : null,
      totals: value,
      observedModelResponses:
        this.responses.size && !issues.includes("response_limit") ? this.responses.size : null,
      transportAttempts: null,
      models: [...this.models].sort(),
      reportedCost: this.cost,
      issues,
      receipts: [
        ...this.responses.values(),
        ...(this.result ? [this.result] : []),
        ...(this.prompt ? [this.prompt] : []),
      ],
    };
  }
}

export function accountingUsage(accounting: ExecutionAccounting): ExecutionUsage | null {
  if (!accounting.totals) return null;
  return {
    inputTokens: accounting.totals.inputTokens,
    outputTokens: accounting.totals.outputTokens,
    costAmount: null,
    costCurrency: null,
    priceRef: null,
  };
}
