import { useId, useRef, useState } from "react";
import {
  availableExecutor,
  type ExecutorSettings,
} from "../../src/app/workbench/execution-options";
import { browserSession } from "./session";
import { draftKey, readDraft, type TaskDraft } from "./task-draft";
import { Button, Field } from "./ui";
export function TaskComposer({
  scope,
  initial,
  settings,
  busy,
  blocked,
  projectName,
  canStart,
  followup = false,
  onSubmit,
}: {
  scope: string;
  initial: TaskDraft;
  settings: ExecutorSettings;
  busy: boolean;
  blocked: boolean;
  projectName?: string;
  canStart: boolean;
  followup?: boolean;
  onSubmit: (draft: TaskDraft) => Promise<boolean>;
}) {
  const [saved, setDraft] = useState(() => readDraft(browserSession, scope, initial));
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const [sending, setSending] = useState(false);
  const id = useId();
  const executor = availableExecutor(settings, saved.executor);
  const draft =
    executor === saved.executor ? saved : { ...saved, executor, model: "", reasoningEffort: "" };
  const update = (changes: Partial<TaskDraft>) => {
    const next = { ...draft, ...changes };
    setDraft(next);
    browserSession.setItem(draftKey(scope), JSON.stringify(next));
  };
  const choices = settings.executors.find((item) => item.name === executor);
  const disabled = busy || blocked || sending;
  return (
    <>
      <form
        className={`composer ${followup ? "followup-composer" : ""}`}
        aria-label={followup ? "补充需求" : "新任务"}
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || submitting.current || !canStart || !draft.executor || !draft.goal.trim())
            return;
          submitting.current = true;
          setSending(true);
          try {
            if (await onSubmit({ ...draft, goal: draft.goal.trim() }))
              browserSession.removeItem(draftKey(scope));
          } finally {
            submitting.current = false;
            setSending(false);
          }
        }}
      >
        {followup && (
          <div className="composer-heading">
            <h2>继续对话</h2>
            <span>{projectName}</span>
          </div>
        )}
        <fieldset className="composer-fields" disabled={disabled}>
          <legend className="sr-only">任务内容与执行设置</legend>
          <Field label="任务需求" hiddenLabel>
            <textarea
              required
              maxLength={16000}
              ref={textarea}
              value={draft.goal}
              onChange={(event) => update({ goal: event.target.value })}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={
                followup ? "补充要求，或继续讨论这份结果…" : "描述你的需求，或聊聊这份代码…"
              }
              rows={followup ? 2 : 3}
            />
          </Field>
          <div className="form-row">
            <Field label="任务类型">
              <select
                value={draft.mode}
                onChange={(event) => update({ mode: event.target.value as TaskDraft["mode"] })}
              >
                <option value="edit">修改代码</option>
                <option value="read">理解代码</option>
                <option value="review">审查代码</option>
              </select>
            </Field>
            <Field label="执行器">
              <select
                value={executor}
                onChange={(event) =>
                  update({ executor: event.target.value, model: "", reasoningEffort: "" })
                }
              >
                {!executor && <option value="">没有可用执行器</option>}
                {settings.executors.map((item) => (
                  <option key={item.name} value={item.name} disabled={!item.installed}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <details className="composer-options">
            <summary>
              更多设置{" "}
              <span>
                {draft.model || "默认模型"} · {draft.reasoningEffort || "默认强度"} ·{" "}
                {draft.timeoutSeconds}s
              </span>
            </summary>
            <div className="form-row">
              <Field label="模型">
                <input
                  value={draft.model}
                  onChange={(event) => update({ model: event.target.value })}
                  placeholder="执行器默认模型"
                  list={`${id}-models`}
                  maxLength={256}
                />
              </Field>
              <datalist id={`${id}-models`}>
                {choices?.models?.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <Field label="推理强度">
                <input
                  value={draft.reasoningEffort}
                  onChange={(event) => update({ reasoningEffort: event.target.value })}
                  placeholder="执行器默认强度"
                  list={`${id}-efforts`}
                  maxLength={256}
                />
              </Field>
              <datalist id={`${id}-efforts`}>
                {choices?.reasoningEfforts?.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <Field label="超时（秒）">
                <input
                  required
                  type="number"
                  min={10}
                  max={1800}
                  step={1}
                  value={draft.timeoutSeconds || ""}
                  onChange={(event) => update({ timeoutSeconds: Number(event.target.value) })}
                />
              </Field>
            </div>
          </details>
        </fieldset>
        <div className="composer-footer">
          <p className="note">
            {blocked
              ? "请先确认上一条提交的结果。"
              : !canStart
                ? "请在侧栏选择项目后开始任务。"
                : !executor
                  ? "请先配置一个可用执行器。"
                  : followup
                    ? "携带本轮摘要与文件结果，在独立副本中继续。"
                    : "在独立副本中执行，修改由你审阅后应用。"}
            <span className="composer-shortcut">⌘ / Ctrl + Enter 发送 · 草稿保留在此标签页</span>
          </p>
          <Button
            type="submit"
            variant="primary"
            pending={sending}
            disabled={busy || blocked || !canStart || !executor || !draft.goal.trim()}
          >
            {sending ? "正在提交…" : followup ? "发送补充需求 ↗" : "开始任务 ↗"}
          </Button>
        </div>
      </form>
      {!followup && (
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
              disabled={disabled}
              onClick={() => {
                update({ goal: item.goal, mode: item.mode });
                textarea.current?.focus();
              }}
            >
              {item.label}
              <span aria-hidden="true">↗</span>
            </Button>
          ))}
        </div>
      )}
    </>
  );
}
