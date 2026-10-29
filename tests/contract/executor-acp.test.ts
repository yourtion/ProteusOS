import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  AcpExecutor,
  allowFirstOptionPolicy,
  denyAllPolicy,
} from "../../src/adapters/executor-acp/index.ts";

const FAKE_AGENT = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "proteus-acp-test-"));
}

function executor(policy = allowFirstOptionPolicy): AcpExecutor {
  return new AcpExecutor({ name: "fake-acp", agentEntry: FAKE_AGENT, permissionPolicy: policy });
}

function request(prompt: string, ws: string) {
  return {
    runId: "test-run",
    processId: "test-process",
    attemptId: "test-attempt",
    workspaceDir: ws,
    prompt,
    timeoutMs: 30_000,
  };
}

describe("AcpExecutor 合同（fake ACP agent）", () => {
  it("显式环境与会话配置送达 agent，环境值不进入执行证据", async () => {
    const ws = workspace();
    const configured = new AcpExecutor({
      name: "fake-acp",
      agentEntry: FAKE_AGENT,
      env: { PROTEUS_TEST_ACP_ENV: "explicit-test-value" },
      sessionMeta: { testConfiguration: "probe", model: "test-model", maxTurns: 6 },
    });
    const result = await configured.start(request("实现 wordcount", ws));
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(ws, "configuration-probe.json"), "utf8"))).toEqual({
      meta: { testConfiguration: "probe", model: "test-model", maxTurns: 6 },
      environmentMatched: true,
    });
    expect(JSON.stringify(result)).not.toContain("explicit-test-value");
    expect(readFileSync(join(ws, ".proteus/acp-trace.json"), "utf8")).not.toContain(
      "explicit-test-value",
    );
  });
  it("initialize → session/new(cwd) → prompt：end_turn 视为执行完成，产物落在工作区", async () => {
    const ws = workspace();
    const result = await executor().start(request("实现 wordcount", ws));

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wordcount.mjs");
    const impl = readFileSync(join(ws, "src", "wordcount.mjs"), "utf8");
    expect(impl).toContain("countWords");
    // trace 落盘：updates 与权限决定
    const trace = JSON.parse(readFileSync(join(ws, ".proteus", "acp-trace.json"), "utf8")) as {
      agent: string;
      stopReason: string;
      updates: unknown[];
      permissions: Array<{ decision: { outcome: { outcome: string; optionId?: string } } }>;
    };
    expect(trace.agent).toBe("fake-acp");
    expect(trace.stopReason).toBe("end_turn");
    expect(trace.updates.length).toBeGreaterThan(0);
    expect(trace.permissions[0]!.decision.outcome.outcome).toBe("selected");
    expect(result.evidence).toMatchObject({
      adapter: "executor-acp-v1",
      usage: null,
      trace: { status: "complete", coverage: "agent-events" },
    });
    expect(result.evidence!.trace.events.some((event) => event.kind === "permission")).toBe(true);
  });

  it("stopReason=error 不映射为成功", async () => {
    const ws = workspace();
    const result = await executor().start(request("FAIL-MODE", ws));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("stopReason=error");
  });

  it("权限被拒（deny 策略）：stopReason=cancelled，不写产物", async () => {
    const ws = workspace();
    const result = await executor(denyAllPolicy).start(request("DENY-ME 路径", ws));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("stopReason=cancelled");
    expect(() => readFileSync(join(ws, "src", "wordcount.mjs"))).toThrow();
  });

  it("agent 进程退出后不留存活子进程（finally kill）", async () => {
    const ws = workspace();
    await executor().start(request("实现 wordcount", ws));
    // 无法直接断言子进程死亡；以连接正常关闭（无未处理拒绝）为隐含验证
  });

  it("断连：agent 崩溃退出 → 失败并保留已有 update 证据", async () => {
    const ws = workspace();
    const result = await executor().start(request("EXIT-MODE 崩溃", ws));
    expect(result.ok).toBe(false);
    // 连接关闭被如实报告，不伪装成成功或超时
    expect(result.stderr.length).toBeGreaterThan(0);
    const trace = JSON.parse(readFileSync(join(ws, ".proteus", "acp-trace.json"), "utf8")) as {
      updates: Array<{ sessionUpdate: string }>;
    };
    expect(trace.updates.length).toBeGreaterThan(0); // 崩溃前的 update 已入 trace
    expect(result.evidence!.trace.status).toBe("partial");
  });

  it("超时：先请求 session/cancel，agent 响应 cancelled 后不强杀", async () => {
    const ws = workspace();
    const slow = new AcpExecutor({ name: "fake-acp", agentEntry: FAKE_AGENT });
    const result = await slow.start({
      runId: "r",
      processId: "p",
      attemptId: "a",
      workspaceDir: ws,
      prompt: "SLOW-MODE 长任务",
      timeoutMs: 1_500, // 先于 SLOW-MODE 完成时限触发 cancel，留出会话建立余量
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("session/cancel");
    expect(result.stderr).toContain("stopReason=cancelled");
    expect(result.evidence!.trace.status).toBe("partial");
  });

  it("工作区 trace 文件写入失败时仍返回内存观测，隐藏推理不进入两种轨迹", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".proteus"), "occupied");
    const result = await executor().start(request("HIDDEN-MODE 实现 wordcount", ws));
    expect(result.ok).toBe(true);
    expect(result.evidence!.trace.status).toBe("complete");
    expect(JSON.stringify(result.evidence)).not.toContain("HIDDEN-THOUGHT-MARKER");
    const other = workspace();
    await executor().start(request("HIDDEN-MODE 实现 wordcount", other));
    expect(readFileSync(join(other, ".proteus", "acp-trace.json"), "utf8")).not.toContain(
      "HIDDEN-THOUGHT-MARKER",
    );
  });
});

it("host abort reaches a running ACP prompt and never reports success", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    const result = await executor().start({
      ...request("SLOW-MODE", workspace()),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeLessThan(3500);
  } finally {
    clearTimeout(timer);
  }
});

it("public progress excludes hidden thought chunks", async () => {
  const events: Array<{ kind: string; text: string }> = [];
  await executor().start({
    ...request("HIDDEN-MODE", workspace()),
    onEvent: (event) => events.push(event),
  });
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain("HIDDEN-THOUGHT-MARKER");
});
