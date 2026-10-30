import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiExecutor } from "../../src/adapters/executor-pi/index.ts";

const sdk = vi.hoisted(() => {
  const state = { listener: (_event: Record<string, unknown>) => {} };
  return {
    state,
    prompt: vi.fn(),
    abort: vi.fn(async () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
    stats: vi.fn(() => ({ tokens: { input: 12, output: 5 }, cost: 0.5 })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: { create: vi.fn() },
  createAgentSession: async () => ({
    session: {
      prompt: sdk.prompt,
      abort: sdk.abort,
      dispose: sdk.dispose,
      getSessionStats: sdk.stats,
      subscribe: (listener: (event: Record<string, unknown>) => void) => {
        sdk.state.listener = listener;
        return sdk.unsubscribe;
      },
    },
  }),
}));

const request = {
  runId: "run",
  processId: "process",
  attemptId: "attempt",
  workspaceDir: "/tmp",
  prompt: "test",
  timeoutMs: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pi 执行观测合同", () => {
  it("采集公开工具/文本和 SDK tokens，隐藏推理及无币种价格依据的 cost 不作为证据", async () => {
    sdk.prompt.mockImplementation(async () => {
      sdk.state.listener({
        type: "tool_execution_start",
        toolCallId: "tool",
        toolName: "read",
        args: { token: "private-args" },
      });
      sdk.state.listener({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "HIDDEN-THOUGHT-MARKER" },
            { type: "text", text: "public-result" },
          ],
        },
      });
      sdk.state.listener({
        type: "tool_execution_end",
        toolCallId: "tool",
        toolName: "read",
        isError: false,
      });
    });
    const result = await new PiExecutor().start(request);
    expect(result.evidence).toMatchObject({
      trace: { status: "complete", coverage: "agent-events" },
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        costAmount: null,
        costCurrency: null,
        priceRef: null,
      },
    });
    expect(JSON.stringify(result.evidence)).toContain("public-result");
    expect(JSON.stringify(result.evidence)).not.toContain("HIDDEN-THOUGHT-MARKER");
    expect(JSON.stringify(result.evidence)).not.toContain("private-args");
    expect(sdk.unsubscribe).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("超时保留 partial 轨迹，迟到事件不修改已返回证据", async () => {
    sdk.prompt.mockImplementation(async () => {
      sdk.state.listener({ type: "tool_execution_start", toolCallId: "tool", toolName: "write" });
      await new Promise(() => {});
    });
    const result = await new PiExecutor().start({ ...request, timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.evidence!.trace.status).toBe("partial");
    const before = JSON.stringify(result.evidence);
    sdk.state.listener({
      type: "tool_execution_end",
      toolCallId: "tool",
      toolName: "write",
      isError: false,
    });
    expect(JSON.stringify(result.evidence)).toBe(before);
    expect(sdk.unsubscribe).toHaveBeenCalledOnce();
  });
});

it("Pi 取消传到 SDK，公开事件进入工作台且不暴露隐藏推理", async () => {
  sdk.prompt.mockImplementation(async () => {
    sdk.state.listener({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET" },
          { type: "text", text: "visible" },
        ],
      },
    });
    await new Promise(() => {});
  });
  const controller = new AbortController();
  const events = vi.fn();
  const promise = new PiExecutor().start({
    ...request,
    signal: controller.signal,
    onEvent: events,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await promise;
  expect(result.ok).toBe(false);
  expect(sdk.abort).toHaveBeenCalledOnce();
  expect(events).toHaveBeenCalledWith({ kind: "message", text: "visible" });
  expect(JSON.stringify(events.mock.calls)).not.toContain("SECRET");
});
