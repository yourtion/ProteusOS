// Post-hoc semantic compatibility checks. Never replaces the frozen v2 checks.
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

for (const [name, usage, inputTokens] of [
  [
    "null cache read preserves measured core input",
    { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: null },
    5,
  ],
  [
    "null cache creation preserves measured core input",
    { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: null },
    5,
  ],
  [
    "both null cache fields preserve explicit zero",
    {
      input_tokens: 0,
      output_tokens: 2,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    0,
  ],
  [
    "null read and numeric creation still count creation",
    {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: 7,
    },
    12,
  ],
  [
    "numeric read and null creation still count read",
    {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: null,
    },
    12,
  ],
  [
    "null core input remains unknown",
    { input_tokens: null, output_tokens: 2, cache_read_input_tokens: null },
    null,
  ],
]) {
  await check(name, async () => {
    const result = await account(usage);
    assert.equal(result.kind, "value");
    assert.equal(result.evidence.inputTokens, inputTokens);
    assert.equal(result.evidence.outputTokens, 2);
  });
}
const summary = { passed: results.every((r) => r.passed), results };
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.passed ? 0 : 1;
