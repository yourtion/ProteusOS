import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { startWorkbench } from "../../src/app/web/server.ts";
import type { ExecutorAdapter } from "../../src/app/executor-adapter.ts";
import {
  availableExecutor,
  type ExecutorSettings,
} from "../../src/app/workbench/execution-options.ts";

it("用户三执行器配置：HTTP 列表、表单选择、模型/强度、审批及结果一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-executor-flow-"));
  const projectDir = join(root, "project");
  execFileSync("git", ["init", "-q", projectDir]);
  writeFileSync(join(projectDir, "input.txt"), "hello");
  const custom = (name: string): ExecutorAdapter => ({
    version: "proteus-executor-adapter-v1",
    name,
    create: ({ createAcpExecutor }) =>
      createAcpExecutor({
        command: process.execPath,
        agentArgs: [fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url))],
        env: { ...process.env, PROTEUS_TEST_CONFIG_OPTIONS: "1" },
      }),
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const server = startWorkbench(0, join(root, "instance"), {
    executorAdapter: {
      version: "proteus-executors-v1",
      enabled: ["traex", "opencode-w", "pi"],
      default: "traex",
      adapters: [custom("traex"), custom("opencode-w")],
      choices: { traex: { models: ["my-model"], reasoningEfforts: ["high"] } },
    },
  });
  try {
    await once(server, "listening");
    await server.workbench.initialize();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    const token = String(log.mock.calls.at(-1)?.[0]).split("#")[1];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path: string, body?: unknown) =>
      fetch(base + "/api/" + path, {
        headers,
        method: body === undefined ? "GET" : "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const settings = (await (await api("settings")).json()) as ExecutorSettings;
    expect(settings.executors.map((e) => e.name)).toEqual(["traex", "opencode-w", "pi"]);
    const executor = availableExecutor(settings, "claude");
    expect(executor).toBe("traex");
    expect(settings.executors[0]).toMatchObject({
      models: ["my-model"],
      reasoningEfforts: ["high"],
    });
    const project = (await (await api("projects", { path: projectDir })).json()) as { id: string };
    const input = {
      projectId: project.id,
      goal: "实现 wordcount",
      mode: "edit",
      executor,
      model: "my-model",
      reasoningEffort: "high",
      requestId: crypto.randomUUID(),
    };
    expect((await api("runs", { ...input, model: "unsupported" })).status).toBe(400);
    const response = await api("runs", input);
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    let approved = false;
    for (let i = 0; i < 250; i++) {
      const detail = (await (await api(`runs/${runId}`)).json()) as {
        interactions?: Array<{ id: string; state: string }>;
        run?: { state: string };
        error?: string;
      };
      const interaction = detail.interactions?.find(
        (item: { state: string }) => item.state === "pending",
      );
      if (interaction) {
        expect(
          (await api(`interactions/${interaction.id}/reply`, { choice: "allow_once" })).status,
        ).toBe(200);
        approved = true;
      }
      if (detail.run?.state === "succeeded") break;
      if (detail.run?.state === "failed") throw new Error(`task failed: ${detail.error}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(approved).toBe(true);
    const final = await (await api(`runs/${runId}`)).json();
    expect(final).toMatchObject({
      executor: "traex",
      model: "my-model",
      reasoningEffort: "high",
      run: { state: "succeeded" },
    });
    const rootResponse = await fetch(base + "/");
    expect(rootResponse.headers.get("cache-control")).toBe("no-store");
  } finally {
    await server.shutdown();
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
