import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import type { ExecutionProgress } from "../../src/runtime/execution-evidence.ts";

it("1000 streamed chunks retain later tools and terminal, emit live progress, and deduplicate numeric receipts", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "proteus-observation-"));
  const executor = new AcpExecutor({
    name: "fixture",
    agentEntry: fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url)),
    captureClaudeUsage: true,
  });
  const progress: ExecutionProgress[] = [];
  let liveJournal = "";
  const result = await executor.start({
    runId: "r",
    processId: "p",
    attemptId: "a",
    workspaceDir,
    prompt: "ACCOUNTING-MODE",
    timeoutMs: 5000,
    onProgress(event) {
      progress.push(event);
      if (event.phase === "tool")
        liveJournal = readFileSync(join(workspaceDir, ".proteus/acp-events.jsonl"), "utf8");
      throw new Error("broken display must not abort execution");
    },
  });
  expect(result.ok).toBe(true);
  expect(progress[0]?.phase).toBe("connecting");
  expect(progress.at(-1)).toMatchObject({ phase: "completed", messageChars: 4000, toolCalls: 1 });
  expect(liveJournal).toContain("late-tool");
  expect(liveJournal).not.toContain("session.completed");
  expect(result.evidence?.trace).toMatchObject({ status: "complete", droppedEvents: 0 });
  expect(result.evidence?.trace.events.at(-1)?.kind).toBe("session.completed");
  expect(
    result.evidence?.trace.events
      .filter((e) => e.kind === "message")
      .map((e) => e.data.text)
      .join(""),
  ).toBe("text".repeat(1000));
  expect(result.evidence?.accounting).toMatchObject({
    tokenStatus: "complete",
    source: "claude-sdk-model-usage",
    observedModelResponses: 1,
    transportAttempts: null,
    totals: {
      uncachedInputTokens: 10,
      cachedReadTokens: 30,
      cachedWriteTokens: 40,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    },
    reportedCost: { amount: 0.012, verified: false },
  });
  expect(result.evidence?.usage?.costAmount).toBeNull();
  const journal = readFileSync(join(workspaceDir, ".proteus/acp-events.jsonl"), "utf8");
  const trace = readFileSync(join(workspaceDir, ".proteus/acp-trace.json"), "utf8");
  expect(JSON.stringify(result) + journal + trace).not.toContain("PRIVATE-SDK-CONTENT");
  expect(JSON.parse(trace).progressFailures).toBeGreaterThan(0);
});
