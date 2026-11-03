import { useEffect, useState } from "react";
import { api } from "./api";
import {
  Button,
  EmptyState,
  EvidenceDetails,
  Field,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
} from "./ui";
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
export function Governance() {
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [validation, setValidation] = useState("");
  const [pending, setPending] = useState<{
    action: string;
    target?: string;
    validationSetId?: string;
    label: string;
    expectedRevision: number;
    requestId: string;
  } | null>(null);
  const [result, setResult] = useState<unknown>();
  const refresh = async () => setModel(await api<Model>("governance"));
  useEffect(() => {
    let active = true;
    void api<Model>("governance")
      .then((value) => {
        if (active) setModel(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const perform = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
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
  const unavailable = busy || !model?.organism || !!pending;
  return (
    <section className="content">
      <PageHeader
        title="经验与行为版本"
        description="学习产生候选，评价合格后由你决定是否采用。"
        actions={
          <Button pending={busy} disabled={!!pending} onClick={() => void perform(refresh)}>
            刷新
          </Button>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {pending && (
        <Notice tone="warning">
          <strong>确认：{pending.label}</strong>
          <p>
            目标：{pending.target ?? "当前个体"} · 版本 {pending.expectedRevision}
          </p>
          <p>评价会运行候选绑定的验证任务，可能调用外部执行器。版本变化时本次请求会被拒绝。</p>
          <div className="actions">
            <Button
              variant="primary"
              pending={busy}
              onClick={() =>
                void perform(async () => {
                  const value = await api("governance", pending);
                  setResult(value);
                  setPending(null);
                  await refresh();
                })
              }
            >
              {busy ? "执行中…" : "确认执行"}
            </Button>
            <Button disabled={busy} onClick={() => setPending(null)}>
              取消
            </Button>
          </div>
        </Notice>
      )}
      {!model ? (
        <EmptyState
          title={error ? "暂时无法读取行为版本" : "正在读取行为版本…"}
          description={error ? "可通过右上角刷新重试。" : undefined}
        />
      ) : (
        <div className="panel-grid">
          <Panel
            title="当前行为版本"
            actions={
              <StatusBadge tone="neutral">版本 {model.organism?.revision ?? "未知"}</StatusBadge>
            }
          >
            <dl className="metadata">
              <dt>活动快照</dt>
              <dd>
                <code>{model.organism?.activeGenomeId ?? "尚未初始化"}</code>
              </dd>
            </dl>
            <p className="note">当前支持已有规则学习与策略候选管理；代码任务的学习收益需要验证。</p>
            <Button
              disabled={unavailable}
              onClick={() => propose("freeze", "将当前许可经验冻结为开发数据集")}
            >
              冻结许可经验
            </Button>
          </Panel>
          <Panel title="规则学习作业" description="从开发数据集提交作业，再运行队列中的下一项。">
            <div className="form-grid">
              <Field label="开发数据集">
                <select
                  value={selected}
                  disabled={unavailable}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">选择数据集</option>
                  {model.datasets
                    .filter((d) => d.purpose === "development")
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.id.slice(0, 12)} · {new Date(d.createdAt).toLocaleString()}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="已登记验证集 ID（可选）">
                <input
                  value={validation}
                  disabled={unavailable}
                  onChange={(e) => setValidation(e.target.value)}
                />
              </Field>
            </div>
            <div className="actions">
              <Button
                variant="primary"
                disabled={!selected || unavailable}
                onClick={() => propose("learn", "提交规则学习作业", selected)}
              >
                提交学习
              </Button>
              <Button
                disabled={unavailable}
                onClick={() => propose("run-learning", "运行一个排队的学习作业")}
              >
                运行下一作业
              </Button>
            </div>
            <div className="record-list">
              {!model.jobs.length && <EmptyState title="暂无学习作业" />}
              {model.jobs.map((job) => (
                <article className="record-entry" key={job.id}>
                  <div className="record-row">
                    <div className="record-main">
                      <code>{job.id}</code>
                      <span className="note">{job.mode}</span>
                    </div>
                    <StatusBadge state={job.state} />
                    {["queued", "running"].includes(job.state) && (
                      <Button
                        disabled={unavailable}
                        onClick={() => propose("cancel-learning", "取消学习作业", job.id)}
                      >
                        取消作业
                      </Button>
                    )}
                  </div>
                  {job.error && <Notice tone="danger">{job.error}</Notice>}
                  <EvidenceDetails title="作业详情" value={job} />
                </article>
              ))}
            </div>
          </Panel>
          <Panel title={`候选与评价 · ${model.candidates.length}`}>
            {!model.candidates.length ? (
              <EmptyState
                title="尚无候选"
                description="证据不足时，学习作业可以完成而不产生候选。"
              />
            ) : (
              <div className="record-list">
                {model.candidates.map((candidate) => (
                  <article className="record-entry" key={candidate.id}>
                    <div className="record-row">
                      <div className="record-main">
                        <h3>{candidate.hypothesis}</h3>
                        <p className="note">{candidate.status.detail}</p>
                      </div>
                      <StatusBadge state={candidate.status.status} />
                    </div>
                    <dl className="metadata">
                      <dt>基线</dt>
                      <dd>
                        <code>{candidate.baseSnapshotId}</code>
                      </dd>
                      <dt>候选</dt>
                      <dd>
                        <code>{candidate.proposedSnapshotId}</code>
                      </dd>
                    </dl>
                    <div className="actions">
                      <Button
                        disabled={unavailable || candidate.kind !== "policy"}
                        onClick={() =>
                          propose("evaluate", "执行绑定验证集的策略评价", candidate.id)
                        }
                      >
                        评价策略候选
                      </Button>
                      <Button
                        variant="primary"
                        disabled={unavailable || candidate.status.status !== "eligible"}
                        onClick={() => propose("promote", "采用此候选用于后续运行", candidate.id)}
                      >
                        采用候选
                      </Button>
                    </div>
                    <EvidenceDetails title="评价证据" value={candidate.evaluations} />
                  </article>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="采用与回滚历史">
            {!model.promotions.length ? (
              <EmptyState title="暂无版本变更" />
            ) : (
              <div className="record-list">
                {model.promotions.map((p) => (
                  <article className="record-row" key={p.id}>
                    <div className="record-main">
                      <strong>{p.kind}</strong>
                      <span className="note">{new Date(p.createdAt).toLocaleString()}</span>
                      <code>
                        {p.fromSnapshotId} → {p.toSnapshotId}
                      </code>
                    </div>
                    <Button
                      disabled={unavailable}
                      onClick={() =>
                        propose("rollback", "回滚到此次采用之前的快照", p.fromSnapshotId)
                      }
                    >
                      回滚到此前版本
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
      {result !== undefined && <EvidenceDetails title="最近操作回执" value={result} open />}
    </section>
  );
}
