import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

/**
 * M2 验收固化：第一个自举故事全链路（roadmap §3，CLI 驱动、fake builder）。
 * ① R1 能力检查发现缺口 → 带截止点等待
 * ②③ 委托构建 → 独立测试验收 → 产出注册为不可变版本 → 候选 G1
 * ④ 独立评估：新能力验收 + 既有能力回归 + 基线对照（裁判由评估计划钉住）
 * ⑤ operator 批准 CAS Promotion（失败保持 G0）
 * ⑥ R1 failed/superseded 结案，R2 接替并以新能力完成摘要（独立比对 fixture）
 * ⑦ 回滚到 G0（revision 继续增长），R3 再次缺口等待 → 到期 failed/missing_capability；
 *    R2 与 G1 记录不被回滚抹去
 * 真实凭据版（Claude Code 作为 builder）见 tests/e2e/，PROTEUS_E2E 门控。
 */

const cliPath = fileURLToPath(new URL("../../src/app/cli.ts", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));
const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));

const home = tempInstanceRoot();

function proteus(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", cliPath, ...args, "--home", home],
    {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, PROTEUS_FAKE_ACP_AGENT: FAKE_AGENT },
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function proteusJson<T>(args: string[]): T {
  const r = proteus(args);
  expect({ status: r.status, stderr: r.stderr.slice(0, 200) }).toEqual({
    status: 0,
    stderr: "",
  });
  return JSON.parse(r.stdout) as T;
}

afterAll(() => {
  // 临时实例由系统清理
});

describe("M2：第一个自举故事（端到端）", () => {
  let g0 = "";
  let r1 = "";
  let candidateId = "";

  it("① init G0；提交 Task T → R1 发现能力缺口，带截止点等待", () => {
    const init = proteusJson<{ snapshotId: string; revision: number }>(["init", "--json"]);
    expect(init.revision).toBe(1);
    g0 = init.snapshotId;

    const summary = proteusJson<{
      runId: string;
      state: string;
      snapshotId: string;
    }>(["submit", join(M2, "tasks", "summary-task.yaml"), "--json"]);
    expect(summary.state).toBe("waiting");
    expect(summary.snapshotId).toBe(g0);
    r1 = summary.runId;

    const detail = proteusJson<{ run: { missingCapabilities: string[]; waitingUntil: number } }>([
      "runs",
      r1,
      "--json",
    ]);
    expect(detail.run.missingCapabilities).toEqual(["changed-file-summary"]);
    expect(detail.run.waitingUntil).toBeGreaterThan(0);
  });

  it("②③ 委托构建 → 独立测试验收 → 采集构造候选 G1（digest 幂等）", () => {
    const build = proteusJson<{
      builderRun: string;
      candidate: { id: string; baseSnapshotId: string; proposedSnapshotId: string };
      status: { status: string };
      created: boolean;
    }>([
      "build",
      "--capability",
      "changed-file-summary",
      "--spec",
      join(M2, "specs", "changed-file-summary-spec.md"),
      "--tests",
      join(M2, "capability-tests"),
      "--executor",
      "fake-acp",
      "--new-capability-task",
      join(M2, "tasks", "summary-task.yaml"),
      "--regression-task",
      join(M2, "tasks", "stats-regression.yaml"),
      "--json",
    ]);
    expect(build.builderRun).toBeTruthy();
    expect(build.created).toBe(true);
    expect(build.status.status).toBe("proposed");
    expect(build.candidate.baseSnapshotId).toBe(g0);
    candidateId = build.candidate.id;

    // 候选快照含能力槽位，G0 未被触碰
    const snapshot = proteusJson<{ value: { bindings: Record<string, string> } }>([
      "inspect",
      build.candidate.proposedSnapshotId,
      "--json",
    ]);
    expect(Object.keys(snapshot.value.bindings)).toEqual(
      expect.arrayContaining([
        "capability/changed-file-summary",
        "task-graph",
        "routing-policy",
        "acceptance-evaluator",
      ]),
    );
  });

  it("④ 独立评估：新能力验收 + 既有能力回归 + 基线对照 → eligible", () => {
    const evaluation = proteusJson<{
      evaluation: {
        id: string;
        verdict: string;
        runs: Array<{ role: string; state: string }>;
      };
      status: string;
    }>([
      "evaluate",
      candidateId,
      "--new-capability-task",
      join(M2, "tasks", "summary-task.yaml"),
      "--regression-task",
      join(M2, "tasks", "stats-regression.yaml"),
      "--json",
    ]);
    expect(evaluation.evaluation.verdict).toBe("eligible");
    expect(evaluation.status).toBe("eligible");
    expect(evaluation.evaluation.runs.map((r) => `${r.role}:${r.state}`)).toEqual([
      "new-capability:succeeded",
      "regression:succeeded",
      "baseline:succeeded",
    ]);
  });

  it("⑤ operator 批准 → CAS Promotion：active → G1，revision 前进", () => {
    const outcome = proteusJson<{
      result: string;
      promotion: { resultRevision: number; kind: string; toSnapshotId: string };
    }>(["promote", candidateId, "--as", "principal-local", "--json"]);
    expect(outcome.result).toBe("promoted");
    expect(outcome.promotion.kind).toBe("adopt");
    expect(outcome.promotion.resultRevision).toBe(2);
  });

  it("⑥ R1 failed/superseded 结案；R2 接替并以新能力完成摘要（输出与 fixture 一致）", () => {
    const result = proteusJson<{
      superseded: { state: string };
      successor: { runId: string; state: string; snapshotId: string };
    }>(["supersede", r1, "--json"]);
    expect(result.superseded.state).toBe("failed");
    expect(result.successor.state).toBe("succeeded");

    const r2 = proteusJson<{
      run: {
        supersedesRunId: string;
        failureReason: string;
        snapshotId: string;
        taskRevision: number;
        purpose: string;
      };
    }>(["runs", result.successor.runId, "--json"]);
    expect(r2.run.supersedesRunId).toBe(r1);
    expect(r2.run.failureReason).toBeNull();
    expect(r2.run.snapshotId).not.toBe(g0);
    expect(r2.run.purpose).toBe("normal");

    const r1After = proteusJson<{
      run: { state: string; failureReason: string; snapshotId: string };
    }>(["runs", r1, "--json"]);
    expect(r1After.run.state).toBe("failed");
    expect(r1After.run.failureReason).toBe("superseded");
    expect(r1After.run.snapshotId).toBe(g0); // R1 固定 G0

    // 独立验收器：R2 输出与 fixture 期望逐项一致（不经候选裁判）
    const output = JSON.parse(
      readFileSync(join(home, "workspaces", result.successor.runId, "work", "output.json"), "utf8"),
    ) as { summary: { files: Array<{ path: string; category: string }> } };
    const expected = JSON.parse(
      readFileSync(join(M2, "evals", "summary-expected.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.fromEntries(output.summary.files.map((f) => [f.path, f.category]))).toEqual(
      expected,
    );
  });

  it("⑦ 回滚到 G0（revision 继续增长）；R3 再次缺口等待 → 到期 failed/missing_capability；记录不抹去", async () => {
    const rollback = proteusJson<{
      result: string;
      promotion: { resultRevision: number; kind: string };
    }>(["rollback", "--to", g0, "--as", "principal-local", "--json"]);
    expect(rollback.result).toBe("promoted");
    expect(rollback.promotion.kind).toBe("rollback");
    expect(rollback.promotion.resultRevision).toBe(3); // 只增不减

    // R3：同一 Task 在 G0 下再次缺口等待
    const r3 = proteusJson<{ runId: string; state: string; snapshotId: string }>([
      "submit",
      join(M2, "tasks", "summary-task.yaml"),
      "--json",
    ]);
    expect(r3.state).toBe("waiting");
    expect(r3.snapshotId).toBe(g0);

    // 等待截止（fixture 配置 1 秒）后 advance 结案
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const advanced = proteusJson<{ state: string; note: string }>(["advance", r3.runId, "--json"]);
    expect(advanced.state).toBe("failed");
    expect(advanced.note).toContain("missing_capability");

    const r3After = proteusJson<{ run: { state: string; failureReason: string } }>([
      "runs",
      r3.runId,
      "--json",
    ]);
    expect(r3After.run.failureReason).toBe("missing_capability");

    // G1 与 R2 记录仍可查看，不被回滚抹去
    const snapshot = proteus(["inspect", candidateId, "--json"]);
    expect(snapshot.status).toBe(0);
    const candidates = proteusJson<Array<{ id: string; status: string }>>(["candidates", "--json"]);
    expect(candidates.find((c) => c.id === candidateId)!.status).toBe("adopted");
  });
});
