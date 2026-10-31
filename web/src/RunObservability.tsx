import type { Conversation } from "./models";
import { EmptyState, EvidenceDetails, StatusBadge } from "./ui";
import { collectTools, duration, toolStatus } from "./execution-view";
import type { Activity, Work } from "../../src/app/workbench/contracts";

export function ConversationHistory({
  conversation,
  currentId,
}: {
  conversation: Conversation;
  currentId?: string;
}) {
  const previous = conversation.turns.filter((turn) => turn.id !== currentId);
  if (!previous.length) return null;
  return (
    <details className="conversation-history">
      <summary>前文 · {previous.length} 轮</summary>
      <p className="note">每轮建立新的 ACP 会话，携带最近历史摘要与上一轮文件结果。</p>
      {conversation.truncated && <p className="note">仅显示最近 30 轮。</p>}
      {previous.map((turn) => (
        <article key={turn.id}>
          <p className="user-turn">{turn.goal}</p>
          <p className="assistant-turn">{turn.summary ?? "该轮尚无总结"}</p>
        </article>
      ))}
    </details>
  );
}
export function ToolCalls({
  activities,
  compact = false,
  selectedId,
}: {
  activities: Activity[];
  compact?: boolean;
  selectedId?: string;
}) {
  const tools = collectTools(activities);
  return (
    <>
      {!compact && <h2>工具调用 · {tools.length}</h2>}
      {!tools.length && (
        <EmptyState title="尚无工具事件" description="执行器未报告的调用不会补造。" />
      )}
      {tools.map((tool) => (
        <details
          className="tool-call"
          key={tool.id}
          open={selectedId === tool.id ? true : undefined}
        >
          <summary>
            <span className={`tool-state ${tool.data.status ?? "unknown"}`} aria-hidden="true">
              {tool.data.status === "completed" ? "✓" : tool.data.status === "failed" ? "!" : "·"}
            </span>
            <span className="tool-title">{tool.title}</span>
            <small>{toolStatus[tool.data.status ?? ""] ?? tool.data.status ?? "状态未知"}</small>
            <span className="tool-duration" title="首末工具事件的观测跨度">
              {duration(tool.end - tool.start)}
            </span>
          </summary>
          <div className="tool-detail">
            <p className="tool-identity">
              {tool.data.toolKind ?? "tool"} · {tool.id}
            </p>
            <div className="tool-io">
              <section>
                <h4>输入</h4>
                <pre>{tool.data.input ?? "执行器未报告"}</pre>
              </section>
              <section>
                <h4>输出</h4>
                <pre>{tool.data.output ?? "执行器未报告"}</pre>
              </section>
            </div>
            {tool.data.truncated && <p className="note">内容已截断。</p>}
          </div>
        </details>
      ))}
      {!compact && (
        <p className="note">仅展示协议公开事件；常见凭据字段已遮蔽，正文仍可能包含项目内容。</p>
      )}
    </>
  );
}
const number = (value: number | null | undefined) =>
  value == null ? "未知" : value.toLocaleString();
export function Usage({ work, activities }: { work: Work; activities: Activity[] }) {
  const accounting = work.evidence?.accounting;
  const totals = accounting?.totals;
  const context = activities.filter((event) => event.kind === "context").at(-1)?.data;
  return (
    <>
      <h2>Token 与用量</h2>
      <StatusBadge
        tone={
          accounting?.tokenStatus === "complete"
            ? "success"
            : accounting?.tokenStatus === "partial"
              ? "warning"
              : "neutral"
        }
      >
        {accounting?.tokenStatus === "complete"
          ? "报告完整"
          : accounting?.tokenStatus === "partial"
            ? "部分报告"
            : "尚无可靠报告"}
      </StatusBadge>
      <dl className="usage-grid">
        {(
          [
            ["输入（含缓存）", totals?.inputTokens],
            ["输出", totals?.outputTokens],
            ["缓存读取", totals?.cachedReadTokens],
            ["缓存写入", totals?.cachedWriteTokens],
            ["未缓存输入", totals?.uncachedInputTokens],
            ["合计", totals?.totalTokens],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{number(value)}</dd>
          </div>
        ))}
      </dl>
      <p>来源：{accounting?.source ?? "执行器未提供可核对的消耗报告"}</p>
      <p>模型：{accounting?.models.join(", ") || "未知"}</p>
      {accounting?.reportedCost && (
        <p>
          SDK 估计费用：{accounting.reportedCost.amount} {accounting.reportedCost.currency}
          （未核对账单）
        </p>
      )}
      <h3>上下文占用</h3>
      <p>
        {number(context?.used)} / {number(context?.size)}
      </p>
      <p className="note">
        上下文占用不是累计消耗；缺失用量不算作零。不同轮次的缓存和上下文不直接相加。
      </p>
      {!!accounting?.issues.length && (
        <EvidenceDetails title="计量说明">
          <pre className="data-block">{accounting.issues.join("\n")}</pre>
        </EvidenceDetails>
      )}
    </>
  );
}
export function Trace({ work, activities }: { work: Work; activities: Activity[] }) {
  const evidence = work.evidence;
  const events =
    evidence?.trace.events ??
    activities.map((event) => ({
      kind: event.kind,
      at: event.at,
      data: { text: event.text, ...event.data },
    }));
  return (
    <>
      <h2>执行 Trace</h2>
      <p>
        Run <code>{work.id}</code>
      </p>
      <p>
        状态：{evidence?.trace.status ?? "尚无终态证据"} · 覆盖：
        {evidence?.trace.coverage ?? "实时公开事件"}
      </p>
      <p>
        公开活动丢弃：{work.activityDropped ?? 0} · 适配器轨迹丢弃：
        {evidence?.trace.droppedEvents ?? 0}
      </p>
      {work.progress && (
        <p>
          {work.progress.phase} · 已用 {(work.progress.elapsedMs / 1000).toFixed(1)} 秒 · 已观察{" "}
          {work.progress.toolCalls} 次工具调用
        </p>
      )}
      {!events.length && (
        <EmptyState title="尚无轨迹事件" description="执行器公开的事件会显示在这里。" />
      )}
      <ol className="trace-list">
        {events.map((event, index) => (
          <li key={index}>
            <time>{new Date(event.at).toLocaleTimeString()}</time>
            <b>{event.kind}</b>
            <EvidenceDetails title="事件详情" value={event.data} />
          </li>
        ))}
      </ol>
      <p className="note">公开执行轨迹，不含私有推理；协议未报告的内部重试与子调用不可见。</p>
    </>
  );
}
