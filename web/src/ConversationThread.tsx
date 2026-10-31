import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { Activity, Work } from "../../src/app/workbench/contracts";
import { ExecutionRound } from "./ExecutionRound";
import type { Conversation } from "./models";
import { Markdown } from "./Markdown";
const positions = new Map<string, number>();
export function ConversationThread({
  work,
  conversation,
  activities,
  running,
  onFile,
  state,
  onInspect,
}: {
  state: string;
  onInspect: (tab: "trace" | "usage") => void;
  work: Work;
  conversation: Conversation;
  activities: Activity[];
  running: boolean;
  onFile: (path: string) => boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
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
      <ExecutionRound
        work={work}
        activities={activities}
        state={state}
        onFile={onFile}
        onInspect={onInspect}
      />
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
