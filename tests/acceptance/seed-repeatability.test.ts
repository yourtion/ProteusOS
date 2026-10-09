import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { installCustomGenome, fixturePath, REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

/**
 * 验收固化（roadmap M0 完成判据）：
 * 1. 不调用模型完成固定任务          —— 本文件 + 全部套件无任何模型调用
 * 2. 两个并发 Run 可追溯            —— tests/acceptance/cli-basic-loop.test.ts
 * 3. 重启恢复                        —— tests/integration/recovery.test.ts
 * 4. 未知副作用不重复派发            —— unknown → 对账（同上）
 * 5. 人工安装 seed 快照可重复        —— 本文件
 * 另含 Snapshot 固定：默认指针变化不改变既有 Run 的绑定。
 */

const cliPath = fileURLToPath(new URL("../../src/app/cli.ts", import.meta.url));

function proteus(
  home: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
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

function proteusJson<T>(home: string, args: string[]): T {
  const r = proteus(home, args);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as T;
}

const homeA = tempInstanceRoot();
const homeB = tempInstanceRoot();

afterAll(() => {
  // 临时实例由系统清理
});

describe("人工安装 seed 快照可重复", () => {
  it("重复 init：同实例幂等复用同一快照", () => {
    const first = proteusJson<{
      snapshotId: string;
      snapshotDigest: string;
      installed: boolean;
      revision: number;
    }>(homeA, ["init", "--json"]);
    expect(first.installed).toBe(true);

    const second = proteusJson<{
      snapshotId: string;
      snapshotDigest: string;
      installed: boolean;
      revision: number;
    }>(homeA, ["init", "--json"]);
    expect(second.installed).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    expect(second.revision).toBe(first.revision); // 未重复晋升
  });

  it("跨实例：同一 seed 内容产生同一快照摘要（纯内容寻址）", () => {
    const a = proteusJson<{ snapshotDigest: string; versions: Array<{ digest: string }> }>(homeA, [
      "init",
      "--json",
    ]);
    const b = proteusJson<{ snapshotDigest: string; versions: Array<{ digest: string }> }>(homeB, [
      "init",
      "--json",
    ]);
    expect(b.snapshotDigest).toBe(a.snapshotDigest);
    expect(b.versions.map((v) => v.digest)).toEqual(a.versions.map((v) => v.digest));
  });

  it("init 后提交的 Run 不因再次 init 改变", () => {
    const summary = proteusJson<{ runId: string; state: string; snapshotId: string }>(homeA, [
      "submit",
      fixturePath("tasks", "stats-a.yaml"),
      "--json",
    ]);
    expect(summary.state).toBe("succeeded");

    proteusJson(homeA, ["init", "--json"]); // 第三次 init

    const detail = proteusJson<{ run: { id: string; state: string; snapshotId: string } }>(homeA, [
      "runs",
      summary.runId,
      "--json",
    ]);
    expect(detail.run.state).toBe("succeeded");
    expect(detail.run.snapshotId).toBe(summary.snapshotId);
  });
});

describe("Snapshot 固定不变量", () => {
  it("默认指针切换后，既有 Run 保持原快照，新 Run 使用新快照", async () => {
    const home = tempInstanceRoot();
    const inst: AppInstance = openInstance(home);
    try {
      proteusJson(home, ["init", "--json"]);
      const first = proteusJson<{ runId: string; state: string; snapshotId: string }>(home, [
        "submit",
        fixturePath("tasks", "stats-a.yaml"),
        "--json",
      ]);
      expect(first.state).toBe("succeeded");
      const g0 = first.snapshotId;

      // 安装自定义图（走 CAS，revision 递增）
      installCustomGenome(inst, {
        graph: {
          schemaVersion: 2,
          kind: "dag-v1",
          nodes: [
            { id: "only", type: "execute", executor: "local-process", dependsOn: [] },
            {
              id: "check",
              type: "verify",
              verifier: "stats-acceptance",
              inputFrom: "only",
              dependsOn: ["only"],
            },
          ],
        },
      });
      const organism = inst.kernel.getOrganism("organism-default")!;
      expect(organism.revision).toBe(2);

      const second = proteusJson<{ runId: string; state: string; snapshotId: string }>(home, [
        "submit",
        fixturePath("tasks", "stats-b.yaml"),
        "--json",
      ]);
      expect(second.state).toBe("succeeded");
      expect(second.snapshotId).not.toBe(g0); // 新 Run 用新快照

      // 既有 Run 仍固定原快照
      const firstDetail = proteusJson<{ run: { snapshotId: string; state: string } }>(home, [
        "runs",
        first.runId,
        "--json",
      ]);
      expect(firstDetail.run.snapshotId).toBe(g0);
      expect(firstDetail.run.state).toBe("succeeded");
    } finally {
      inst.close();
    }
  });
});

describe("不调用模型完成固定任务（事件完整性）", () => {
  it("全过程仅本地进程与规则决策，事件流每流 seq 严格递增", () => {
    const home = tempInstanceRoot();
    proteusJson(home, ["init", "--json"]);
    const summary = proteusJson<{ runId: string; state: string; decisions: unknown[] }>(home, [
      "submit",
      fixturePath("tasks", "stats-a.yaml"),
      "--json",
    ]);
    expect(summary.state).toBe("succeeded");
    expect(summary.decisions).toHaveLength(1); // 规则决策，非模型

    const detail = proteusJson<{
      run: { state: string };
      attempts: Array<{ state: string; exitCode: number | null }>;
      events: Array<{ streamId: string; seq: number; type: string }>;
      experience: { outcome: { result: string; outputDigest: string } } | null;
    }>(home, ["runs", summary.runId, "--json"]);
    expect(detail.run.state).toBe("succeeded");
    expect(detail.attempts[0]!.exitCode).toBe(0); // 本地子进程
    expect(detail.experience!.outcome.outputDigest).toMatch(/^[0-9a-f]{64}$/);

    const byStream = new Map<string, number[]>();
    for (const e of detail.events) {
      byStream.set(e.streamId, [...(byStream.get(e.streamId) ?? []), e.seq]);
    }
    for (const seqs of byStream.values()) {
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });
});
