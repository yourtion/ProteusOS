import { browserSession } from "./session";
import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react";
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
  actions,
  attention,
}: {
  actions?: ReactNode;
  attention?: ReactNode;
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
    const cached = browserSession.getItem(`proteus-scroll-${work.id}`);
    const saved = positions.get(work.id) ?? (cached === null ? undefined : Number(cached));
    if (saved !== undefined && Number.isFinite(saved) && saved >= 0) window.scrollTo(0, saved);
    else if (running) end.current?.scrollIntoView({ block: "end" });
    else window.scrollTo(0, 0);
    const near = (end.current?.getBoundingClientRect().bottom ?? 0) <= window.innerHeight + 100;
    follow.current = near;
    setAway(!near);
    const onScroll = () => {
      positions.set(work.id, window.scrollY);
      browserSession.setItem(`proteus-scroll-${work.id}`, String(window.scrollY));
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
      const near = (end.current?.getBoundingClientRect().bottom ?? 0) <= window.innerHeight + 100;
      follow.current = near;
      setAway(!near);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [work.id]);
  useEffect(() => {
    if (follow.current) end.current?.scrollIntoView({ block: "end" });
  }, [activities, running, work.result]);
  const previous = conversation.turns.filter((turn) => turn.id !== work.id);
  return (
    <div className="conversation-thread">
      {conversation.truncated && (
        <p className="note">显示最近 30 轮历史。当前执行使用有界历史摘要。</p>
      )}
      {!!previous.length && (
        <details className="thread-history">
          <summary>
            前文 · {previous.length} 轮 <span>{previous.at(-1)?.goal}</span>
          </summary>
          {previous.map((turn) => (
            <section className="history-turn" key={turn.id}>
              <p className="message-label">你 · {new Date(turn.createdAt).toLocaleString()}</p>
              <div className="user-turn">{turn.goal}</div>
              <p className="message-label">助手 · 历史总结</p>
              <Markdown text={turn.summary ?? "该轮尚无总结"} />
            </section>
          ))}
        </details>
      )}
      <div className="current-request">
        <span className="message-label">你</span>
        <div className="user-turn">{work.goal}</div>
      </div>
      <ExecutionRound
        work={work}
        activities={activities}
        state={state}
        onFile={onFile}
        onInspect={onInspect}
        actions={actions}
        attention={attention}
      />
      {work.result && (
        <>
          <Markdown text={work.result.summary || "执行器未提供总结。"} onFile={onFile} />
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
