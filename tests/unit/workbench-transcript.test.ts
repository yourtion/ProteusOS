import { expect, it } from "vitest";
import { projectTranscript } from "../../src/app/workbench/transcript.ts";
import type { Activity } from "../../src/app/workbench/contracts.ts";
it("keeps tool identity and first position when status updates arrive between messages", () => {
  const events: Activity[] = [
    { id: 1, runId: "r", kind: "message", text: "hello", at: 1 },
    { id: 2, runId: "r", kind: "message", text: " world", at: 2 },
    {
      id: 3,
      runId: "r",
      kind: "tool",
      text: "Read",
      at: 3,
      data: { toolCallId: "t", status: "in_progress" },
    },
    { id: 4, runId: "r", kind: "message", text: "done", at: 4 },
    {
      id: 5,
      runId: "r",
      kind: "tool",
      text: "",
      at: 5,
      data: { toolCallId: "t", status: "completed" },
    },
    { id: 6, runId: "r", kind: "context", text: "usage", at: 6 },
  ];
  const nodes = projectTranscript(events);
  expect(nodes.map((n) => n.kind)).toEqual(["message", "tool", "message"]);
  expect(nodes[0]).toHaveProperty("text", "hello world");
  expect(nodes[1]).toHaveProperty("activities.length", 2);
  expect(events[0]?.text).toBe("hello");
  expect(projectTranscript(events)).toEqual(nodes);
});
