import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import {
  ensureCapabilityGenome,
  ensureJudgeGenome,
  HYBRID_EVALUATOR_CONTENT,
} from "../../src/evolution/assets.ts";
import type { CapabilityModule } from "../../src/runtime/capability.ts";
import { bootSeededInstance, fixturePath } from "../helpers.ts";

/**
 * M3 切片②：裁判拆分独立晋升（evolution.md §6 的正式兑现）。
 * - 组合能力候选不再升级裁判：基准裁判非 hybrid 时明确拒绝（先走裁判候选）
 * - 裁判候选：构造 → 判定等价评估（候选臂钉新裁判 + 基线臂基准裁判）→
 *   eligible → operator promote；晋升后能力候选基于它组合
 * - 裁判候选被基准变更顶掉 → promote stale（CAS 语义通用）
 */

const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const REGRESSION_TASK = {
  goal: "统计摘要（裁判等价回归）",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};

describe("M3：裁判拆分", () => {
  it("基准裁判非 hybrid 时组合能力候选被明确拒绝（不得同处一个候选）", () => {
    const app = instance();
    const base = app.kernel.getOrganism("organism-default")!.activeGenomeId!; // G0（stats v1）
    const module: CapabilityModule = {
      kind: "capability-module-v1",
      name: "changed-file-summary",
      entry: "index.mjs",
      files: [
        {
          path: "index.mjs",
          content: readFileSync(join(M2, "capability", "changed-file-summary.mjs"), "utf8"),
        },
      ],
    };
    expect(() =>
      ensureCapabilityGenome(
        { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
        {
          baseSnapshotId: base,
          capabilities: [{ name: "changed-file-summary", module }],
          createdBy: "principal-local",
        },
      ),
    ).toThrowError(/裁判与能力变化不得同处一个候选/);
  });

  it("ensureJudgeGenome：只升裁判槽位，其余继承；digest 幂等", () => {
    const app = instance();
    const base = app.kernel.getOrganism("organism-default")!.activeGenomeId!;
    const deps = {
      kernel: app.kernel,
      storage: app.storage,
      blobs: app.blobs,
      clock: { now: Date.now },
    };
    const first = ensureJudgeGenome(deps, {
      baseSnapshotId: base,
      evaluatorContent: HYBRID_EVALUATOR_CONTENT,
      createdBy: "principal-local",
    });
    const second = ensureJudgeGenome(deps, {
      baseSnapshotId: base,
      evaluatorContent: HYBRID_EVALUATOR_CONTENT,
      createdBy: "principal-local",
    });
    expect(second.snapshot.id).toBe(first.snapshot.id); // 幂等
    const { snapshot: baseSnap } = app.kernel.resolveSnapshot(base);
    expect(Object.keys(first.snapshot.bindings)).toEqual(Object.keys(baseSnap.bindings));
    expect(first.snapshot.bindings["acceptance-evaluator"]).not.toBe(
      baseSnap.bindings["acceptance-evaluator"],
    );
  });

  it("裁判候选全流程：等价评估 eligible → promote → 能力候选可基于新基准组合", async () => {
    const app = instance();
    const { candidate, created } = app.evolution.proposeJudgeCandidate({
      evaluatorContent: HYBRID_EVALUATOR_CONTENT,
      hypothesis: "裁判升级（judge-split 测试）",
      proposedBy: "principal-local",
    });
    expect(created).toBe(true);
    expect(app.evolution.candidateStatus(candidate.id).status).toBe("proposed");

    // 非裁判候选不能走 judge 评估通道
    await expect(
      app.evolution.evaluateJudgeCandidate("not-exists", {
        regression: REGRESSION_TASK,
        requestedBy: "principal-local",
      }),
    ).rejects.toThrowError(/不存在/);

    const { evaluation, status } = await app.evolution.evaluateJudgeCandidate(candidate.id, {
      regression: REGRESSION_TASK,
      requestedBy: "principal-local",
    });
    expect(evaluation.verdict).toBe("eligible");
    expect(status).toBe("eligible");
    expect(evaluation.runs.map((r) => `${r.role}:${r.state}`)).toEqual([
      "regression:succeeded",
      "baseline:succeeded",
    ]);

    const outcome = app.evolution.promote(candidate.id, { authorizedBy: "principal-local" });
    expect(outcome.result).toBe("promoted");
    if (outcome.result !== "promoted") return;
    expect(app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(
      candidate.proposedSnapshotId,
    );
    expect(app.evolution.candidateStatus(candidate.id).status).toBe("adopted");

    // 晋升后：能力候选可基于新基准组合（裁判继承，不再被拒）
    const module: CapabilityModule = {
      kind: "capability-module-v1",
      name: "changed-file-summary",
      entry: "index.mjs",
      files: [
        {
          path: "index.mjs",
          content: readFileSync(join(M2, "capability", "changed-file-summary.mjs"), "utf8"),
        },
      ],
    };
    const genome = ensureCapabilityGenome(
      { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
      {
        baseSnapshotId: candidate.proposedSnapshotId,
        capabilities: [{ name: "changed-file-summary", module }],
        createdBy: "principal-local",
      },
    );
    // 能力候选的裁判 = 基准（升级后）裁判，未被再次替换
    expect(genome.evaluatorVersion.id).toBe(
      app.kernel.resolveSnapshot(candidate.proposedSnapshotId).versions.get("acceptance-evaluator")!
        .id,
    );
  });
});
