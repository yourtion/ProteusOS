import { useState } from "react";
import type { Change } from "../../src/app/workbench/contracts";
import type { Detail } from "./models";
import { api } from "./api";
import { ToolCalls, Trace, Usage } from "./RunObservability";
import { Button, EmptyState, EvidenceDetails, Notice, SelectionBar, StatusBadge } from "./ui";
export type InspectorTab = "changes" | "tools" | "trace" | "usage" | "checks" | "evidence";
const tabs: { value: InspectorTab; label: string }[] = [
  { value: "changes", label: "变更" },
  { value: "tools", label: "工具" },
  { value: "trace", label: "Trace" },
  { value: "usage", label: "用量" },
  { value: "checks", label: "检查" },
  { value: "evidence", label: "证据" },
];
export function TaskInspector({
  detail,
  tab,
  onTab,
  change,
  onChange,
  onClose,
  busy,
  onAction,
  onUpdated,
}: {
  detail: Detail | null;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  change: Change | null;
  onChange: (change: Change) => void;
  onClose: () => void;
  busy: boolean;
  onAction: (fn: () => Promise<void>) => Promise<void>;
  onUpdated: (detail: Detail) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const currentChange = detail?.result?.changes.find((item) => item.path === change?.path);
  return (
    <aside
      id="task-inspector"
      className="inspector"
      aria-label="任务详情"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="inspector-heading">
        <strong>任务详情</strong>
        <Button variant="ghost" aria-label="关闭任务详情" onClick={onClose}>
          ×
        </Button>
      </div>
      <SelectionBar label="任务详情分类" value={tab} options={tabs} onChange={onTab} />
      <div className="inspector-body">
        {!detail ? (
          <EmptyState title="正在读取任务…" />
        ) : tab === "changes" ? (
          <>
            <h2>变更文件 · {detail.result?.changes.length ?? 0}</h2>
            {!detail.result?.changes.length && (
              <EmptyState
                title={detail.result ? "没有文件变更" : "尚无文件结果"}
                description={
                  detail.result ? "本轮未产生可应用的修改。" : "执行结束后可在此审阅修改。"
                }
              />
            )}
            <div className="file-list">
              {detail.result?.changes.map((item) => (
                <button
                  type="button"
                  className={`file ${currentChange?.path === item.path ? "selected" : ""}`}
                  aria-label={`${item.before === null ? "+" : item.after === null ? "−" : "M"} ${item.path}`}
                  aria-pressed={currentChange?.path === item.path}
                  key={item.path}
                  onClick={() => onChange(item)}
                >
                  <span className="file-kind">
                    {item.before === null ? "+" : item.after === null ? "−" : "M"}
                  </span>
                  <span>{item.path}</span>
                </button>
              ))}
            </div>
            {currentChange && (
              <div className="diff">
                <h3>{currentChange.path}</h3>
                <p>修改前</p>
                <pre className="before">{currentChange.before ?? "（新文件）"}</pre>
                <p>修改后</p>
                <pre className="after">{currentChange.after ?? "（已删除）"}</pre>
              </div>
            )}
            {detail.mode === "edit" &&
              detail.result &&
              detail.run.state === "succeeded" &&
              detail.result.changes.length > 0 && (
                <div className="apply">
                  <Button
                    variant="primary"
                    disabled={busy || !!detail.appliedAt}
                    onClick={() => setConfirm(true)}
                  >
                    {detail.appliedAt ? "已应用到项目" : "应用到原项目"}
                  </Button>
                  {confirm && !detail.appliedAt && (
                    <Notice tone="warning">
                      <strong>确认应用修改</strong>
                      <p>
                        将写入 {detail.result.changes.length} 个文件。应用前检查基线；不会提交或推送
                        Git。
                      </p>
                      <div className="actions">
                        <Button
                          variant="primary"
                          pending={busy}
                          onClick={() =>
                            void onAction(async () => {
                              await api(`runs/${detail.id}/apply`, {});
                              setConfirm(false);
                              onUpdated(await api<Detail>(`runs/${detail.id}`));
                            })
                          }
                        >
                          确认应用
                        </Button>
                        <Button disabled={busy} onClick={() => setConfirm(false)}>
                          取消
                        </Button>
                      </div>
                    </Notice>
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
            <h2>独立检查</h2>
            <StatusBadge
              tone={
                !detail.result?.checks.tested
                  ? "neutral"
                  : detail.result.checks.passed
                    ? "success"
                    : "danger"
              }
            >
              {!detail.result?.checks.tested
                ? "未验证"
                : detail.result.checks.passed
                  ? "检查通过"
                  : "检查失败"}
            </StatusBadge>
            {detail.result?.checks.output ? (
              <pre className="data-block">{detail.result.checks.output}</pre>
            ) : (
              <EmptyState
                title="暂无检查输出"
                description={
                  detail.result ? "本轮没有记录到检查输出。" : "任务尚未进入独立检查阶段。"
                }
              />
            )}
          </>
        ) : (
          <>
            <h2>运行证据</h2>
            <a className="button button-secondary" href={`/api/runs/${detail.id}/export`} download>
              下载结果与证据 JSON
            </a>
            <dl className="metadata">
              <dt>快照</dt>
              <dd>
                <code>{detail.snapshotId}</code>
              </dd>
              <dt>截止时间</dt>
              <dd>{new Date(detail.run.deadlineAt).toLocaleString()}</dd>
            </dl>
            <EvidenceDetails title="经验记录" value={detail.experience} />
          </>
        )}
      </div>
    </aside>
  );
}
