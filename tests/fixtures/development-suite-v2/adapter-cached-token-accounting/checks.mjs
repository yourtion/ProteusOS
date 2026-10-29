import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const target = process.argv[2];
if (!target)
  throw new Error("Usage: node checks.mjs /absolute/path/to/src/adapters/decision-llm/index.ts");
const { LlmDecisionProvider } = await import(pathToFileURL(target).href);
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}
const request = {
  problem: "choice",
  options: ["local-process"],
  context: {},
  policy: {
    versionId: "frozen-test-policy",
    content: {
      kind: "llm-choice-v1",
      service: "anthropic-messages",
      model: "offline-test-model",
      sampling: { temperature: 0, maxOutputTokens: 256 },
      promptTemplate: "{{OPTIONS}}\n{{VIEW}}",
      responseSchema: { accept: ["value", "abstain"] },
    },
  },
  deadlineMs: 123456,
  remainingAttempts: 1,
  view: {
    viewVersion: "decision-view-v1",
    goal: "Offline deterministic accounting test",
    options: [{ id: "local-process", description: "compute locally" }],
    inputs: [],
    features: {},
  },
};
async function account(usage, responseFields = {}) {
  // Exercise only the public constructor and decide method. A scoped in-memory
  // Fetch implementation serves a complete SDK response; no socket is opened.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.ok(String(url).startsWith("http://127.0.0.1:1/offline-no-network/"));
    const body = JSON.parse(init.body);
    assert.equal(body.model, "offline-test-model");
    return new Response(
      JSON.stringify({
        id: "offline-message",
        type: "message",
        role: "assistant",
        model: "offline-served-model",
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"kind":"value","value":"local-process"}' }],
        usage,
        ...responseFields,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const provider = new LlmDecisionProvider({
      apiKey: "offline-placeholder",
      baseUrl: "http://127.0.0.1:1/offline-no-network",
    });
    const result = await provider.decide(request);
    assert.equal(calls, 1);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
await check("regression: uncached valid usage and choice remain unchanged", async () => {
  const result = await account({ input_tokens: 42, output_tokens: 7 });
  assert.equal(result.kind, "value");
  assert.equal(result.value, "local-process");
  assert.deepEqual(result.evidence, {
    inputTokens: 42,
    outputTokens: 7,
    servedModel: "offline-served-model",
  });
});
await check("bug: cached reads and cache creation count toward consumed input", async () => {
  const result = await account({
    input_tokens: 11,
    cache_read_input_tokens: 170,
    cache_creation_input_tokens: 29,
    output_tokens: 8,
  });
  assert.equal(result.evidence.inputTokens, 210);
  assert.equal(result.evidence.outputTokens, 8);
});
await check("bug: fully cached request still has nonzero consumed input", async () => {
  const result = await account({
    input_tokens: 0,
    cache_read_input_tokens: 2048,
    output_tokens: 1,
  });
  assert.equal(result.evidence.inputTokens, 2048);
});
await check("bug: invalid negative, fractional or unsafe token values become unknown", async () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await account({ input_tokens: invalid, output_tokens: invalid });
    assert.equal(result.evidence.inputTokens, null);
    assert.equal(result.evidence.outputTokens, null);
  }
});
await check("bug: malformed cache component and unsafe summed input become unknown", async () => {
  for (const usage of [
    { input_tokens: 5, cache_read_input_tokens: -1, output_tokens: 2 },
    { input_tokens: 5, cache_creation_input_tokens: "10", output_tokens: 2 },
    { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, output_tokens: 2 },
  ])
    assert.equal((await account(usage)).evidence.inputTokens, null);
});
await check(
  "regression: missing usage remains unknown while explicit zero stays zero",
  async () => {
    assert.deepEqual((await account(undefined)).evidence, {
      inputTokens: null,
      outputTokens: null,
      servedModel: "offline-served-model",
    });
    assert.deepEqual((await account({ input_tokens: 0, output_tokens: 0 })).evidence, {
      inputTokens: 0,
      outputTokens: 0,
      servedModel: "offline-served-model",
    });
  },
);
await check(
  "regression: refusal keeps service origin and independently measured usage",
  async () => {
    const result = await account(
      { input_tokens: 20, output_tokens: 0 },
      { stop_reason: "refusal", content: [] },
    );
    assert.equal(result.kind, "abstain");
    assert.equal(result.origin, "service_refusal");
    assert.deepEqual(result.evidence, {
      inputTokens: 20,
      outputTokens: 0,
      servedModel: "offline-served-model",
    });
  },
);
const summary = {
  passed: results.every((r) => r.passed),
  failed: results.filter((r) => !r.passed).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed ? 1 : 0;
