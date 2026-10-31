import {
  availableExecutor,
  type ExecutorSettings,
} from "../../src/app/workbench/execution-options.ts";
import type { Submission, Work } from "../../src/app/workbench/contracts.ts";
import type { SessionStore } from "./session.ts";
export interface TaskDraft {
  goal: string;
  mode: "read" | "review" | "edit";
  executor: string;
  model: string;
  reasoningEffort: string;
  timeoutSeconds: number;
}
export function draftFor(settings: ExecutorSettings, parent?: Work): TaskDraft {
  const executor = availableExecutor(settings, parent?.executor);
  return {
    goal: "",
    mode: parent?.mode ?? "edit",
    executor,
    model: executor === parent?.executor ? (parent?.model ?? "") : "",
    reasoningEffort: executor === parent?.executor ? (parent?.reasoningEffort ?? "") : "",
    timeoutSeconds: 300,
  };
}
export const draftKey = (scope: string) => `proteus-draft-v1:${scope}`;
export function readDraft(storage: SessionStore, scope: string, fallback: TaskDraft): TaskDraft {
  try {
    const draft = JSON.parse(storage.getItem(draftKey(scope)) ?? "null") as TaskDraft | null;
    if (
      !draft ||
      typeof draft.goal !== "string" ||
      draft.goal.length > 16000 ||
      !["read", "review", "edit"].includes(draft.mode) ||
      typeof draft.executor !== "string" ||
      typeof draft.model !== "string" ||
      typeof draft.reasoningEffort !== "string" ||
      !Number.isInteger(draft.timeoutSeconds) ||
      draft.timeoutSeconds < 10 ||
      draft.timeoutSeconds > 1800
    )
      return fallback;
    return draft;
  } catch {
    return fallback;
  }
}

/** A continuation always targets its parent's project, regardless of the sidebar filter. */
export function submissionFor(
  draft: TaskDraft,
  projectId: string,
  requestId: string,
  parent?: Pick<Work, "id" | "projectId">,
): Submission {
  return {
    ...draft,
    projectId: parent?.projectId ?? projectId,
    requestId,
    goal: draft.goal.trim(),
    model: draft.model.trim() || undefined,
    reasoningEffort: draft.reasoningEffort.trim() || undefined,
    parentId: parent?.id,
  };
}
