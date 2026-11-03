import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionRound } from "../src/ExecutionRound";
import { ToolCalls } from "../src/RunObservability";
import type { Activity, Work } from "../../src/app/workbench/contracts";
const work: Work = {
  id: "run",
  conversationId: "conversation",
  turnId: "turn",
  projectId: "project",
  goal: "test",
  mode: "read",
  executor: "codex",
  snapshotId: "snapshot",
  inputDir: "/tmp",
  baseline: {},
  testCommand: [],
  createdAt: 0,
};
const activity: Activity[] = [
  {
    id: 1,
    runId: "run",
    at: 1000,
    kind: "tool",
    text: "读取 README.md",
    data: { toolCallId: "read", status: "in_progress", input: "<script>alert(1)</script>" },
  },
  {
    id: 2,
    runId: "run",
    at: 2000,
    kind: "tool",
    text: "",
    data: { toolCallId: "read", status: "completed", output: "ok" },
  },
];
afterEach(() => vi.unstubAllGlobals());
describe("execution round rendering", () => {
  it("renders one collapsed summary with metrics and accessible inspection controls", () => {
    const html = renderToStaticMarkup(
      <ExecutionRound
        work={work}
        activities={activity}
        state="succeeded"
        onFile={() => false}
        onInspect={() => {}}
      />,
    );
    expect(html).toContain("执行完成");
    expect(html).toContain("1 次工具调用");
    expect(html).toContain("Token 未报告");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("最近工具调用（最新在前）");
    expect(html).not.toContain("round-detail-scroll");
    expect(html).not.toContain("alert(1)");
  });
  it("does not label waiting, failed, or cancelled runs as completed", () => {
    for (const [state, label] of [
      ["waiting", "等待处理"],
      ["failed", "执行失败"],
      ["cancelled", "已停止"],
    ]) {
      const html = renderToStaticMarkup(
        <ExecutionRound
          work={work}
          activities={[]}
          state={state!}
          onFile={() => false}
          onInspect={() => {}}
        />,
      );
      expect(html).toContain(label);
      expect(html).not.toContain("执行完成");
      expect(html).toContain("没有记录到工具调用");
    }
  });
  it("limits the summary route but preserves every call in the tools view", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...activity[0]!,
      id: i,
      data: { toolCallId: `t-${i}`, status: "completed" },
    }));
    const html = renderToStaticMarkup(
      <ExecutionRound
        work={work}
        activities={many}
        state="succeeded"
        onFile={() => false}
        onInspect={() => {}}
      />,
    );
    expect(html).toContain("前 7 次");
    expect(html.match(/class="route-step"/g) ?? []).toHaveLength(5);
    const tools = renderToStaticMarkup(<ToolCalls activities={many} compact />);
    expect(tools.match(/class="tool-call"/g) ?? []).toHaveLength(12);
  });
  it("shows live tools automatically and keeps the newest call in a long route", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...activity[0]!,
      id: i,
      text: `tool ${i}`,
      data: { toolCallId: `t-${i}`, status: i === 7 ? "in_progress" : "completed" },
    }));
    const html = renderToStaticMarkup(
      <ExecutionRound
        work={work}
        activities={many}
        state="running"
        onFile={() => false}
        onInspect={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("round-detail-scroll");
    expect(html).toContain('title="tool 7 · 执行中"');
    expect(html).not.toContain('title="tool 0 · 完成"');
    expect(html.match(/class="tool-call"/g) ?? []).toHaveLength(8);
  });
  it("honors an explicitly collapsed live panel instead of reopening on activity", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "" });
    const html = renderToStaticMarkup(
      <ExecutionRound
        work={work}
        activities={activity}
        state="running"
        onFile={() => false}
        onInspect={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("round-detail-scroll");
    expect(html).toContain("Trace 2");
  });
  it("opens the chosen call while retaining the compact list", () => {
    const html = renderToStaticMarkup(
      <ToolCalls activities={activity} compact selectedId="read" />,
    );
    expect(html).toContain('class="tool-call" open=""');
    expect(html).toContain("读取 README.md");
  });
  it("marks partial usage and dropped coverage without hiding a reported zero", () => {
    const evidence: Work["evidence"] = {
      version: "execution-evidence-v1",
      adapter: "test",
      trace: {
        status: "partial",
        coverage: "agent-events",
        events: [],
        droppedEvents: 0,
        detail: null,
      },
      usage: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      accounting: {
        version: "execution-accounting-v1",
        tokenStatus: "partial",
        source: "acp-prompt-usage",
        totals: {
          uncachedInputTokens: 0,
          cachedReadTokens: null,
          cachedWriteTokens: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        observedModelResponses: 0,
        transportAttempts: null,
        models: [],
        reportedCost: null,
        issues: [],
        receipts: [],
      },
    };
    const html = renderToStaticMarkup(
      <ExecutionRound
        work={{ ...work, evidence, activityDropped: 2 }}
        activities={[]}
        state="failed"
        onFile={() => false}
        onInspect={() => {}}
      />,
    );
    expect(html).toContain("0 Token（部分）");
    expect(html).toContain("2 条公开活动未保留");
  });
  it("keeps one tool row, input/output and safely escaped details", () => {
    const html = renderToStaticMarkup(<ToolCalls activities={activity} compact />);
    expect(html.match(/class="tool-call"/g) ?? []).toHaveLength(1);
    expect(html).toContain("完成");
    expect(html).toContain("输入");
    expect(html).toContain("输出");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
