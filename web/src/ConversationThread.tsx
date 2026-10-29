import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { Activity, Work } from "../../src/app/workbench/contracts";
import { projectTranscript } from "../../src/app/workbench/transcript";
import { ToolCalls, type Conversation } from "./RunObservability";
import { Markdown } from "./Markdown";
const positions = new Map<string, number>();
export function ConversationThread({
  work,
  conversation,
  activities,
  running,
  onFile,
}: {
  work: Work;
  conversation: Conversation;
  activities: Activity[];
  running: boolean;
  onFile: (path: string) => boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    const saved = sessionStorage.getItem(`proteus-process-${work.id}`);
    return saved === null ? running : saved === "true";
  });
  const nodes = projectTranscript(activities);
  useLayoutEffect(() => {
    const cached = sessionStorage.getItem(`proteus-scroll-${work.id}`);
    const saved = positions.get(work.id) ?? (cached === null ? undefined : Number(cached));
    if (saved !== undefined) window.scrollTo(0, saved);
    else if (running) end.current?.scrollIntoView({ block: "end" });
    else window.scrollTo(0, 0);
    follow.current = saved === undefined && running;
    const onScroll = () => {
      positions.set(work.id, window.scrollY);
      sessionStorage.setItem(`proteus-scroll-${work.id}`, String(window.scrollY));
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
      const near = (end.current?.getBoundingClientRect().bottom ?? 0) <= window.innerHeight + 100;
      follow.current = near;
      setAway(!near);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [work.id]);
  useEffect(() => {
    if (running && follow.current) end.current?.scrollIntoView({ block: "end" });
  }, [activities, running]);
  return (
    <div className="conversation-thread">
      {conversation.truncated && (
        <p className="note">显示最近 30 轮历史。当前执行使用有界历史摘要。</p>
      )}
      {conversation.turns
        .filter((turn) => turn.id !== work.id)
        .map((turn) => (
          <section className="history-turn" key={turn.id}>
            <p className="message-label">你 · {new Date(turn.createdAt).toLocaleString()}</p>
            <div className="user-turn">{turn.goal}</div>
            <p className="message-label">助手 · 历史总结</p>
            <Markdown text={turn.summary ?? "该轮尚无总结"} />
          </section>
        ))}
      <p className="message-label">你</p>
      <div className="user-turn">{work.goal}</div>
      <p className="message-label">助手{running ? " · 正在执行" : ""}</p>
      <details
        className="thread-process"
        open={expanded}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setExpanded(open);
          sessionStorage.setItem(`proteus-process-${work.id}`, String(open));
        }}
      >
        <summary>
          {running ? "正在处理" : "查看执行过程"} · {nodes.length} 项
        </summary>
        {nodes.map((node) => (
          <div className="thread-node" key={node.id}>
            {node.kind === "tool" ? (
              <ToolCalls activities={node.activities} compact />
            ) : (
              <>
                <span className="message-label">{node.kind === "plan" ? "计划" : "进度"}</span>
                <Markdown text={node.text} onFile={onFile} />
              </>
            )}
          </div>
        ))}
      </details>
      {work.result && (
        <>
          <Markdown text={work.result.summary || "执行器未提供总结。"} onFile={onFile} />
          <p className="note">
            {work.result.checks.tested
              ? work.result.checks.passed
                ? "自动检查通过"
                : "自动检查失败"
              : "本次未运行自动测试；执行完成不代表代码正确。"}
          </p>
        </>
      )}
      {!!work.activityDropped && <p className="note">公开活动达到保存上限，部分过程未保留。</p>}
      <div ref={end} />
      {away && running && (
        <button
          className="jump-latest"
          onClick={() => {
            follow.current = true;
            setAway(false);
            end.current?.scrollIntoView({ block: "end" });
          }}
        >
          回到最新进度 ↓
        </button>
      )}
    </div>
  );
}
