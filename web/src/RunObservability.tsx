import type { Activity, Work } from "../../src/app/workbench/contracts";

export type Conversation = {
  truncated: boolean;
  turns: { id: string; goal: string; summary: string | null; state?: string; createdAt: number }[];
};
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
const statusName: Record<string, string> = {
  pending: "待处理",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
};
export function ToolCalls({
  activities,
  compact = false,
}: {
  activities: Activity[];
  compact?: boolean;
}) {
  const tools = new Map<
    string,
    { title: string; data: NonNullable<Activity["data"]>; start: number; end: number }
  >();
  for (const event of activities) {
    if (event.kind !== "tool" || !event.data?.toolCallId) continue;
    const existing = tools.get(event.data.toolCallId);
    const patch = Object.fromEntries(
      Object.entries(event.data).filter(([, value]) => value !== undefined),
    );
    tools.set(event.data.toolCallId, {
      title: event.text || existing?.title || "工具调用",
      data: {
        ...existing?.data,
        ...patch,
        truncated: !!(existing?.data.truncated || event.data.truncated),
      },
      start: existing?.start ?? event.at,
      end: event.at,
    });
  }
  return (
    <>
      {!compact && <h3>工具调用 · {tools.size}</h3>}
      {!tools.size && <p>尚无工具事件。旧任务不会补造缺失的事件。</p>}
      {[...tools].map(([id, tool]) => (
        <details className="tool-call" key={id}>
          <summary>
            <span>{tool.title}</span>
            <small>{statusName[tool.data.status ?? ""] ?? tool.data.status ?? "状态未知"}</small>
          </summary>
          <p>
            {tool.data.toolKind ?? "tool"} · 观测跨度 {((tool.end - tool.start) / 1000).toFixed(1)}{" "}
            秒
          </p>
          <code>{id}</code>
          <h4>输入</h4>
          <pre>{tool.data.input ?? "执行器未报告"}</pre>
          <h4>输出</h4>
          <pre>{tool.data.output ?? "执行器未报告"}</pre>
          {tool.data.truncated && <p>内容已截断。</p>}
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
      <h3>Token 与用量</h3>
      <span className="badge">
        {accounting?.tokenStatus === "complete"
          ? "报告完整"
          : accounting?.tokenStatus === "partial"
            ? "部分报告"
            : "尚无可靠报告"}
      </span>
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
        <details>
          <summary>计量说明</summary>
          <pre>{accounting.issues.join("\n")}</pre>
        </details>
      )}
    </>
  );
}
export function Trace({ work, activities }: { work: Work; activities: Activity[] }) {
  const evidence = work.evidence;
  return (
    <>
      <h3>执行 Trace</h3>
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
      <ol className="trace-list">
        {(
          evidence?.trace.events ??
          activities.map((event) => ({
            kind: event.kind,
            at: event.at,
            data: { text: event.text, ...event.data },
          }))
        ).map((event, index) => (
          <li key={index}>
            <time>{new Date(event.at).toLocaleTimeString()}</time>
            <b>{event.kind}</b>
            <details>
              <summary>事件详情</summary>
              <pre>{JSON.stringify(event.data, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
      <p className="note">公开执行轨迹，不含私有推理；协议未报告的内部重试与子调用不可见。</p>
    </>
  );
}
