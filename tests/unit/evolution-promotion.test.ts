import { describe, expect, it, vi } from "vitest";
import { Evolution, type EvolutionRuntimeDeps } from "../../src/evolution/index.ts";
import type { CandidateRecord, EvaluationRecord } from "../../src/evolution/types.ts";

const candidate: CandidateRecord = {
  id: "candidate-1",
  organismId: "organism-default",
  baseSnapshotId: "snapshot-base",
  baseRevision: 1,
  proposedSnapshotId: "snapshot-proposed",
  hypothesis: "事务评估门测试",
  proposedBy: "principal-local",
  sourceRefs: {},
  datasetRef: null,
  createdAt: 1,
};

function evaluation(verdict: EvaluationRecord["verdict"], createdAt: number): EvaluationRecord {
  return {
    id: `evaluation-${verdict}`,
    candidateId: candidate.id,
    protocolDigest: "protocol",
    baselineSnapshotId: candidate.baseSnapshotId,
    runs: [],
    verdict,
    metrics: {
      newCapability: { passed: verdict === "eligible", durationMs: 0 },
      regression: { passed: verdict === "eligible", durationMs: 0 },
      baseline: { passed: true, durationMs: 0 },
      cost: null,
    },
    createdAt,
  };
}

describe("Evolution 晋升事务边界", () => {
  it("事务开始时出现更新的非 eligible 评估，禁止使用事务外旧结论晋升", () => {
    let latest = evaluation("eligible", 1);
    const promote = vi.fn();
    const storage = {
      getCandidate: () => candidate,
      listEvaluationsByCandidate: () => [latest],
      tx: <T>(fn: () => T): T => {
        latest = evaluation("rejected", 2);
        return fn();
      },
    };
    const evolution = new Evolution({
      storage,
      kernel: { promote },
      ids: { next: () => "operation-1" },
      clock: { now: () => 3 },
      organismId: candidate.organismId,
    } as unknown as EvolutionRuntimeDeps);

    expect(() => evolution.promote(candidate.id, { authorizedBy: "principal-local" })).toThrowError(
      /最新：rejected/,
    );
    expect(promote).not.toHaveBeenCalled();
  });
});
