import { browserSession } from "./session";
import { createSubmissionQueue } from "./submissions";
import { TaskComposer } from "./TaskComposer";
import { draftFor, submissionFor, type TaskDraft } from "./task-draft";
import { watchWorkbench, type WatchStatus } from "./watch-client";
import { TaskInspector, type InspectorTab } from "./TaskInspector";
import { Projects } from "./pages/Projects";
import { SettingsPage } from "./pages/Settings";
import { api } from "./api";
import type { Detail, Row, Settings } from "./models";
import { Button, EmptyState, Field, Notice, StatusBadge } from "./ui";
import { statusMeta } from "./ui/status";
import { ConversationThread } from "./ConversationThread";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Change, Project } from "../../src/app/workbench/contracts";
import "./style.css";
import { Governance } from "./Governance";
function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [submissions] = useState(() =>
    createSubmissionQueue(browserSession, (body) => api("runs", body)),
  );
  const pending = useSyncExternalStore(submissions.subscribe, submissions.getSnapshot);
  const actionActive = useRef(false);
  const [watchVersion, setWatchVersion] = useState(0);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [projects, setProjects] = useState<Project[]>([]),
    [runs, setRuns] = useState<Row[]>([]),
    [settings, setSettings] = useState<Settings | null>(null),
    [projectId, setProjectId] = useState(""),
    [selected, setSelected] = useState(() => browserSession.getItem("proteus-selected-run") ?? ""),
    [loadedDetail, setDetail] = useState<Detail | null>(null),
    [connection, setConnection] = useState<WatchStatus>("connecting"),
    [busy, setBusy] = useState(false);
  const [page, setPage] = useState<"tasks" | "projects" | "settings" | "governance">("tasks"),
    [search, setSearch] = useState(""),
    [change, setChange] = useState<Change | null>(null),
    [tab, setTab] = useState<InspectorTab>("changes");
  const refresh = async (chooseProject = false, accept = () => true) => {
    const [p, s, r] = await Promise.all([
      api<Project[]>("projects"),
      api<Settings>("settings"),
      api<Row[]>("runs"),
    ]);
    if (!accept()) return;
    setProjects(p);
    setSettings(s);
    setRuns(r);
    setSelected((current) => (r.some((run) => run.id === current) ? current : ""));
    setProjectId((current) => {
      if (p.some((project) => project.id === current)) return current;
      if (!chooseProject) return "";
      const previous = r.find((run) => run.id === browserSession.getItem("proteus-selected-run"));
      return previous?.projectId ?? p[0]?.id ?? "";
    });
  };
  useEffect(() => {
    let active = true;
    let attempt = 0;
    const initialize = async () => {
      const current = ++attempt;
      setReady(false);
      setConnection("connecting");
      setDetail(null);
      setError("");
      try {
        const token = location.hash.slice(1);
        if (token) {
          const response = await fetch("/api/session", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
          if (!response.ok) throw new Error("启动凭据失效，请重新打开终端输出的地址");
          history.replaceState(null, "", location.pathname);
        }
        await refresh(true, () => active && current === attempt);
        if (active && current === attempt) {
          setError("");
          setReady(true);
        }
      } catch (e) {
        if (active && current === attempt) setError(String(e));
      }
    };
    void initialize();
    window.addEventListener("hashchange", initialize);
    return () => {
      active = false;
      window.removeEventListener("hashchange", initialize);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    setDetail(null);
    setChange(null);
    return watchWorkbench<Row, Detail>(
      selected,
      {
        onSnapshot: (snapshot) => {
          setRuns(snapshot.runs);
          setDetail(snapshot.detail);
        },
        onStatus: setConnection,
      },
      (url) => {
        const source = new EventSource(url);
        return {
          close: () => source.close(),
          listen: (type, listener) =>
            source.addEventListener(type, (event) => {
              const message = event as MessageEvent;
              listener({ data: message.data ?? "", id: message.lastEventId ?? "" });
            }),
        };
      },
    );
  }, [ready, selected, watchVersion]);
  useEffect(() => {
    browserSession.setItem("proteus-selected-run", selected);
  }, [selected]);
  const detail = ready && loadedDetail?.id === selected ? loadedDetail : null;
  async function action(fn: () => Promise<void>): Promise<boolean> {
    if (actionActive.current) return false;
    actionActive.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      actionActive.current = false;
      setBusy(false);
    }
  }
  function newTask() {
    setSidebarOpen(false);
    setSelected("");
    setPage("tasks");
    void action(refresh);
  }
  function focusFollowup() {
    document.querySelector<HTMLTextAreaElement>(".followup-composer textarea")?.focus();
    document.querySelector(".followup-composer")?.scrollIntoView({ block: "nearest" });
  }
  async function submit(draft: TaskDraft, parent?: Detail) {
    return action(async () => {
      if (submissions.getSnapshot()) throw new Error("请先确认上一条提交的结果");
      const latest = await api<Settings>("settings");
      setSettings(latest);
      if (!latest.executors.some((item) => item.name === draft.executor && item.installed))
        throw new Error("执行器配置已变化，请确认新的执行器后重新提交");
      const body = submissionFor(draft, projectId, crypto.randomUUID(), parent);
      const result = await submissions.submit(body);
      setSelected(result.runId);
      setProjectId(body.projectId);
      setPage("tasks");
    });
  }
  async function retrySubmission() {
    const body = submissions.getSnapshot();
    if (!body) return;
    await action(async () => {
      const result = await submissions.retry();
      setSelected(result.runId);
      setProjectId(body.projectId);
      setPage("tasks");
    });
  }
  const filtered = runs.filter(
    (r) =>
      (!projectId || r.projectId === projectId) &&
      r.goal.toLowerCase().includes(search.toLowerCase()),
  );
  const groups = new Map<string, Row[]>();
  for (const run of filtered)
    groups.set(run.conversationId, [...(groups.get(run.conversationId) ?? []), run]);
  return (
    <div
      className={`shell ${page === "tasks" && selected && inspectorOpen ? "has-inspector" : ""} ${sidebarOpen ? "nav-open" : ""}`}
    >
      <aside className="sidebar">
        <Button
          variant="ghost"
          className="sidebar-toggle"
          aria-label="展开或收起项目与任务"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          ☰
        </Button>
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            ✳
          </span>{" "}
          Proteus<span className="brand-caption">你的代码工作空间</span>
        </div>
        <Button variant="ghost" className="new" disabled={busy || !ready} onClick={() => newTask()}>
          ＋ 新任务
        </Button>
        <Field label="当前项目">
          <select
            value={projectId}
            disabled={busy || !ready}
            onChange={(e) => {
              setError("");
              setProjectId(e.target.value);
              setSelected("");
            }}
          >
            <option value="">所有项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <input
          aria-label="搜索任务"
          placeholder="搜索任务…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <small>最近对话 · {groups.size}</small>
        <nav aria-label="最近对话">
          {ready && !filtered.length && (
            <EmptyState
              title={search ? "没有匹配的任务" : "暂无任务"}
              description={search ? "试试其他关键词。" : "从新任务开始。"}
            />
          )}
          {[...groups].map(([conversationId, turns]) => (
            <section className="conversation-group" key={conversationId}>
              {turns.length > 1 && <small>{turns.length} 轮对话</small>}
              {turns.map((r) => (
                <Button
                  variant="ghost"
                  key={r.id}
                  disabled={busy}
                  className={r.id === selected && page === "tasks" ? "selected" : ""}
                  aria-current={r.id === selected && page === "tasks" ? "page" : undefined}
                  onClick={() => {
                    setSidebarOpen(false);
                    setError("");
                    setSelected(r.id);
                    setPage("tasks");
                  }}
                >
                  <b>{r.goal}</b>
                  <span>
                    {statusMeta(r.run?.state ?? "").label} ·{" "}
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </Button>
              ))}
            </section>
          ))}
        </nav>
        <footer>
          {(
            [
              { value: "projects", label: "项目与检查配置" },
              { value: "settings", label: "助手与设置" },
              { value: "governance", label: "经验与行为版本" },
            ] as const
          ).map((item) => (
            <Button
              key={item.value}
              disabled={busy}
              variant="ghost"
              aria-current={page === item.value ? "page" : undefined}
              onClick={() => {
                setError("");
                setPage(item.value);
                setSidebarOpen(false);
              }}
            >
              {item.label}
            </Button>
          ))}
          <p className={connection === "connected" ? "online" : "offline"} role="status">
            {connection === "connected"
              ? "● 已连接"
              : connection === "reconnecting"
                ? "○ 正在重新同步"
                : "○ 正在连接"}
          </p>
          {ready && connection !== "connected" && (
            <Button variant="ghost" onClick={() => setWatchVersion((value) => value + 1)}>
              重新同步
            </Button>
          )}
        </footer>
      </aside>
      <main>
        <header className="app-header">
          {
            {
              tasks: "工作台",
              projects: "项目管理",
              settings: "助手与设置",
              governance: "经验与行为版本",
            }[page]
          }
          <span>本地执行 · 结果由你审阅</span>
        </header>
        {error && (
          <div className="page-feedback">
            <Notice tone="danger">
              <p>{error}</p>
            </Notice>
          </div>
        )}
        {pending && !busy && (
          <div className="page-feedback">
            <Notice tone="warning">
              <strong>有一条提交尚未确认</strong>
              <p className="pending-goal">{pending.goal}</p>
              <p>任务可能已经创建。重试会查询或复用同一请求，不会另建一条任务。</p>
              <div className="actions">
                <Button disabled={!ready} onClick={() => void retrySubmission()}>
                  查询或重试同一提交
                </Button>
              </div>
            </Notice>
          </div>
        )}
        {!ready ? (
          <section className="welcome">
            <h1>连接本地助手</h1>
            <EmptyState title="尚未建立会话" description="请使用终端打印的完整启动地址。" />
          </section>
        ) : page === "governance" ? (
          <Governance />
        ) : page === "projects" ? (
          <Projects
            projects={projects}
            busy={busy}
            onBusyChange={setBusy}
            limits={settings?.limits}
            onSaved={async (project) => {
              setProjectId(project.id);
              await refresh();
              setPage("tasks");
              setSelected("");
            }}
          />
        ) : page === "settings" ? (
          <SettingsPage settings={settings} />
        ) : !selected ? (
          <section className="welcome">
            <div className="mark" aria-hidden="true">
              ✳
            </div>
            <p className="eyebrow">从一个想法开始</p>
            <h1>今天，想一起做点什么？</h1>
            <p>把想法写下来，一起把代码变得更好。</p>
            {!projects.length ? (
              <Button variant="primary" onClick={() => setPage("projects")}>
                添加第一个项目 ↗
              </Button>
            ) : (
              settings && (
                <TaskComposer
                  key={`new:${projectId}`}
                  scope={`new:${projectId}`}
                  initial={draftFor(settings)}
                  settings={settings}
                  busy={busy}
                  blocked={!!pending}
                  canStart={!!projectId}
                  onSubmit={(draft) => submit(draft)}
                />
              )
            )}
          </section>
        ) : (
          <section className="content task-content">
            {!detail && <EmptyState title="加载任务…" />}
            {detail && (
              <>
                <div className="toolbar task-toolbar">
                  <h1 className="task-context">
                    对话 <span>/ {selected.slice(0, 8)}</span>
                  </h1>
                  <StatusBadge state={detail.run.state} />
                  {["pending", "running", "waiting"].includes(detail.run.state) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/cancel`, {});
                        })
                      }
                    >
                      请求停止
                    </Button>
                  )}
                  {detail.run.state === "waiting" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/reconcile`, {});
                        })
                      }
                    >
                      核对执行结果
                    </Button>
                  )}
                  {detail.result && (
                    <Button disabled={busy} onClick={focusFollowup}>
                      补充需求
                    </Button>
                  )}
                  <Button
                    className="inspector-toggle"
                    aria-expanded={inspectorOpen}
                    aria-controls={inspectorOpen ? "task-inspector" : undefined}
                    onClick={() => {
                      setTab("changes");
                      setInspectorOpen(!inspectorOpen);
                    }}
                  >
                    {inspectorOpen
                      ? "收起详情"
                      : `变更与详情 · ${detail.result?.changes.length ?? 0}`}
                  </Button>
                </div>
                {detail.error && <Notice tone="danger">{detail.error}</Notice>}
                {detail.applyState === "needs-recovery" && (
                  <Notice tone="warning">
                    <p>上次应用修改中断，备份已保留。</p>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/restore-application`, {});
                          setDetail(await api<Detail>(`runs/${selected}`));
                        })
                      }
                    >
                      恢复应用前文件
                    </Button>
                  </Notice>
                )}
                {detail.interactions
                  .filter((i) => i.state === "pending")
                  .map((i) => (
                    <Notice tone="warning" key={i.id}>
                      <h3>需要你的处理</h3>
                      <p>{i.title}</p>
                      <div className="actions">
                        {i.options.map((option) => (
                          <Button
                            disabled={busy}
                            key={option.id}
                            onClick={() =>
                              void action(async () => {
                                await api(`interactions/${i.id}/reply`, { choice: option.id });
                              })
                            }
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </Notice>
                  ))}
                <ConversationThread
                  key={selected}
                  work={detail}
                  conversation={detail.conversation}
                  activities={detail.activity}
                  state={detail.run.state}
                  onInspect={(target) => {
                    setTab(target);
                    setInspectorOpen(true);
                    requestAnimationFrame(() =>
                      document
                        .getElementById("task-inspector")
                        ?.scrollIntoView({ block: "nearest" }),
                    );
                  }}
                  running={["running", "pending"].includes(detail.run.state)}
                  onFile={(path) => {
                    const clean = path.replace(/^\.\//, "").replace(/#.*$/, "");
                    const match = detail.result?.changes.find((c) => c.path === clean);
                    if (!match) return false;
                    setChange(match);
                    setInspectorOpen(true);
                    setTab("changes");
                    requestAnimationFrame(() =>
                      document.querySelector(".inspector")?.scrollIntoView({ block: "nearest" }),
                    );
                    return true;
                  }}
                />
                {detail.result && settings && (
                  <TaskComposer
                    key={`followup:${detail.id}`}
                    scope={`followup:${detail.id}`}
                    initial={draftFor(settings, detail)}
                    settings={settings}
                    busy={busy}
                    blocked={!!pending}
                    canStart
                    projectName={projects.find((project) => project.id === detail.projectId)?.name}
                    followup
                    onSubmit={(draft) => submit(draft, detail)}
                  />
                )}
              </>
            )}
          </section>
        )}
      </main>
      {ready && page === "tasks" && selected && inspectorOpen && (
        <TaskInspector
          key={selected}
          detail={detail}
          tab={tab}
          onTab={setTab}
          change={change}
          onChange={setChange}
          busy={busy}
          onAction={async (fn) => {
            await action(fn);
          }}
          onUpdated={setDetail}
          onClose={() => {
            setInspectorOpen(false);
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>(".inspector-toggle")?.focus(),
            );
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
