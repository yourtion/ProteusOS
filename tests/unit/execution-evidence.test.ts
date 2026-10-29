import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutionTrace,
  boundedOutput,
  EXECUTION_OUTPUT_LIMIT,
  executionInputDigest,
} from "../../src/runtime/execution-evidence.ts";

describe("有界执行证据", () => {
  it("terminal is retained even when the event buffer is exhausted", () => {
    const trace = new ExecutionTrace(2);
    trace.appendMessage("a".repeat(4001));
    trace.recordTerminal("session.completed", { stopReason: "end_turn" });
    const evidence = trace.finish("fixture", "agent-events", true);
    expect(evidence.trace).toMatchObject({ status: "partial", droppedEvents: 2 });
    expect(evidence.trace.events.at(-1)?.kind).toBe("session.completed");
  });
  it("事件溢出和文本截断明确标为 partial，已返回快照不受迟到事件影响", () => {
    const trace = new ExecutionTrace(2);
    trace.record("message", { text: "x".repeat(3000) });
    trace.record("tool", { id: "one" });
    trace.record("tool", { id: "dropped" });
    const first = trace.finish("test-v1", "agent-events", true);
    expect(first.trace).toMatchObject({
      status: "partial",
      droppedEvents: 1,
      detail: "event_text_truncated",
    });
    expect(first.trace.events[0]?.data.text).toHaveLength(2000);
    trace.record("late");
    expect(first.trace.events).toHaveLength(2);
    expect(first.trace.droppedEvents).toBe(1);
    expect(first.usage).toBeNull();
  });

  it("输出保留有界尾部并报告截断，不能冒充完整 stdout", () => {
    const captured = boundedOutput("x".repeat(EXECUTION_OUTPUT_LIMIT), "end");
    expect(captured.truncated).toBe(true);
    expect(captured.text).toHaveLength(EXECUTION_OUTPUT_LIMIT);
    expect(captured.text.endsWith("end")).toBe(true);
    const trace = new ExecutionTrace().finish("test", "lifecycle", true, { stdoutTruncated: true });
    expect(trace.trace.status).toBe("partial");
  });

  it("输入指纹与目录位置无关，内容与相对文件名改变会改变指纹", () => {
    const root = mkdtempSync(join(tmpdir(), "proteus-input-digest-"));
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "file.txt"), "same");
    writeFileSync(join(b, "file.txt"), "same");
    expect(executionInputDigest(a)).toBe(executionInputDigest(b));
    writeFileSync(join(b, "file.txt"), "different");
    expect(executionInputDigest(a)).not.toBe(executionInputDigest(b));
    writeFileSync(join(b, "file.txt"), "same");
    renameSync(join(b, "file.txt"), join(b, "renamed.txt"));
    expect(executionInputDigest(a)).not.toBe(executionInputDigest(b));
    renameSync(join(b, "renamed.txt"), join(b, "file.txt"));
    mkdirSync(join(b, "empty-directory"));
    expect(executionInputDigest(a)).not.toBe(executionInputDigest(b));
  });
});
