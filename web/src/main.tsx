import { ConversationThread } from "./ConversationThread";
import { applyPatches, type Json, type Patch } from "../../src/app/workbench/watch";
import {
  ToolCalls,
  Usage,
  Trace,
  ConversationHistory,
  type Conversation,
} from "./RunObservability";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Activity,
  Change,
  Interaction,
  Project,
  Work,
} from "../../src/app/workbench/contracts";
import "./style.css";
import { Governance } from "./Governance";
type Run = { state: string; failureReason: string | null; deadlineAt: number };
type Row = Omit<Work, "baseline" | "inputDir" | "result"> & { run: Run };
type Detail = Work & {
  run: Run;
  activity: Activity[];
  interactions: Interaction[];
  experience: unknown;
  conversation: Conversation;
};
type Settings = {
  home: string;
  defaultExecutor: string;
  executors: { name: string; installed: boolean }[];
  organism: unknown;
  candidates: unknown[];
  promotions: unknown[];
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 ${response.status}`);
  return result;
}
const stateNames: Record<string, string> = {
  pending: "排队中",
  running: "执行中",
  waiting: "等待处理",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
};
function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    [timeout, setTimeoutValue] = useState(300),
    [parentId, setParentId] = useState<string | undefined>(),
    [search, setSearch] = useState(""),
    [path, setPath] = useState(""),
    [name, setName] = useState(""),
    [testCommand, setTestCommand] = useState("[]"),
    [change, setChange] = useState<Change | null>(null),
    [tab, setTab] = useState<"changes" | "checks" | "evidence" | "tools" | "trace" | "usage">(
      "changes",
    ),
    [confirmApply, setConfirmApply] = useState(false);
  const refresh = async () => {
    const [p, s, r] = await Promise.all([
      api<Project[]>("projects"),
      api<Settings>("settings"),
      api<Row[]>("runs"),
    ]);
    setProjects(p);
    setSettings(s);
    setExecutor((current) =>
      s.executors.some((e) => e.name === current && e.installed) ? current : s.defaultExecutor,
    );
    setRuns(r);
    setSelected((current) => (r.some((run) => run.id === current) ? current : ""));
    setProjectId((current) => current || p[0]?.id || "");
  };
  useEffect(() => {
    let active = true;
    const initialize = async () => {
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
        if (active) {
          setError("");
          setReady(true);
        }
      } catch (e) {
        if (active) setError(String(e));
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
    setConfirmApply(false);
  }
  async function submit() {
    const requestId = crypto.randomUUID();
    const body = { projectId, goal, mode, executor, timeoutSeconds: timeout, parentId, requestId };
    sessionStorage.setItem("proteus-pending", JSON.stringify(body));
    await send(body);
  }
  async function send(body: unknown) {
    const result = await api<{ runId: string }>("runs", body);
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
      className={`shell ${page === "tasks" && selected ? "has-inspector" : ""} ${sidebarOpen ? "nav-open" : ""}`}
    >
      <aside className="sidebar">
        <button
          className="sidebar-toggle"
          aria-label="展开或收起项目与任务"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          ☰
        </button>
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            ✳
          </span>{" "}
          Proteus<span className="brand-caption">你的代码工作空间</span>
        </div>
        <button className="new" onClick={() => newTask()}>
          ＋ 新任务
        </button>
        <label className="field">
          当前项目
          <select
            value={projectId}
            onChange={(e) => {
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
        </label>
        <input
          aria-label="搜索任务"
          placeholder="搜索任务…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <small>最近对话 · {groups.size}</small>
        <nav>
          {[...groups].map(([conversationId, turns]) => (
            <section className="conversation-group" key={conversationId}>
              {turns.length > 1 && <small>{turns.length} 轮对话</small>}
              {turns.map((r) => (
                <button
                  key={r.id}
                  className={r.id === selected ? "selected" : ""}
                  onClick={() => {
                    setSidebarOpen(false);
                    setSelected(r.id);
                    setPage("tasks");
                    setConfirmApply(false);
                  }}
                >
                  <b>{r.goal}</b>
                  <span>
                    {stateNames[r.run?.state] ?? r.run?.state} ·{" "}
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <footer>
          <button onClick={() => setPage("projects")}>项目与检查配置</button>
          <button onClick={() => setPage("settings")}>助手与设置</button>
          <button onClick={() => setPage("governance")}>经验与行为版本</button>
          <p className={connected ? "online" : "offline"}>
            {connected ? "● 已连接" : "○ 正在连接 / 重连"}
          </p>
        </footer>
      </aside>
      <main>
        <header>
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
          <div className="error" role="alert">
            {error}
            {sessionStorage.getItem("proteus-pending") && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() => send(JSON.parse(sessionStorage.getItem("proteus-pending")!)))
                }
              >
                查询或重试同一提交
              </button>
            )}
          </div>
        )}
        {!ready ? (
          <section className="welcome">
            <h1>连接本地助手</h1>
            <p>请使用终端打印的完整启动地址。</p>
          </section>
        ) : page === "governance" ? (
          <Governance />
        ) : page === "projects" ? (
          <section className="content">
            <p className="eyebrow">PROJECTS</p>
            <h1>连接你的代码</h1>
            <p>
              任务在独立副本中执行，审阅后再应用到原项目。当前支持最多 2000 个 UTF-8 文本文件、总计
              20 MiB 的普通 Git 仓库。
            </p>
            <form
              className="card"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const project = await api<Project>("projects", {
                    path,
                    name: name || undefined,
                    testCommand: JSON.parse(testCommand),
                  });
                  setProjectId(project.id);
                  await refresh();
                  setPage("tasks");
                  setSelected("");
                });
              }}
            >
              <label className="field">
                项目名称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="可选，例如 ProteusOS"
                />
              </label>
              <label className="field">
                Git 仓库绝对路径
                <input
                  required
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/Users/you/code/my-project"
                />
              </label>
              <label className="field">
                测试命令参数 JSON
                <input
                  value={testCommand}
                  onChange={(e) => setTestCommand(e.target.value)}
                  placeholder={'["node", "--test"]'}
                />
              </label>
              <p className="note">
                测试命令会在任务副本中执行。留空数组表示不运行测试，结果将标记为未验证。不会自动安装依赖。
              </p>
              <button className="primary" disabled={busy}>
                保存项目
              </button>
            </form>
            {projects.map((p) => (
              <div className="card" key={p.id}>
                <h3>{p.name}</h3>
                <code>{p.path}</code>
                <p>检查：{p.testCommand.join(" ") || "未配置"}</p>
                <button
                  onClick={() => {
                    setPath(p.path);
                    setName(p.name);
                    setTestCommand(JSON.stringify(p.testCommand));
                  }}
                >
                  编辑配置
                </button>
              </div>
            ))}
          </section>
        ) : page === "settings" ? (
          <section className="content">
            <p className="eyebrow">ASSISTANT</p>
            <h1>运行环境与版本</h1>
            <div className="card">
              <h3>执行器</h3>
              {settings?.executors.map((e) => (
                <p key={e.name}>
                  {e.name} · {e.installed ? "已安装，实际认证以运行结果为准" : "未安装"}
                </p>
              ))}
              <p className="note">
                执行器使用宿主机已有登录或环境配置。凭据不会发送到浏览器。项目副本不等于操作系统沙箱，工具权限请逐项审阅。
              </p>
            </div>
            <div className="card">
              <h3>实例</h3>
              <code>{settings?.home}</code>
              <pre>{JSON.stringify(settings?.organism, null, 2)}</pre>
            </div>
            <details className="card">
              <summary>候选与采用历史（只读）</summary>
              <pre>
                {JSON.stringify(
                  { candidates: settings?.candidates, promotions: settings?.promotions },
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
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
              <button className="primary" onClick={() => setPage("projects")}>
                添加第一个项目 ↗
              </button>
            ) : (
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(submit);
                }}
              >
                {parentId && <p className="note">基于任务 {parentId.slice(0, 8)} 的结果继续</p>}
                <label className="field">
                  <span className="sr-only">任务需求</span>
                  <textarea
                    required
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="描述你的需求，或聊聊这份代码…"
                    rows={3}
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    任务类型
                    <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                      <option value="edit">修改代码</option>
                      <option value="read">理解代码</option>
                      <option value="review">审查代码</option>
                    </select>
                  </label>
                  <label className="field">
                    执行器
                    <select value={executor} onChange={(e) => setExecutor(e.target.value)}>
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
                  </label>
                  <label className="field">
                    超时（秒）
                    <input
                      type="number"
                      min={10}
                      max={1800}
                      value={timeout}
                      onChange={(e) => setTimeoutValue(Number(e.target.value))}
                    />
                  </label>
                </div>
                <div className="composer-footer">
                  <p className="note composer-note">在独立副本中执行，修改由你审阅后应用。</p>
                  <button className="primary" disabled={busy || !projectId}>
                    {busy ? "正在提交…" : "开始任务 ↗"}
                  </button>
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
                  <button
                    key={item.mode}
                    onClick={() => {
                      setMode(item.mode);
                      setGoal(item.goal);
                    }}
                  >
                    {item.label}
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="content task-content">
            <p className="eyebrow">任务 / {selected.slice(0, 8)}</p>
            <h1 className="conversation-title">对话</h1>
            {!detail && <p>加载任务…</p>}
            {detail && (
              <>
                <div className="toolbar">
                  <span className="badge">{stateNames[detail.run.state]}</span>
                  {["pending", "running", "waiting"].includes(detail.run.state) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/cancel`, {});
                        })
                      }
                    >
                      请求停止
                    </button>
                  )}
                  {detail.run.state === "waiting" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/reconcile`, {});
                        })
                      }
                    >
                      核对执行结果
                    </button>
                  )}
                  {detail.result && <button onClick={() => newTask(selected)}>补充需求</button>}
                </div>
                {detail.error && <p className="error">{detail.error}</p>}
                {detail.applyState === "needs-recovery" && (
                  <div className="approval">
                    <p>上次应用修改中断，备份已保留。</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/restore-application`, {});
                          setDetail(await api<Detail>(`runs/${selected}`));
                        })
                      }
                    >
                      恢复应用前文件
                    </button>
                  </div>
                )}
                {detail.interactions
                  .filter((i) => i.state === "pending")
                  .map((i) => (
                    <div className="approval" key={i.id}>
                      <h3>需要你的处理</h3>
                      <p>{i.title}</p>
                      {i.options.map((option) => (
                        <button
                          disabled={busy}
                          key={option.id}
                          onClick={() =>
                            void action(async () => {
                              await api(`interactions/${i.id}/reply`, { choice: option.id });
                            })
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ))}
                <ConversationThread
                  key={selected}
                  work={detail}
                  conversation={detail.conversation}
                  activities={detail.activity}
                  running={["running", "pending"].includes(detail.run.state)}
                  onFile={(path) => {
                    const clean = path.replace(/^\.\//, "").replace(/#.*$/, "");
                    const match = detail.result?.changes.find((c) => c.path === clean);
                    if (!match) return false;
                    setChange(match);
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
      <aside className="inspector" hidden={page !== "tasks" || !selected}>
        <div className="tabs">
          {(["changes", "tools", "trace", "usage", "checks", "evidence"] as const).map((t) => (
            <button className={tab === t ? "selected" : ""} key={t} onClick={() => setTab(t)}>
              {
                {
                  changes: "变更",
                  tools: "工具",
                  trace: "Trace",
                  usage: "用量",
                  checks: "检查",
                  evidence: "证据",
                }[t]
              }
            </button>
          ))}
        </div>
        {!detail ? (
          <p>选择任务，查看结果、文件差异和验收证据。</p>
        ) : tab === "changes" ? (
          <>
            <h3>变更文件 · {detail.result?.changes.length ?? 0}</h3>
            {detail.result?.changes.map((c) => (
              <button className="file" key={c.path} onClick={() => setChange(c)}>
                {c.before === null ? "+" : c.after === null ? "−" : "M"} {c.path}
              </button>
            ))}
            {change && (
              <div className="diff">
                <h4>{change.path}</h4>
                <p>修改前</p>
                <pre className="before">{change.before ?? "（新文件）"}</pre>
                <p>修改后</p>
                <pre className="after">{change.after ?? "（已删除）"}</pre>
              </div>
            )}
            {detail.mode === "edit" && detail.result && detail.run.state === "succeeded" && (
              <div className="apply">
                <button
                  className="primary"
                  disabled={busy || !!detail.appliedAt}
                  onClick={() => setConfirmApply(true)}
                >
                  {detail.appliedAt ? "已应用到项目" : "应用到原项目"}
                </button>
                {confirmApply && !detail.appliedAt && (
                  <div className="card">
                    <p>
                      将写入 {detail.result.changes.length}{" "}
                      个文件。应用前会检查项目基线；不会提交或推送 Git。
                    </p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`runs/${selected}/apply`, {});
                          setConfirmApply(false);
                          setDetail(await api<Detail>(`runs/${selected}`));
                        })
                      }
                    >
                      确认应用
                    </button>
                    <button onClick={() => setConfirmApply(false)}>取消</button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : tab === "tools" ? (
          <ToolCalls activities={detail.activity} />
        ) : tab === "trace" ? (
          <Trace work={detail} activities={detail.activity} />
        ) : tab === "usage" ? (
          <Usage work={detail} activities={detail.activity} />
        ) : tab === "checks" ? (
          <>
            <h3>独立检查</h3>
            <pre>{detail.result?.checks.output ?? "检查尚未开始"}</pre>
          </>
        ) : (
          <>
            <h3>运行证据</h3>
            <a href={`/api/runs/${selected}/export`} download>
              下载结果与证据 JSON
            </a>
            <p>快照</p>
            <code>{detail.snapshotId}</code>
            <p>截止时间：{new Date(detail.run.deadlineAt).toLocaleString()}</p>
            <pre>{JSON.stringify(detail.experience, null, 2)}</pre>
          </>
        )}
      </aside>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
