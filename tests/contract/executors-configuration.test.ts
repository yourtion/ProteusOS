import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executorConfiguration,
  loadExecutorAdapter,
  builtinExecutor,
} from "../../src/app/executor-adapter.ts";
import { buildExecutors } from "../../src/app/instance.ts";
import { Workbench } from "../../src/app/workbench/service.ts";

describe("可用执行器配置", () => {
  it("加载示例，包含 Pi/OpenCode 并向 Web 暴露默认选择", async () => {
    const config = await loadExecutorAdapter(
      fileURLToPath(new URL("../../examples/executors.config.mjs", import.meta.url)),
    );
    expect(executorConfiguration(config)).toMatchObject({
      enabled: ["codex", "claude", "pi", "opencode"],
      default: "pi",
    });
    const registry = buildExecutors(config);
    expect(registry.has("pi")).toBe(true);
    expect(registry.has("opencode")).toBe(true);
    const app = new Workbench({
      home: mkdtempSync(join(tmpdir(), "proteus-executors-")),
      executorAdapter: config,
    });
    try {
      expect(app.settings().defaultExecutor).toBe("pi");
      expect(app.settings().executors.map((e) => e.name)).toContain("opencode");
    } finally {
      await app.close();
    }
  });
  it("禁用执行器从 CLI 注册表和 Web 中移除，多个自定义实现可并存", () => {
    const adapter = (name: string) => ({
      version: "proteus-executor-adapter-v1" as const,
      name,
      create: vi.fn(),
    });
    const config = {
      version: "proteus-executors-v1" as const,
      enabled: ["first", "second"],
      default: "second",
      adapters: [adapter("first"), adapter("second")],
    };
    const registry = buildExecutors(config);
    expect([...registry.keys()].sort()).toEqual(["first", "local-process", "second"]);
    expect(() => executorConfiguration({ ...config, default: "pi" })).toThrow();
    expect(() => executorConfiguration({ ...config, enabled: ["missing"] })).toThrow();
    expect(() => executorConfiguration({ ...config, enabled: ["first", "first"] })).toThrow();
  });
  it("Pi 被拒绝时不会启动 SDK", async () => {
    const policy = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
    const result = await builtinExecutor("pi", policy).start({
      runId: "r",
      processId: "p",
      attemptId: "a",
      workspaceDir: "/tmp",
      prompt: "x",
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(policy).toHaveBeenCalledOnce();
  });
});
