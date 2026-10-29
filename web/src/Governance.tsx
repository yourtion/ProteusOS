import { useEffect, useState } from "react";
interface Model {
  organism: { revision: number; activeGenomeId: string } | null;
  datasets: { id: string; purpose: string; createdAt: number }[];
  jobs: { id: string; state: string; mode: string; error: string | null; result: unknown }[];
  candidates: {
    id: string;
    hypothesis: string;
    kind: string;
    status: { status: string; detail: string };
    evaluations: unknown[];
    baseSnapshotId: string;
    proposedSnapshotId: string;
  }[];
  promotions: {
    id: string;
    fromSnapshotId: string;
    toSnapshotId: string;
    createdAt: number;
    kind: string;
  }[];
}
async function request<T>(body?: unknown): Promise<T> {
  const response = await fetch("/api/governance", {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
export function Governance() {
  const [model, setModel] = useState<Model | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [validation, setValidation] = useState(""),
    [pending, setPending] = useState<{
      action: string;
      target?: string;
      validationSetId?: string;
      label: string;
      expectedRevision: number;
      requestId: string;
    } | null>(null),
    [result, setResult] = useState<unknown>();
  const refresh = async () => setModel(await request<Model>());
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  const propose = (action: string, label: string, target?: string) => {
    if (model?.organism)
      setPending({
        action,
        label,
        target,
        validationSetId: validation || undefined,
        expectedRevision: model.organism.revision,
        requestId: crypto.randomUUID(),
      });
  };
  return (
    <section className="content">
      <p className="eyebrow">EVOLUTION</p>
      <h1>经验与行为版本</h1>
      <p>
        学习仅产生候选；评价合格后，仍由你明确采用。当前提供已有规则学习与策略候选管理，不宣称代码任务已具有学习收益。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="approval">
          <h3>确认：{pending.label}</h3>
          <p>
            目标：{pending.target ?? "当前个体"} · 预期 revision {pending.expectedRevision}
          </p>
          <p>评价会运行候选绑定的验证任务，可能调用外部执行器。版本变化时本次请求会被拒绝。</p>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void request(pending)
                .then(async (value) => {
                  setResult(value);
                  setPending(null);
                  await refresh();
                })
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            确认执行
          </button>
          <button disabled={busy} onClick={() => setPending(null)}>
            取消
          </button>
        </div>
      )}
      <div className="toolbar">
        <span className="badge">revision {model?.organism?.revision ?? "—"}</span>
        <button disabled={busy} onClick={() => void refresh().catch((e) => setError(String(e)))}>
          刷新
        </button>
        <button
          disabled={busy || !model}
          onClick={() => propose("freeze", "将当前许可经验冻结为开发数据集")}
        >
          冻结许可经验
        </button>
      </div>
      <div className="card">
        <h3>规则学习作业</h3>
        <label className="field">
          开发数据集
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">选择数据集</option>
            {model?.datasets
              .filter((d) => d.purpose === "development")
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id.slice(0, 12)} · {new Date(d.createdAt).toLocaleString()}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          已登记验证集 ID（可选）
          <input value={validation} onChange={(e) => setValidation(e.target.value)} />
        </label>
        <button
          disabled={!selected || busy}
          onClick={() => propose("learn", "提交规则学习作业", selected)}
        >
          提交学习
        </button>
        <button disabled={busy} onClick={() => propose("run-learning", "运行一个排队的学习作业")}>
          运行下一作业
        </button>
        {model?.jobs.map((job) => (
          <details className="card" key={job.id}>
            <summary>
              {job.id.slice(0, 12)} · {job.state}
            </summary>
            <pre>{JSON.stringify(job, null, 2)}</pre>
            {["queued", "running"].includes(job.state) && (
              <button
                disabled={busy}
                onClick={() => propose("cancel-learning", "取消学习作业", job.id)}
              >
                取消作业
              </button>
            )}
          </details>
        ))}
      </div>
      <h3>候选与评价</h3>
      {!model?.candidates.length && <p>尚无候选。证据不足时，学习作业可以正常完成而不产生候选。</p>}
      {model?.candidates.map((candidate) => (
        <div className="card" key={candidate.id}>
          <h3>{candidate.hypothesis}</h3>
          <p>
            {candidate.status.status} · {candidate.status.detail}
          </p>
          <p className="note">
            基线 {candidate.baseSnapshotId} → 候选 {candidate.proposedSnapshotId}
          </p>
          <button
            disabled={busy || candidate.kind !== "policy"}
            onClick={() => propose("evaluate", "执行绑定验证集的策略评价", candidate.id)}
          >
            评价策略候选
          </button>
          <button
            disabled={busy || candidate.status.status !== "eligible"}
            onClick={() => propose("promote", "采用此候选用于后续运行", candidate.id)}
          >
            采用候选
          </button>
          <details>
            <summary>评价证据</summary>
            <pre>{JSON.stringify(candidate.evaluations, null, 2)}</pre>
          </details>
        </div>
      ))}
      <h3>采用与回滚历史</h3>
      {model?.promotions.map((p) => (
        <div className="card" key={p.id}>
          <p>
            {p.kind} · {new Date(p.createdAt).toLocaleString()}
          </p>
          <code>
            {p.fromSnapshotId} → {p.toSnapshotId}
          </code>
          <p>
            <button
              disabled={busy}
              onClick={() => propose("rollback", "回滚到此次采用之前的快照", p.fromSnapshotId)}
            >
              回滚到此前版本
            </button>
          </p>
        </div>
      ))}
      {result !== undefined && (
        <details className="card" open>
          <summary>最近操作回执</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
