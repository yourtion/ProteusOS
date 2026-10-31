import { TaskInspector, type InspectorTab } from "./TaskInspector";
import { Projects } from "./pages/Projects";
import { SettingsPage } from "./pages/Settings";
import { api, ApiError } from "./api";
import type { Conversation, Detail, Row, Settings } from "./models";
import { Button, EmptyState, Field, Notice, StatusBadge } from "./ui";
import { statusMeta } from "./ui/status";
import { availableExecutor } from "../../src/app/workbench/execution-options";
import { ConversationThread } from "./ConversationThread";
import { applyPatches, type Json, type Patch } from "../../src/app/workbench/watch";
import { ConversationHistory } from "./RunObservability";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Change, Project } from "../../src/app/workbench/contracts";
import "./style.css";
import { Governance } from "./Governance";
function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [contextHistory, setContextHistory] = useState<Conversation | null>(null);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [projects, setProjects] = useState<Project[]>([]),
    [runs, setRuns] = useState<Row[]>([]),
    [settings, setSettings] = useState<Settings | null>(null),
    [projectId, setProjectId] = useState(""),
    [selected, setSelected] = useState(() => sessionStorage.getItem("proteus-selected-run") ?? ""),
    [detail, setDetail] = useState<Detail | null>(null),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false);
  const [page, setPage] = useState<"tasks" | "projects" | "settings" | "governance">("tasks"),
    [goal, setGoal] = useState(""),
    [mode, setMode] = useState<"read" | "review" | "edit">("edit"),
    [executor, setExecutor] = useState(""),
    [model, setModel] = useState(""),
    [reasoningEffort, setReasoningEffort] = useState(""),
    [timeout, setTimeoutValue] = useState(300),
    [parentId, setParentId] = useState<string | undefined>(),
    [search, setSearch] = useState(""),
    [change, setChange] = useState<Change | null>(null),
    [tab, setTab] = useState<InspectorTab>("changes");
  const refresh = async () => {
    const [p, s, r] = await Promise.all([
      api<Project[]>("projects"),
      api<Settings>("settings"),
      api<Row[]>("runs"),
    ]);
    setProjects(p);
    setSettings(s);
    setExecutor((current) => availableExecutor(s, current));
    setRuns(r);
    setSelected((current) => (r.some((run) => run.id === current) ? current : ""));
    setProjectId((current) => current || p[0]?.id || "");
  };
  useEffect(() => {
    let active = true;
    let attempt = 0;
    const initialize = async () => {
      const current = ++attempt;
      setReady(false);
      setConnected(false);
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
        await refresh();
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
    const source = new EventSource(
      `/api/watch${selected ? `?runId=${encodeURIComponent(selected)}` : ""}`,
    );
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    let state: Json = null;
    let cursor = "";
    const render = () => {
      const snapshot = state as unknown as { runs: Row[]; detail: Detail | null };
      setRuns(snapshot.runs);
      setDetail(snapshot.detail);
    };
    source.addEventListener("snapshot", (event) => {
      const message = event as MessageEvent;
      state = JSON.parse(message.data);
      cursor = message.lastEventId;
      render();
    });
    source.addEventListener("delta", (event) => {
      const message = event as MessageEvent;
      const delta = JSON.parse(message.data) as { base: string; patches: Patch[] };
      if (message.lastEventId === cursor) return;
      if (delta.base !== cursor) {
        source.close();
        setConnected(false);
        setError("流式数据序号不连续，请重新选择任务以同步");
        return;
      }
      state = applyPatches(state, delta.patches);
      cursor = message.lastEventId;
      render();
    });
    return () => source.close();
  }, [ready, selected]);
  useEffect(() => {
    sessionStorage.setItem("proteus-selected-run", selected);
  }, [selected]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function newTask(parent?: string) {
    setContextHistory(parent && detail ? detail.conversation : null);
    setSidebarOpen(false);
    setSelected("");
    setPage("tasks");
    setGoal("");
    setParentId(parent);
    void action(refresh);
  }
  async function submit() {
    const latest = await api<Settings>("settings");
    setSettings(latest);
    if (!latest.executors.some((e) => e.name === executor && e.installed)) {
      setExecutor(availableExecutor(latest));
      throw new Error("执行器配置已变化，请确认新的执行器后重新提交");
    }
    const requestId = crypto.randomUUID();
    const body = {
      projectId,
      goal,
      mode,
      executor,
      model: model || undefined,
      reasoningEffort: reasoningEffort || undefined,
      timeoutSeconds: timeout,
      parentId,
      requestId,
    };
    sessionStorage.setItem("proteus-pending", JSON.stringify(body));
    await send(body);
  }
  async function send(body: unknown) {
    let result: { runId: string };
    try {
      result = await api<{ runId: string }>("runs", body);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        sessionStorage.removeItem("proteus-pending");
        await refresh();
      }
      throw error;
    }
    sessionStorage.removeItem("proteus-pending");
    setSelected(result.runId);
    await refresh();
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
              setProjectId(e.target.value);
              setSelected("");
              setParentId(undefined);
              setContextHistory(null);
              setGoal("");
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
                setPage(item.value);
                setSidebarOpen(false);
              }}
            >
              {item.label}
            </Button>
          ))}
          <p className={connected ? "online" : "offline"}>
            {connected ? "● 已连接" : "○ 正在连接 / 重连"}
          </p>
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
              {sessionStorage.getItem("proteus-pending") && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(() => send(JSON.parse(sessionStorage.getItem("proteus-pending")!)))
                  }
                >
                  查询或重试同一提交
                </Button>
              )}
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
              setParentId(undefined);
              setContextHistory(null);
              setGoal("");
              await refresh();
              setPage("tasks");
              setSelected("");
            }}
          />
        ) : page === "settings" ? (
          <SettingsPage settings={settings} />
        ) : !selected ? (
          <section className="welcome">
            {contextHistory && <ConversationHistory conversation={contextHistory} />}
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
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(submit);
                }}
              >
                {parentId && <p className="note">基于任务 {parentId.slice(0, 8)} 的结果继续</p>}
                <Field label="任务需求" hiddenLabel>
                  <textarea
                    required
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="描述你的需求，或聊聊这份代码…"
                    rows={3}
                  />
                </Field>
                <div className="form-row">
                  <Field label="任务类型">
                    <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                      <option value="edit">修改代码</option>
                      <option value="read">理解代码</option>
                      <option value="review">审查代码</option>
                    </select>
                  </Field>
                  <Field label="执行器">
                    <select
                      value={executor}
                      onChange={(e) => {
                        setExecutor(e.target.value);
                        setModel("");
                        setReasoningEffort("");
                      }}
                    >
                      {!availableExecutor(settings ?? { executors: [], defaultExecutor: "" }) && (
                        <option value="">没有可用执行器</option>
                      )}
                      {(settings?.executors ?? []).map((executor) => (
                        <option
                          key={executor.name}
                          value={executor.name}
                          disabled={!executor.installed}
                        >
                          {executor.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <details className="composer-options">
                  <summary>
                    更多设置{" "}
                    <span>
                      {model || "默认模型"} · {reasoningEffort || "默认强度"} · {timeout}s
                    </span>
                  </summary>
                  <div className="form-row">
                    <Field label="模型">
                      <input
                        aria-label="模型"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="执行器默认模型"
                        list="executor-models"
                      />
                    </Field>
                    <datalist id="executor-models">
                      {settings?.executors
                        .find((e) => e.name === executor)
                        ?.models?.map((value) => (
                          <option key={value} value={value} />
                        ))}
                    </datalist>
                    <Field label="推理强度">
                      <input
                        aria-label="推理强度"
                        value={reasoningEffort}
                        onChange={(e) => setReasoningEffort(e.target.value)}
                        placeholder="执行器默认强度"
                        list="executor-efforts"
                      />
                    </Field>
                    <datalist id="executor-efforts">
                      {settings?.executors
                        .find((e) => e.name === executor)
                        ?.reasoningEfforts?.map((value) => (
                          <option key={value} value={value} />
                        ))}
                    </datalist>
                    <Field label="超时（秒）">
                      <input
                        type="number"
                        min={10}
                        max={1800}
                        value={timeout}
                        onChange={(e) => setTimeoutValue(Number(e.target.value))}
                      />
                    </Field>
                  </div>
                </details>
                <div className="composer-footer">
                  <p className="note composer-note">在独立副本中执行，修改由你审阅后应用。</p>
                  <Button
                    type="submit"
                    variant="primary"
                    pending={busy}
                    disabled={!projectId || !executor}
                  >
                    {busy ? "正在提交…" : "开始任务 ↗"}
                  </Button>
                </div>
              </form>
            )}
            {projects.length > 0 && (
              <div className="suggestions" aria-label="任务示例">
                {[
                  {
                    label: "理解项目",
                    mode: "read" as const,
                    goal: "介绍项目的结构、主要模块和启动方式。",
                  },
                  {
                    label: "审查代码",
                    mode: "review" as const,
                    goal: "审查项目中的潜在问题，给出具体位置和修改建议。",
                  },
                  {
                    label: "修复问题",
                    mode: "edit" as const,
                    goal: "修复这个问题，并补充对应的回归测试：",
                  },
                ].map((item) => (
                  <Button
                    variant="ghost"
                    key={item.mode}
                    onClick={() => {
                      setMode(item.mode);
                      setGoal(item.goal);
                    }}
                  >
                    {item.label}
                    <span aria-hidden="true">↗</span>
                  </Button>
                ))}
              </div>
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
                  {detail.result && <Button onClick={() => newTask(selected)}>补充需求</Button>}
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
          onAction={action}
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
