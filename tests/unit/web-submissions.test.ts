import { expect, it, vi } from "vitest";
import type { Submission } from "../../src/app/workbench/contracts.ts";
import { ApiError } from "../../web/src/api.ts";
import { safeStorage, type SessionStore } from "../../web/src/session.ts";
import { createSubmissionQueue } from "../../web/src/submissions.ts";
import { draftFor, draftKey, readDraft, submissionFor } from "../../web/src/task-draft.ts";
const body: Submission = {
  projectId: "project",
  goal: "修复问题",
  mode: "edit",
  executor: "codex",
  timeoutSeconds: 300,
  requestId: "same-request",
};
const settings = { executors: [{ name: "codex", installed: true }], defaultExecutor: "codex" };
function memory(): SessionStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}
it("keeps an uncertain submission across reload and retries its exact request", async () => {
  const storage = memory();
  const failed = createSubmissionQueue(
    storage,
    vi.fn().mockRejectedValue(new TypeError("lost response")),
  );
  await expect(failed.submit(body)).rejects.toThrow("lost response");
  const send = vi.fn().mockResolvedValue({ runId: "accepted" });
  const reloaded = createSubmissionQueue(storage, send);
  expect(reloaded.getSnapshot()).toEqual(body);
  await expect(reloaded.submit({ ...body, requestId: "different-request" })).rejects.toThrow(
    "上一条",
  );
  await expect(reloaded.retry()).resolves.toEqual({ runId: "accepted" });
  expect(send).toHaveBeenCalledExactlyOnceWith(body);
  expect(storage.getItem("proteus-pending")).toBeNull();
});
it("coalesces retries while a response is in flight and notifies state subscribers", async () => {
  const send = vi.fn().mockResolvedValue({ runId: "accepted" });
  const queue = createSubmissionQueue(memory(), send);
  const listener = vi.fn();
  const unsubscribe = queue.subscribe(listener);
  const first = queue.submit(body);
  expect(queue.retry()).toBe(first);
  await first;
  expect(send).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(queue.getSnapshot()).toBeNull();
  unsubscribe();
});
it("retains unauthorized, throttled and malformed responses but releases rejected inputs", async () => {
  for (const status of [401, 403, 408, 429, 500]) {
    const queue = createSubmissionQueue(
      memory(),
      vi.fn().mockRejectedValue(new ApiError("retry", status)),
    );
    await expect(queue.submit(body)).rejects.toThrow("retry");
    expect(queue.getSnapshot()).toEqual(body);
  }
  const rejected = createSubmissionQueue(
    memory(),
    vi.fn().mockRejectedValue(new ApiError("invalid model", 400)),
  );
  await expect(rejected.submit(body)).rejects.toThrow("invalid model");
  expect(rejected.getSnapshot()).toBeNull();
  const invalid = createSubmissionQueue(memory(), vi.fn().mockResolvedValue({}));
  await expect(invalid.submit(body)).rejects.toThrow("有效任务回执");
  expect(invalid.getSnapshot()).toEqual(body);
});
it("clears only the accepted task's draft, including receipts recovered after reload", async () => {
  const storage = memory();
  storage.setItem(draftKey("followup:parent"), "first");
  storage.setItem(draftKey("new:project"), "another draft");
  storage.setItem("proteus-pending", JSON.stringify({ ...body, parentId: "parent" }));
  const queue = createSubmissionQueue(storage, vi.fn().mockResolvedValue({ runId: "accepted" }));
  await queue.retry();
  expect(storage.getItem(draftKey("followup:parent"))).toBeNull();
  expect(storage.getItem(draftKey("new:project"))).toBe("another draft");
});
it("isolates new-task and reply drafts and rejects invalid saved data", () => {
  const storage = memory();
  const fallback = draftFor(settings);
  storage.setItem(draftKey("new:p1"), JSON.stringify({ ...fallback, goal: "unfinished" }));
  expect(readDraft(storage, "new:p1", fallback).goal).toBe("unfinished");
  expect(readDraft(storage, "new:p2", fallback).goal).toBe("");
  expect(readDraft(storage, "followup:p1", fallback).goal).toBe("");
  storage.setItem(draftKey("new:p1"), JSON.stringify({ ...fallback, timeoutSeconds: -5 }));
  expect(readDraft(storage, "new:p1", fallback)).toEqual(fallback);
  storage.setItem("proteus-pending", "corrupt");
  expect(createSubmissionQueue(storage, vi.fn()).getSnapshot()).toBeNull();
});
it("continues in memory when browser storage is unavailable", async () => {
  const storage = safeStorage(() => {
    throw new Error("SecurityError");
  });
  const queue = createSubmissionQueue(storage, vi.fn().mockResolvedValue({ runId: "accepted" }));
  await expect(queue.submit(body)).resolves.toEqual({ runId: "accepted" });
  expect(readDraft(storage, "new:p", draftFor(settings))).toEqual(draftFor(settings));
});

it("binds a reply to its parent project even when the sidebar shows all or another project", () => {
  const draft = { ...draftFor(settings), goal: "  continue  ", model: " custom-model " };
  for (const projectId of ["", "other-project"]) {
    expect(
      submissionFor(draft, projectId, "request-id", { id: "parent", projectId: "original" }),
    ).toMatchObject({
      projectId: "original",
      parentId: "parent",
      goal: "continue",
      model: "custom-model",
      requestId: "request-id",
    });
  }
  expect(submissionFor(draft, "new-project", "request-id").parentId).toBeUndefined();
});
