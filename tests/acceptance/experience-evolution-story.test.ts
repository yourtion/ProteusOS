import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

/**
 * 验收固化：经验驱动演化全链路（roadmap M3 完成判据：
 * 从历史失败提出改进，在独立任务上比较基线，保留可复验结果，
 * 证据不足可以不晋升）。
 * ①② 两阶段装配（judge-upgrade → promote；build → promote）——G_cap 就绪
 * ③ 历史失败：语义需要能力但未声明 requires 的任务被兜底路由到 local-process 失败
 * ④ 冻结经验集（显式成员 + 内容摘要）
 * ⑤ Consolidation：gold join 归纳特征路由 → 只改 routing-policy 的候选
 * ⑥ 独立验证集（新 family 措辞）双臂评估：候选臂修复历史失败、基线臂保留，
 *    指标分列达门槛 → eligible；评估记录含 datasetRef/方差
 * ⑦ operator promote → 同类新表述任务被特征路由修复
 * ⑧ 反向故事：无 gold 的零提议是正常结果（不晋升，旧默认继续有效）
 */

const cliPath = fileURLToPath(new URL("../../src/app/cli.ts", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));
const CFS = fileURLToPath(new URL("../fixtures/changed-file-summary", import.meta.url));
const STATS = fileURLToPath(new URL("../fixtures/stats", import.meta.url));
const PE = fileURLToPath(new URL("../fixtures/policy-evolution", import.meta.url));

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
  if (r.status !== 0) throw new Error(`CLI 失败(${r.status}): ${r.stderr}`);
  expect(r.stderr).toBe("");
  return JSON.parse(r.stdout) as T;
}

afterAll(() => {
  // 临时实例由系统清理
});

const FAILING_TASK = join(PE, "tasks", "unlabeled-summary.yaml");

