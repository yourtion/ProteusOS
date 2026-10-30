import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { Workbench } from "../../src/app/workbench/service.ts";
import { loadExecutorAdapter } from "../../src/app/executor-adapter.ts";
async function waitFor<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout");
}
it("示例 ACP 文件在工作台注册、请求审批并完成任务；未知执行器拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-custom-web-"));
  const projectDir = join(root, "project");
  execFileSync("git", ["init", "-q", projectDir]);
  writeFileSync(join(projectDir, "input.txt"), "hello");
  vi.stubEnv("MY_ACP_COMMAND", process.execPath);
  vi.stubEnv(
    "MY_ACP_ARGS",
    JSON.stringify([fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url))]),
  );
  const adapter = await loadExecutorAdapter(
    fileURLToPath(new URL("../../examples/executor-adapter.mjs", import.meta.url)),
  );
  const app = new Workbench({ home: join(root, "home"), executorAdapter: adapter });
  try {
    await app.initialize();
    expect(app.settings().executors).toContainEqual({ name: "my-acp", installed: true });
    const project = app.addProject({ path: projectDir });
    const input = {
      projectId: project.id,
      goal: "实现 wordcount",
      mode: "edit",
      executor: "my-acp",
      requestId: crypto.randomUUID(),
    };
    expect(() => app.submit({ ...input, executor: "missing" })).toThrow("unknown_executor");
    const { runId } = app.submit(input);
    const interaction = await waitFor(() => app.interactions().find((i) => i.state === "pending"));
    app.reply(interaction.id, "allow_once");
    await waitFor(() => app.detail(runId).run?.state === "succeeded");
    expect(app.work(runId).result?.changes.some((c) => c.path === "src/wordcount.mjs")).toBe(true);
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
