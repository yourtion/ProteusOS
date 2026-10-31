import { SubmitInput, type Submission } from "../../src/app/workbench/contracts.ts";
import { ApiError } from "./api.ts";
import { draftKey } from "./task-draft.ts";
import type { SessionStore } from "./session.ts";
const key = "proteus-pending";
/** One unresolved admission at a time. Retries always reuse its exact body and request ID. */
export function createSubmissionQueue(
  storage: SessionStore,
  send: (body: Submission) => Promise<{ runId: string }>,
) {
  let pending: Submission | null = null;
  try {
    const saved = storage.getItem(key);
    if (saved) pending = SubmitInput.parse(JSON.parse(saved));
  } catch {
    storage.removeItem(key);
  }
  let flight: Promise<{ runId: string }> | undefined;
  const listeners = new Set<() => void>();
  function publish(value: Submission | null) {
    pending = value;
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
    for (const listener of listeners) listener();
  }
  function retry(): Promise<{ runId: string }> {
    if (flight) return flight;
    if (!pending) return Promise.reject(new Error("没有等待确认的提交"));
    const body = pending;
    flight = Promise.resolve()
      .then(() => send(body))
      .then((result) => {
        if (!result || typeof result.runId !== "string" || !result.runId)
          throw new Error("未收到有效任务回执，请重试同一提交");
        storage.removeItem(
          draftKey(body.parentId ? `followup:${body.parentId}` : `new:${body.projectId}`),
        );
        publish(null);
        return result;
      })
      .catch((error) => {
        // Authentication, throttling and transport failures do not prove non-admission.
        if (error instanceof ApiError && [400, 404, 409, 422].includes(error.status)) publish(null);
        throw error;
      })
      .finally(() => {
        flight = undefined;
      });
    return flight;
  }
  return {
    getSnapshot: () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit(body: Submission) {
      if (pending) return Promise.reject(new Error("请先确认上一条提交的结果，避免重复创建任务"));
      publish(SubmitInput.parse(body));
      return retry();
    },
    retry,
  };
}
