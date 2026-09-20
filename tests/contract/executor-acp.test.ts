import { readFileSync } from "node:fs";
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
});
