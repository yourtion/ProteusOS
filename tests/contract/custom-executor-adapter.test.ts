import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  loadExecutorAdapter,
  executorFromAdapter,
  checkedExecutorAdapter,
  type ExecutorAdapter,
} from "../../src/app/executor-adapter.ts";
import { allowFirstOptionPolicy, AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
const agent = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));
const request = (prompt = "实现 wordcount") => ({
  runId: "r",
  processId: "p",
  attemptId: "a",
  workspaceDir: mkdtempSync(join(tmpdir(), "proteus-custom-executor-")),
  prompt,
  timeoutMs: 10000,
});

it("从独立文件加载并通过真实 ACP stdio 命令执行，权限由宿主注入", async () => {
  const file = join(request().workspaceDir, "my executor.mjs");
  writeFileSync(
    file,
    `export default async () => ({ version: 'proteus-executor-adapter-v1', name: 'test-acp', create({createAcpExecutor}) { return createAcpExecutor({command: ${JSON.stringify(process.execPath)}, agentArgs: [${JSON.stringify(agent)}]}); } });`,
  );
  const adapter = checkedExecutorAdapter(await loadExecutorAdapter(file));
  const permission = vi.fn(allowFirstOptionPolicy);
  const provider = executorFromAdapter(adapter, permission);
  expect((await provider.start(request())).ok).toBe(true);
  expect(permission).toHaveBeenCalled();
  expect((await executorFromAdapter(adapter).start(request("DENY-ME"))).ok).toBe(false);
});

it("初始化取消不派发迟到的执行器", async () => {
  const start = vi.fn();
  let finish!: (value: unknown) => void;
  const adapter: ExecutorAdapter = {
    version: "proteus-executor-adapter-v1",
    name: "test",
    create: () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish;
      }),
  };
  const controller = new AbortController();
  const pending = executorFromAdapter(adapter).start({ ...request(), signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow();
  finish({ name: "test", recoveryPolicy: "manual", start });
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
});

it("坏模块与重名拒绝；缺失 ACP 命令返回失败而不崩溃", async () => {
  expect(() =>
    checkedExecutorAdapter({
      version: "proteus-executor-adapter-v1",
      name: "local-process",
      create() {},
    }),
  ).toThrow("冲突");
  await expect(loadExecutorAdapter("https://host/adapter.mjs")).rejects.toThrow("本地文件");
  await expect(loadExecutorAdapter("/tmp/nonexistent-proteus-executor.mjs")).rejects.toThrow(
    "加载失败",
  );
  const result = await new AcpExecutor({ name: "test", command: "/nonexistent/acp-command" }).start(
    request(),
  );
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("ENOENT");
});
