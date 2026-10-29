import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openInstance } from "../../src/app/instance.ts";
import { LocalProcessExecutor } from "../../src/adapters/executor-process/index.ts";
import {
  ExecutionTrace,
  readExecutionTrace,
  readExecutionAccounting,
} from "../../src/runtime/execution-evidence.ts";
import { AcpAccounting } from "../../src/adapters/executor-acp/accounting.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { bootSeededInstance, fixturePath, REPO_ROOT } from "../helpers.ts";

const task = {
  requestedBy: "principal-local",
  goal: "统计测试文本",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};
const real = () =>
  new LocalProcessExecutor(join(REPO_ROOT, "src/adapters/executor-process/stats-worker.mjs"));

describe("执行证据持久化", () => {
  it("live progress is persisted before completion; a long stream cannot hide terminal evidence; usage survives reopen and detects tampering", async () => {
    const accounting = new AcpAccounting(true);
    accounting.observeSdk({
      message: {
        type: "result",
        modelUsage: {
          model: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
          },
        },
      },
    });
    const executor: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "manual",
      async start(request) {
        for (let i = 0; i < 1005; i++)
          request.onProgress?.({
            phase: "working",
            elapsedMs: i,
            messageChars: i,
            toolCalls: 0,
            lastActivityAt: Date.now(),
            detail: null,
          });
        expect(app.runtime.getRunSummary(request.runId).attempts[0]?.progress?.messageChars).toBe(
          1004,
        );
        expect(app.runtime.getRunSummary(request.runId).state).toBe("running");
        const output = await real().start(request);
        output.evidence!.accounting = accounting.snapshot(true);
        return output;
      },
    };
    const app = bootSeededInstance(undefined, new Map([[executor.name, executor]]));
    let runId = "";
    try {
      const summary = await app.runtime.submitTask(task);
      runId = summary.runId;
      expect(summary.state).toBe("succeeded");
      expect(summary.nodes.some((n) => n.state === "succeeded")).toBe(true);
      expect(
        readExecutionAccounting(summary.attempts[0]!.evidence!, app.blobs)?.totals?.totalTokens,
      ).toBe(100);
    } finally {
      app.close();
    }
    const reopened = openInstance(app.root);
    try {
      const evidence = reopened.runtime.getRunSummary(runId).attempts[0]!.evidence!;
      expect(readExecutionAccounting(evidence, reopened.blobs)?.tokenStatus).toBe("complete");
      expect(() =>
        readExecutionAccounting({ ...evidence, accountingDigest: "wrong" }, reopened.blobs),
      ).toThrow(/digest_mismatch/);
      expect(
        readExecutionAccounting({ ...evidence, accounting: undefined }, reopened.blobs),
      ).toBeNull();
    } finally {
      reopened.close();
    }
  });
  it("执行结果提交后宿主崩溃，恢复沿已记录节点续跑且不重复执行", async () => {
    let calls = 0;
    const executor: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "manual",
      start: async (request) => {
        calls++;
        return real().start(request);
      },
    };
    const app = bootSeededInstance(undefined, new Map([[executor.name, executor]]));
    const original = app.storage.tx.bind(app.storage);
    let crashed = false;
    const crashAfterCommit = <T>(fn: () => T): T => {
      const value = original(fn);
      const run = app.storage.listRunsByStates(["running"], 1)[0];
      if (
        !crashed &&
        run &&
        app.storage
          .listProcesses(run.id)
          .flatMap((process) => app.storage.listAttempts(process.id))
          .some((attempt) => attempt.state === "succeeded")
      ) {
        crashed = true;
        throw new Error("crash_after_attempt_commit");
      }
      return value;
    };
    const tx = vi.spyOn(app.storage, "tx").mockImplementation(crashAfterCommit);
    try {
      await expect(
        app.runtime.submitTask({ ...task, budget: { ...task.budget, maxAttempts: 2 } }),
      ).rejects.toThrow("crash_after_attempt_commit");
      tx.mockRestore();
      const run = app.storage.listRunsByStates(["running"], 1)[0]!;
      expect(app.runtime.getRunSummary(run.id).attempts[0]!.evidence!.traceStatus).toBe("complete");
      await app.runtime.recoverRun(run.id);
      expect(app.runtime.getRunSummary(run.id).state).toBe("succeeded");
      expect(calls).toBe(1);
      expect(app.runtime.getRunSummary(run.id).attempts).toHaveLength(1);
    } finally {
      tx.mockRestore();
      app.close();
    }
  });

  it("清理工作区并重开实例后仍能读取同一 trace 和输入输出摘要，损坏内容拒绝回放", async () => {
    const app = bootSeededInstance();
    const root = app.root;
    let runId: string;
    try {
      const run = await app.runtime.submitTask(task);
      runId = run.runId;
      expect(run.state).toBe("succeeded");
      const evidence = run.attempts[0]!.evidence!;
      expect(evidence).toMatchObject({
        traceStatus: "complete",
        traceCoverage: "lifecycle",
        usage: null,
      });
      expect(evidence.inputDigest).toHaveLength(64);
      expect(evidence.outputDigest).toHaveLength(64);
      expect(readExecutionTrace(evidence, app.blobs)?.events.map((event) => event.kind)).toEqual([
        "process.started",
        "process.completed",
      ]);
    } finally {
      app.close();
    }
    rmSync(join(root, "workspaces"), { recursive: true });
    const reopened = openInstance(root);
    try {
      const evidence = reopened.runtime.getRunSummary(runId!).attempts[0]!.evidence!;
      expect(readExecutionTrace(evidence, reopened.blobs)?.status).toBe("complete");
      expect(() =>
        readExecutionTrace({ ...evidence, traceDigest: "wrong" }, reopened.blobs),
      ).toThrow(/digest_mismatch/);
      rmSync(join(root, "blobs", evidence.traceRef!));
      expect(() => readExecutionTrace(evidence, reopened.blobs)).toThrow();
    } finally {
      reopened.close();
    }
  });

  it("trace 保存失败仍保留执行事实并且不重派，失败证据随 Attempt 原子记录", async () => {
    let calls = 0;
    const executor: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "manual",
      start: async (request) => {
        calls++;
        return real().start(request);
      },
    };
    const app = bootSeededInstance(undefined, new Map([[executor.name, executor]]));
    const original = app.blobs.write.bind(app.blobs);
    const write = vi.spyOn(app.blobs, "write").mockImplementation((content) => {
      if (content.includes('"coverage":"lifecycle"')) throw new Error("trace storage unavailable");
      return original(content);
    });
    try {
      const run = await app.runtime.submitTask(task);
      expect(run.state).toBe("succeeded");
      expect(run.attempts[0]!.evidence).toMatchObject({
        traceStatus: "failed",
        traceRef: null,
        detail: "trace_persistence_failed",
      });
      await app.runtime.recoverRun(run.runId);
      expect(calls).toBe(1);
      expect(app.runtime.getRunSummary(run.runId).attempts).toHaveLength(1);
    } finally {
      write.mockRestore();
      app.close();
    }
  });

  it("旧 Adapter 缺证据时返回 unavailable，不能根据任务完成推断零成本", async () => {
    const executor: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "manual",
      start: async (request) => {
        const { evidence: _evidence, ...result } = await real().start(request);
        return result;
      },
    };
    const app = bootSeededInstance(undefined, new Map([[executor.name, executor]]));
    try {
      const run = await app.runtime.submitTask(task);
      expect(run.state).toBe("succeeded");
      expect(run.attempts[0]!.evidence).toMatchObject({ traceStatus: "unavailable", usage: null });
      expect(readExecutionTrace(run.attempts[0]!.evidence, app.blobs)).toBeNull();
    } finally {
      app.close();
    }
  });

  it("旧 Attempt 没有新事件时保留缺项，失败执行也持久化已有 partial 轨迹", async () => {
    const trace = new ExecutionTrace();
    trace.record("tool", { status: "started" });
    const executor: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "manual",
      start: async () => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "failure",
        durationMs: 1,
        outputRef: null,
        evidence: trace.finish("fixture", "agent-events", false),
      }),
    };
    const app = bootSeededInstance(undefined, new Map([[executor.name, executor]]));
    try {
      const run = await app.runtime.submitTask(task);
      expect(run.state).toBe("failed");
      expect(readExecutionTrace(run.attempts[0]!.evidence, app.blobs)?.status).toBe("partial");
      // 模拟尚无轨迹事件的历史持久记录；不从结果反推执行历史。
      const { SqliteDb } = await import("../../src/storage/sqlite.ts");
      const db = new SqliteDb(join(app.root, "metadata.sqlite"));
      try {
        db.run(
          "DELETE FROM events WHERE type = 'attempt.evidence.recorded' AND run_id = ?",
          run.runId,
        );
      } finally {
        db.close();
      }
      expect(app.runtime.getRunSummary(run.runId).attempts[0]!.evidence).toBeUndefined();
    } finally {
      app.close();
    }
  });

  it("本地子进程输出截断会标为 partial", async () => {
    const app = bootSeededInstance();
    try {
      const script = join(app.root, "large-output.mjs");
      writeFileSync(
        script,
        'import { writeFileSync } from "node:fs"; import { join } from "node:path"; process.stdout.write("x".repeat(100000)); writeFileSync(join(process.argv[2], "output.json"), "{}");',
      );
      const workspace = join(app.root, "tmp");
      const result = await new LocalProcessExecutor(script).start({
        runId: "large",
        processId: "p",
        attemptId: "a",
        workspaceDir: workspace,
        prompt: "",
        timeoutMs: 5000,
      });
      expect(result.ok).toBe(true);
      expect(result.evidence).toMatchObject({
        stdoutTruncated: true,
        trace: { status: "partial" },
      });
      expect(result.stdout.length).toBeLessThan(100000);
    } finally {
      app.close();
    }
  });
});
