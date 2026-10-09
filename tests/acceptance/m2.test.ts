import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

/**
 * M2 自举故事全链路（CLI 驱动、fake builder；M3 裁判拆分后为两阶段晋升）。
 * ① init G0；提交 Task T → R1 发现能力缺口，带截止点等待
 * ② 裁判拆分（M3 前置）：judge-upgrade 构造只升裁判的候选 → 等价评估
 *    eligible → operator promote → active=G_eval（裁判与能力变化不同快照）
 * ③④ 委托构建 → 独立测试验收 → 采集构造候选 G_cap → 独立评估 eligible
 * ⑤ operator 批准 → CAS Promotion → active=G_cap
 * ⑥ R1 failed/superseded 结案，R2 接替并以新能力完成摘要（独立比对 fixture）
 * ⑦ 回滚（revision 只增不减），R3 再次缺口等待 → 到期 failed/missing_capability；
 *    R2 与候选记录不被回滚抹去
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
  expect({ status: r.status, stderr: r.stderr.slice(0, 200) }).toEqual({ status: 0, stderr: "" });
  return JSON.parse(r.stdout) as T;
}

afterAll(() => {
  // 临时实例由系统清理
});

describe("M2：第一个自举故事（两阶段晋升，端到端）", () => {
  let g0 = "";
  let gEval = "";
  let r1 = "";
  let judgeCandidateId = "";
  let candidateId = "";

  it("① init G0；提交 Task T → R1 发现能力缺口，带截止点等待", () => {
    const init = proteusJson<{ snapshotId: string; revision: number }>(["init", "--json"]);
    expect(init.revision).toBe(1);
    g0 = init.snapshotId;

    const summary = proteusJson<{ runId: string; state: string; snapshotId: string }>([
      "submit",
      join(M2, "tasks", "summary-task.yaml"),
      "--json",
    ]);
    expect(summary.state).toBe("waiting");
    expect(summary.snapshotId).toBe(g0);
    r1 = summary.runId;
  });

  it("② 裁判拆分：judge-upgrade 等价评估 eligible → operator promote → active=G_eval", () => {
    const upgrade = proteusJson<{
      candidate: { id: string; baseSnapshotId: string; proposedSnapshotId: string };
      evaluation: { verdict: string; runs: Array<{ role: string; state: string }> };
      status: string;
    }>([
      "judge-upgrade",
      "--regression-task",
      join(M2, "tasks", "stats-regression.yaml"),
      "--json",
    ]);
    expect(upgrade.evaluation.verdict).toBe("eligible");
    // 候选臂（新裁判）与基线臂（基准裁判）在既有任务上判定一致
    expect(upgrade.evaluation.runs.every((r) => r.state === "succeeded")).toBe(true);
    expect(upgrade.status).toBe("eligible");
    judgeCandidateId = upgrade.candidate.id;

    const outcome = proteusJson<{
      result: string;
      promotion: { resultRevision: number; kind: string; toSnapshotId: string };
    }>(["promote", judgeCandidateId, "--as", "principal-local", "--json"]);
    expect(outcome.result).toBe("promoted");
    expect(outcome.promotion.resultRevision).toBe(2);
    gEval = outcome.promotion.toSnapshotId;

    // 裁判候选未动能力与图：G_eval 与 G0 仅 acceptance-evaluator 版本不同
    const g0Snap = proteusJson<{ value: { bindings: Record<string, string> } }>([
      "inspect",
      g0,
      "--json",
    ]);
    const gEvalSnap = proteusJson<{ value: { bindings: Record<string, string> } }>([
      "inspect",
      gEval,
      "--json",
    ]);
    expect(Object.keys(g0Snap.value.bindings)).toEqual(Object.keys(gEvalSnap.value.bindings));
    expect(gEvalSnap.value.bindings["acceptance-evaluator"]).not.toBe(
      g0Snap.value.bindings["acceptance-evaluator"],
    );
  });

  it("③④ 委托构建 → 独立测试验收 → 候选 G_cap（继承升级后裁判）→ 独立评估 eligible", () => {
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
    expect(build.created).toBe(true);
    expect(build.status.status).toBe("proposed");
    expect(build.candidate.baseSnapshotId).toBe(gEval); // 基于 G_eval（裁判拆分）
    candidateId = build.candidate.id;

    const evaluation = proteusJson<{
      evaluation: { verdict: string; runs: Array<{ role: string; state: string }> };
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
    expect(evaluation.evaluation.runs.map((r) => `${r.role}:${r.state}`)).toEqual([
      "new-capability:succeeded",
      "regression:succeeded",
      "baseline:succeeded",
    ]);
  });

  it("⑤ operator 批准 → CAS Promotion：active → G_cap，revision 前进", () => {
    const outcome = proteusJson<{
      result: string;
      promotion: { resultRevision: number; kind: string };
    }>(["promote", candidateId, "--as", "principal-local", "--json"]);
    expect(outcome.result).toBe("promoted");
    expect(outcome.promotion.resultRevision).toBe(3);
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
        failureReason: string | null;
        snapshotId: string;
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
    expect(r1After.run.snapshotId).toBe(g0); // R1 固定提交时的快照

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

  it("⑦ 回滚（revision 只增不减）；R3 再次缺口等待 → 到期 failed/missing_capability；记录不抹去", async () => {
    // 回滚到 G_eval（历史采用快照；无能力槽位 → R3 缺口场景同样成立）
    const rollback = proteusJson<{
      result: string;
      promotion: { resultRevision: number; kind: string };
    }>(["rollback", "--to", gEval, "--as", "principal-local", "--json"]);
    expect(rollback.result).toBe("promoted");
    expect(rollback.promotion.kind).toBe("rollback");
    expect(rollback.promotion.resultRevision).toBe(4); // 只增不减

    const r3 = proteusJson<{ runId: string; state: string; snapshotId: string }>([
      "submit",
      join(M2, "tasks", "summary-task.yaml"),
      "--json",
    ]);
    expect(r3.state).toBe("waiting");
    expect(r3.snapshotId).toBe(gEval);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const advanced = proteusJson<{ state: string; note: string }>(["advance", r3.runId, "--json"]);
    expect(advanced.state).toBe("failed");
    expect(advanced.note).toContain("missing_capability");

    // 候选与晋升记录仍可查看，不被回滚抹去
    const candidates = proteusJson<Array<{ id: string; status: string }>>(["candidates", "--json"]);
    expect(candidates.find((c) => c.id === candidateId)!.status).toBe("adopted");
    expect(candidates.find((c) => c.id === judgeCandidateId)!.status).toBe("adopted");
  });
});
