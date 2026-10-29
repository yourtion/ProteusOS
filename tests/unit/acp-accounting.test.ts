import { expect, it } from "vitest";
import { AcpAccounting } from "../../src/adapters/executor-acp/accounting.ts";
const result = (a: AcpAccounting, inputTokens: unknown = 10, extra = {}) =>
  a.observeSdk({
    message: {
      type: "result",
      modelUsage: {
        model: {
          inputTokens,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
        },
      },
      ...extra,
    },
  });

it("cumulative snapshots replace rather than add; regressions remain partial", () => {
  const a = new AcpAccounting(true);
  result(a);
  result(a, 15);
  expect(a.snapshot(true).totals?.totalTokens).toBe(105);
  expect(a.snapshot(true).tokenStatus).toBe("complete");
  expect(a.snapshot(false).tokenStatus).toBe("partial");
  result(a, 5);
  expect(a.snapshot(true).tokenStatus).toBe("partial");
  expect(a.snapshot(true).issues).toContain("cumulative_usage_regressed");
});

it.each([undefined, -1, NaN, Infinity, "10", Number.MAX_SAFE_INTEGER + 1])(
  "missing or invalid counters are unknown, not zero: %s",
  (value) => {
    const a = new AcpAccounting(true);
    result(a, value, {
      modelUsage: {
        model: {
          inputTokens: value,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
        },
      },
    });
    expect(a.snapshot(true)).toMatchObject({
      tokenStatus: "partial",
      totals: { uncachedInputTokens: null, inputTokens: null, totalTokens: null },
    });
  },
);

it("missing final model usage cannot reuse an earlier total or a zero-filled prompt", () => {
  const a = new AcpAccounting(true);
  result(a);
  a.observeSdk({ message: { type: "result" } });
  a.observeResponse({
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      totalTokens: 0,
    },
  });
  expect(a.snapshot(true)).toMatchObject({ tokenStatus: "partial", totals: null });
});

it("unsupported providers and context occupancy never become billing totals", () => {
  const a = new AcpAccounting(false);
  result(a);
  a.observeResponse({ used: 12345, cost: { amount: 1 } });
  expect(a.snapshot(true)).toMatchObject({
    tokenStatus: "unavailable",
    totals: null,
    observedModelResponses: null,
    reportedCost: null,
  });
  a.observeResponse({ usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
  expect(a.snapshot(true)).toMatchObject({ tokenStatus: "partial", totals: null });
});

it("prompt-only totals are explicitly narrower and retain cache semantics", () => {
  const a = new AcpAccounting(true);
  a.observeResponse({
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cachedReadTokens: 30,
      cachedWriteTokens: 40,
      totalTokens: 100,
    },
  });
  expect(a.snapshot(true)).toMatchObject({
    tokenStatus: "partial",
    source: "acp-prompt-usage",
    totals: { inputTokens: 80, totalTokens: 100 },
    issues: ["prompt_scope_only"],
  });
});
