import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { TaskComposer } from "../src/TaskComposer";
import { draftFor, draftKey } from "../src/task-draft";
import type { Work } from "../../src/app/workbench/contracts";
const settings = {
  defaultExecutor: "codex",
  executors: [
    { name: "codex", installed: true, models: ["default-model"], reasoningEfforts: ["high"] },
    { name: "claude", installed: true },
  ],
};
const props = {
  scope: "new:p",
  initial: { ...draftFor(settings), goal: "Implement feature" },
  settings,
  busy: false,
  blocked: false,
  canStart: true,
  onSubmit: async () => true,
};
afterEach(() => vi.unstubAllGlobals());
it("keeps the reply beside its result and inherits the selected executor options", () => {
  const parent = {
    executor: "codex",
    model: "default-model",
    reasoningEffort: "high",
    mode: "review",
  } as Work;
  const html = render(
    <TaskComposer
      {...props}
      initial={draftFor(settings, parent)}
      followup
      projectName="Original repo"
    />,
  );
  expect(html).toContain('aria-label="补充需求"');
  expect(html).toContain("Original repo");
  expect(html).toContain('value="review" selected=""');
  expect(html).toContain('value="default-model"');
  expect(html).toContain("发送补充需求");
  expect(html).not.toContain("任务示例");
});
it("disables the form and new submission while a previous admission is unresolved", () => {
  const html = render(<TaskComposer {...props} blocked />);
  expect(html).toContain('<fieldset class="composer-fields" disabled=""');
  expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  expect(html).toContain("请先确认上一条提交");
});
it("explains why no project or executor can start a task", () => {
  const noProject = render(<TaskComposer {...props} canStart={false} />);
  expect(noProject).toContain("请在侧栏选择项目");
  expect(noProject).toMatch(/type="submit"[^>]*disabled=""/);
  const noExecutor = render(
    <TaskComposer {...props} settings={{ defaultExecutor: "", executors: [] }} />,
  );
  expect(noExecutor).toContain("没有可用执行器");
  expect(noExecutor).toMatch(/type="submit"[^>]*disabled=""/);
});
it("restores only this scope's draft and clears incompatible options when an executor disappears", () => {
  const draft = {
    ...props.initial,
    executor: "removed",
    model: "obsolete-model",
    reasoningEffort: "obsolete-effort",
    goal: "Saved requirement",
  };
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => (key === draftKey(props.scope) ? JSON.stringify(draft) : null),
    setItem() {},
    removeItem() {},
  });
  const html = render(<TaskComposer {...props} />);
  expect(html).toContain("Saved requirement");
  expect(html).toContain('value="codex" selected=""');
  expect(html).not.toContain("obsolete-model");
  expect(html).not.toContain("obsolete-effort");
  expect(render(<TaskComposer {...props} scope="followup:other" />)).not.toContain(
    "Saved requirement",
  );
});

it("locks the composer during other operations without claiming a task is being submitted", () => {
  const html = render(<TaskComposer {...props} busy />);
  expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  expect(html).not.toContain("正在提交");
});
