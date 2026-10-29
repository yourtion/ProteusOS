import { expect, it } from "vitest";
import { publicEvent } from "../../src/adapters/executor-acp/public-event.ts";

it("projects tool updates without inventing missing fields and bounds/redacts details", () => {
  const event = publicEvent({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Read file",
    status: "in_progress",
    rawInput: { path: "a.ts", apiKey: "PRIVATE", nested: { authorization: "SECRET" } },
    rawOutput: { text: "x".repeat(12000) },
  });
  expect(event?.kind).toBe("tool");
  expect(event?.data?.truncated).toBe(true);
  expect(JSON.stringify(event)).not.toContain("PRIVATE");
  expect(JSON.stringify(event)).not.toContain("SECRET");
  expect(event?.data?.input).toContain("a.ts");
  const update = publicEvent({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
  });
  expect(update?.data?.input).toBeUndefined();
  expect(update?.text).toBe("");
});
it("excludes reasoning and labels context separately from consumption", () => {
  expect(
    publicEvent({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private" },
    }),
  ).toBeNull();
  expect(publicEvent({ sessionUpdate: "usage_update", used: 123, size: 10000 })).toMatchObject({
    kind: "context",
    data: { used: 123, size: 10000 },
  });
});