describe("经验驱动演化（端到端）", () => {
  let policyCandidateId = "";

  it("①② 两阶段装配：judge-upgrade → promote；build → promote", () => {
    proteusJson(["init", "--json"]);

    const judge = proteusJson<{ candidate: { id: string } }>([
      "judge-upgrade",
      "--regression-task",
      join(STATS, "tasks", "regression.yaml"),
      "--json",
    ]);
    const judgePromo = proteusJson<{ result: string }>([
      "promote",
      judge.candidate.id,
      "--as",
      "principal-local",
      "--json",
    ]);
    expect(judgePromo.result).toBe("promoted");

    const build = proteusJson<{ candidate: { id: string } }>([
      "build",
      "--capability",
      "changed-file-summary",
      "--spec",
      join(CFS, "spec", "changed-file-summary-spec.md"),
      "--tests",
      join(CFS, "tests"),
      "--executor",
      "fake-acp",
      "--new-capability-task",
      join(CFS, "tasks", "summary-task.yaml"),
      "--regression-task",
      join(STATS, "tasks", "regression.yaml"),
      "--json",
    ]);
    // 能力候选同样须独立评估（新能力验收 + 回归 + 基线对照）后晋升
    const capEval = proteusJson<{ evaluation: { verdict: string } }>([
      "evaluate",
      build.candidate.id,
      "--new-capability-task",
      join(CFS, "tasks", "summary-task.yaml"),
      "--regression-task",
      join(STATS, "tasks", "regression.yaml"),
      "--json",
    ]);
    expect(capEval.evaluation.verdict).toBe("eligible");

    const capPromo = proteusJson<{ result: string }>([
      "promote",
      build.candidate.id,
      "--as",
      "principal-local",
      "--json",
    ]);
    expect(capPromo.result).toBe("promoted");
  });

  it("③ 历史失败：未声明能力的语义任务被兜底路由而失败 ×2；stats 任务成功", () => {
    const first = proteusJson<{ state: string; failureReason: string }>([
      "submit",
      FAILING_TASK,
      "--json",
    ]);
    expect(first.state).toBe("failed");

    // 第二次失败：goal 追加后缀（与 gold.json 第二项一致，供归纳 join）；
    // 写入 home 的临时 task 一律改绝对路径（home 的相对基准不指向仓库 fixture）
    const secondTask = join(home, "second-failing.yaml");
    writeFileSync(
      secondTask,
      readFileSync(FAILING_TASK, "utf8")
        .replace(/^goal: .+$/m, "goal: 请把这次改动的文件按类别整理成清单（第二次）")
        .replaceAll("../../changed-file-summary/", `${CFS}/`)
        .replaceAll("../../stats/", `${STATS}/`),
      "utf8",
    );
    const second = proteusJson<{ state: string }>(["submit", secondTask, "--json"]);
    expect(second.state).toBe("failed");

    // 对照成功经验：stats 任务正常
    const ok = proteusJson<{ state: string }>([
      "submit",
      join(STATS, "tasks", "regression.yaml"),
      "--json",
    ]);
    expect(ok.state).toBe("succeeded");
  });

  it("④⑤ 冻结经验 → gold join 归纳 → 只改 routing-policy 的候选", () => {
    const frozen = proteusJson<{ dataset: { id: string }; memberCount: number }>([
      "dataset-freeze",
      "--json",
    ]);
    expect(frozen.memberCount).toBeGreaterThanOrEqual(3);

    // 注意：窗口含 ①② 的评估 Run（成功路由能力的正例），无 gold 也可能
    // 归纳出经验性规则——零提议的反向场景由 integration 测试单独覆盖
    const proposed = proteusJson<{
      candidate: { id: string; proposedSnapshotId: string; hypothesis: string };
      consolidation: {
        proposals: Array<{ feature: string; choose: string; byOrigin: { gold: number } }>;
      };
    }>(["consolidate", frozen.dataset.id, "--gold", join(PE, "gold.json"), "--json"]);
    expect(proposed.candidate).not.toBeNull();
    policyCandidateId = proposed.candidate!.id;
    // gold join 后必含目标规则（未声明能力的失败 → 特征路由修复）
    expect(
      proposed.consolidation.proposals.find(
        (r) => r.feature === "hasChangeIntent" && r.choose === "capability/changed-file-summary",
      ),
    ).toMatchObject({ byOrigin: { gold: 2 } });
  });

  it("⑥ 独立验证集双臂评估：候选臂修复历史失败，指标分列达门槛 → eligible", () => {
    const result = proteusJson<{
      evaluation: {
        verdict: string;
        runs: Array<{ role: string; state: string }>;
        policy: {
          base: { successRate: number; runs: number };
          candidate: { successRate: number; runs: number; successRateVariance: number };
        };
      };
      status: string;
    }>([
      "evaluate-policy",
      policyCandidateId,
      "--cases",
      join(PE, "validation-cases.json"),
      "--repeats",
      "1",
      "--json",
    ]);
    expect(result.evaluation.verdict).toBe("eligible");
    expect(result.status).toBe("eligible");
    // 双臂各 4 Run（4 case × 1 repeat）；分列指标记录方差
    expect(result.evaluation.policy.candidate.runs).toBe(4);
    expect(result.evaluation.policy.base.runs).toBe(4);
    expect(result.evaluation.policy.candidate.successRate).toBe(1);
    expect(result.evaluation.policy.base.successRate).toBeLessThan(1);
    // 逐 Run 留痕（可复验）
    expect(result.evaluation.runs.filter((r) => r.role === "policy-candidate")).toHaveLength(4);
  });

  it("⑦ operator promote → 同类新表述任务被特征路由修复（历史失败不再复现）", () => {
    const promo = proteusJson<{ result: string }>([
      "promote",
      policyCandidateId,
      "--as",
      "principal-local",
      "--json",
    ]);
    expect(promo.result).toBe("promoted");

    const fixed = proteusJson<{ state: string; decisions: Array<{ value: string }> }>([
      "submit",
      FAILING_TASK,
      "--json",
    ]);
    expect(fixed.state).toBe("succeeded");
    expect(fixed.decisions.some((d) => d.value === "capability/changed-file-summary")).toBe(true);
  });
});
