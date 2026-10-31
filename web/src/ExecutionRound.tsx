import { browserSession } from "./session";
import { statusMeta } from "./ui/status";
import { Button, SelectionBar } from "./ui";
import { useId, useState } from "react";
import type { Activity, Work } from "../../src/app/workbench/contracts";
import { projectTranscript } from "../../src/app/workbench/transcript";
import { collectTools, duration, toolStatus } from "./execution-view";
import { ToolCalls } from "./RunObservability";
import { Markdown } from "./Markdown";

const eventNames: Record<string, string> = {
  queued: "排队",
  started: "开始",
  completed: "结束",
  tool: "工具",
  message: "消息",
  plan: "计划",
  context: "上下文",
  permission: "审批",
  verification: "检查",
  "test-output": "检查输出",
  error: "错误",
};
export function ExecutionRound({
  work,
  activities,
  state,
  onFile,
  onInspect,
}: {
  work: Work;
  activities: Activity[];
  state: string;
  onFile: (path: string) => boolean;
  onInspect: (tab: "trace" | "usage") => void;
}) {
  const regionId = useId();
  type View = "tools" | "trace" | "messages" | null;
  const [view, setCurrentView] = useState<View>(() => {
    try {
      const saved = browserSession.getItem(`proteus-process-view-${work.id}`);
      return saved === "tools" || saved === "trace" || saved === "messages" ? saved : null;
    } catch {
      return null;
    }
  });
  const [selectedTool, setSelectedTool] = useState<string>();
  function setView(next: View) {
    setCurrentView(next);
    try {
      browserSession.setItem(`proteus-process-view-${work.id}`, next ?? "");
    } catch {
      /* Optional UI preference. */
    }
  }
  const tools = collectTools(activities);
  const nodes = projectTranscript(activities).filter((node) => node.kind !== "tool");
  const token = work.evidence?.accounting;
  const total = token?.totals?.totalTokens;
  const live = state === "running" || state === "pending";
  const last = activities.at(-1);
  const span = activities.length > 1 ? Math.max(0, last!.at - activities[0]!.at) : undefined;
  const elapsed = work.progress?.elapsedMs ?? span;
  const failed = tools.filter((tool) => tool.data.status === "failed").length;
  const initialView = tools.length ? "tools" : "messages";
  return (
    <section className={`execution-round ${live ? "is-running" : ""}`} aria-label="本轮执行摘要">
      <div className="round-summary">
        <button
          type="button"
          className="round-disclosure"
          aria-expanded={view !== null}
          aria-controls={view ? regionId : undefined}
          onClick={() => setView(view ? null : initialView)}
        >
          <span className={`execution-dot tone-${statusMeta(state).tone}`} aria-hidden="true" />
          <strong>{statusMeta(state).label}</strong>
          <span className="round-chevron" aria-hidden="true">
            {view ? "⌄" : "›"}
          </span>
        </button>
        <div className="round-metrics">
          <span title="已记录的公开工具调用；未报告或丢失的调用不计入">
            {tools.length} 次工具调用
          </span>
          <span title="执行器报告的耗时，缺失时使用首末公开事件的观测跨度">
            观测 {duration(elapsed)}
          </span>
          <button type="button" onClick={() => onInspect("usage")}>
            {total == null
              ? "Token 未报告"
              : `${total.toLocaleString()} Token${token?.tokenStatus === "partial" ? "（部分）" : ""}`}
          </button>
          {failed > 0 && <span className="round-failure">{failed} 个失败</span>}
        </div>
        <button type="button" className="round-trace-link" onClick={() => onInspect("trace")}>
          Trace ↗
        </button>
      </div>
      <div className="round-route" aria-label="调用顺序">
        {tools.length ? (
          tools.slice(0, 5).map((tool, index) => (
            <span className="route-step" key={tool.id}>
              {index > 0 && (
                <span className="route-arrow" aria-hidden="true">
                  ›
                </span>
              )}
              <button
                type="button"
                title={`${tool.title} · ${toolStatus[tool.data.status ?? ""] ?? "状态未知"}`}
                onClick={() => {
                  setSelectedTool(tool.id);
                  setView("tools");
                }}
              >
                <span className={`tool-state ${tool.data.status ?? "unknown"}`} aria-hidden="true">
                  {tool.data.status === "completed"
                    ? "✓"
                    : tool.data.status === "failed"
                      ? "!"
                      : "·"}
                </span>
                <span>{tool.title}</span>
              </button>
            </span>
          ))
        ) : (
          <span className="round-empty">
            {live ? "等待执行器报告工具活动" : "没有记录到工具调用"}
          </span>
        )}
        {tools.length > 5 && (
          <button type="button" className="route-more" onClick={() => setView("tools")}>
            +{tools.length - 5} 次
          </button>
        )}
      </div>
      {live && last && (
        <p className="round-live" title={last.text}>
          {eventNames[last.kind] ?? last.kind} · {last.text || "正在更新执行状态"}
        </p>
      )}
      {view && (
        <div className="round-detail" id={regionId}>
          <div className="round-tabs">
            <SelectionBar
              label="执行详情分类"
              value={view}
              onChange={setView}
              options={[
                { value: "tools", label: `工具 ${tools.length}` },
                { value: "trace", label: `轨迹 ${activities.length}` },
                { value: "messages", label: `进度 ${nodes.length}` },
              ]}
            />
            <Button variant="ghost" className="round-collapse" onClick={() => setView(null)}>
              收起
            </Button>
          </div>
          <div className="round-detail-scroll">
            {view === "tools" && (
              <ToolCalls activities={activities} compact selectedId={selectedTool} />
            )}
            {view === "trace" && (
              <ol className="round-ledger">
                {activities.map((event) => (
                  <li key={event.id}>
                    <time title={new Date(event.at).toLocaleString()}>
                      +{duration(event.at - (activities[0]?.at ?? event.at))}
                    </time>
                    <span className="ledger-kind">{eventNames[event.kind] ?? event.kind}</span>
                    <details>
                      <summary>{event.text || event.data?.toolCallId || "状态更新"}</summary>
                      <pre>
                        {event.text}
                        {event.data ? `\n${JSON.stringify(event.data, null, 2)}` : ""}
                      </pre>
                    </details>
                  </li>
                ))}
              </ol>
            )}
            {view === "messages" &&
              (nodes.length ? (
                nodes.map((node) => (
                  <div className="round-message" key={node.id}>
                    <span>{node.kind === "plan" ? "计划" : "进度"}</span>
                    <Markdown text={node.text} onFile={onFile} />
                  </div>
                ))
              ) : (
                <p className="note">没有记录到公开进度消息。</p>
              ))}
          </div>
        </div>
      )}
      {!!work.activityDropped && (
        <p className="round-coverage">
          有 {work.activityDropped} 条公开活动未保留；此处不是完整轨迹。
        </p>
      )}
    </section>
  );
}
