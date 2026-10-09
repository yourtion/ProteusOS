import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fixturePath, REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

const cliPath = fileURLToPath(new URL("../../src/app/cli.ts", import.meta.url));
const home = tempInstanceRoot();

function proteus(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", cliPath, ...args, "--home", home],
    {
      encoding: "utf8",
      cwd: REPO_ROOT,
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function proteusJson<T>(args: string[]): T {
  const r = proteus(args);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as T;
}

afterAll(() => {
  // 实例留在临时目录由系统清理；无需删除
});

/**
 * init → submit → runs/inspect 的完整闭环，
 * 每次 CLI 调用都是独立进程，同时验证持久化与“重启后可读”。
 */
describe("CLI 闭环", () => {
  it("init：创建身份并安装 G0", () => {
    const result = proteusJson<{
      snapshotId: string;
      revision: number;
      installed: boolean;
      versions: unknown[];
    }>(["init", "--json"]);
    expect(result.installed).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.versions).toHaveLength(3);
  });

  it("重复 init 幂等：同快照复用，不重复安装", () => {
    const first = proteusJson<{ snapshotId: string; installed: boolean }>(["init", "--json"]);
    const second = proteusJson<{ snapshotId: string; installed: boolean }>(["init", "--json"]);
    expect(second.installed).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it("submit：任务执行到 succeeded", () => {
    const summary = proteusJson<{
      runId: string;
      state: string;
      checks: Array<{ name: string; passed: boolean }>;
      experienceId: string;
    }>(["submit", fixturePath("tasks", "stats-a.yaml"), "--json"]);
    expect(summary.state).toBe("succeeded");
    expect(summary.checks.every((c) => c.passed)).toBe(true);
    expect(summary.experienceId).toBeTruthy();
  });

  it("runs <id>：新进程读取完整 Run 记录（重启后可读）", () => {
    const runs = proteusJson<Array<{ id: string; state: string }>>(["runs", "--json"]);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const succeeded = runs.find((r) => r.state === "succeeded")!;
    expect(succeeded).toBeTruthy();

    const detail = proteusJson<{
      run: { id: string; state: string; snapshotId: string };
      attempts: Array<{ state: string; exitCode: number }>;
      events: Array<{ streamId: string; type: string; seq: number }>;
      experience: { outcome: { result: string } } | null;
    }>(["runs", succeeded.id, "--json"]);
    expect(detail.run.state).toBe("succeeded");
    expect(detail.attempts[0]!.state).toBe("succeeded");
    expect(detail.events.map((e) => e.type)).toContain("experience.recorded");
    // DAG 的决策与节点完成事件进入账本
    expect(detail.events.map((e) => e.type)).toContain("decision.recorded");
    expect(detail.events.filter((e) => e.type === "node.completed")).toHaveLength(3);
    expect(detail.experience!.outcome.result).toBe("succeeded");

    // seq 唯一性与单调性在每个事件流内成立（docs/runtime.md §7）
    const byStream = new Map<string, number[]>();
    for (const e of detail.events) {
      byStream.set(e.streamId, [...(byStream.get(e.streamId) ?? []), e.seq]);
    }
    expect(byStream.size).toBeGreaterThanOrEqual(3); // run / process / attempt 三条流
    for (const seqs of byStream.values()) {
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it("inspect：按 ID 查看快照与任务", () => {
    const runs = proteusJson<Array<{ snapshotId: string; taskId: string }>>(["runs", "--json"]);
    const run = runs[0]!;

    const snapshot = proteusJson<{ kind: string; value: { bindings: Record<string, string> } }>([
      "inspect",
      run.snapshotId,
      "--json",
    ]);
    expect(snapshot.kind).toBe("snapshot");
    expect(Object.keys(snapshot.value.bindings).sort()).toEqual([
      "acceptance-evaluator",
      "routing-policy",
      "task-graph",
    ]);

    const task = proteusJson<{ kind: string; value: { goal: string } }>([
      "inspect",
      run.taskId,
      "--json",
    ]);
    expect(task.kind).toBe("task");
    expect(task.value.goal).toContain("统计摘要");
  });

  it("submit 错误 verifier：非零退出并说明原因", () => {
    const r = proteus(["submit", fixturePath("tasks", "wrong-verifier.yaml"), "--json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("verifier");
  });

  it("cancel 已终态 Run：无效果且不报错", () => {
    const runs = proteusJson<Array<{ id: string; state: string }>>(["runs", "--json"]);
    const done = runs.find((r) => r.state === "succeeded")!;
    const r = proteus(["cancel", done.id, "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).state).toBe("succeeded");
  });
});

describe("跨进程并发提交", () => {
  it("两个 CLI 进程同时提交，各自执行成功且可追溯", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const submitAsync = (task: string) =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx/esm", cliPath, "submit", task, "--json", "--home", home],
        { cwd: REPO_ROOT },
      );

    const [a, b] = await Promise.all([
      submitAsync(fixturePath("tasks", "stats-a.yaml")),
      submitAsync(fixturePath("tasks", "stats-b.yaml")),
    ]);
    const summaryA = JSON.parse(a.stdout) as { runId: string; state: string };
    const summaryB = JSON.parse(b.stdout) as { runId: string; state: string };
    expect(summaryA.state).toBe("succeeded");
    expect(summaryB.state).toBe("succeeded");
    expect(summaryA.runId).not.toBe(summaryB.runId);

    const runs = proteusJson<Array<{ id: string; state: string }>>(["runs", "--json"]);
    const succeededIds = runs.filter((r) => r.state === "succeeded").map((r) => r.id);
    expect(succeededIds).toEqual(expect.arrayContaining([summaryA.runId, summaryB.runId]));
  });
});
