import { expect, it } from "vitest";
import { SubmitInput } from "../../src/app/workbench/contracts.ts";
it("任务提交保留用户选择的模型和推理强度", () => {
  const input = SubmitInput.parse({
    projectId: "p",
    goal: "test",
    mode: "edit",
    executor: "my-acp",
    model: "my-model",
    reasoningEffort: "high",
    requestId: "request-model-selection",
  });
  expect(input).toMatchObject({ model: "my-model", reasoningEffort: "high" });
});

import { availableExecutor } from "../../src/app/workbench/execution-options.ts";
it("新表单只选择当前服务已启用且可用的执行器", () => {
  const settings = { defaultExecutor: "my-acp", executors: [{ name: "my-acp", installed: true }] };
  expect(availableExecutor(settings, "claude")).toBe("my-acp");
  expect(availableExecutor({ ...settings, defaultExecutor: "missing" })).toBe("my-acp");
  expect(availableExecutor({ ...settings, executors: [] })).toBe("");
});
