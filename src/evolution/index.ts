import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock, IdGen } from "../kernel/index.ts";
import type { Kernel } from "../kernel/index.ts";
import type { RunSummary, TaskBudget } from "../runtime/types.ts";
import type { Runtime } from "../runtime/index.ts";
import type { BlobStore } from "../storage/blobs.ts";
import { digestOf } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import { ensureBuilderGenome, ensureCapabilityGenome } from "./assets.ts";
import type { CandidateRecord, CandidateStatus } from "./types.ts";

/**
 * Evolution（M2 最小自举）：委托构建 → 采集构造候选 → （切片④）评估与晋升编排。
 * 它只产出候选与证据，不改写 active 指针——晋升必须跨过 Kernel 的 CAS 与一致性检查
 * （docs/architecture.md Evolution 职责边界）。M3 前允许人工提出候选，流程仍记录来源。
 */
export class Evolution {
  readonly deps: EvolutionRuntimeDeps;

  constructor(deps: EvolutionRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * 委托构建（自举故事步骤 2）：固定 builder 图 + 编码 worker，在独立工作区
   * 将实现规范交给执行器；产出由 test-runner 裁判独立验收（测试失败不能构造候选）。
   */
  async build(input: BuildInput): Promise<RunSummary> {
    const { snapshot } = ensureBuilderGenome(
      {
        kernel: this.deps.kernel,
        storage: this.deps.storage,
        blobs: this.deps.blobs,
        clock: this.deps.clock,
      },
      {
        executorName: input.executorName,
        testCommand: input.testCommand,
        createdBy: input.requestedBy,
      },
    );
    return this.deps.runtime.submitTask(
      {
        requestedBy: input.requestedBy,
        goal: input.goal,
        inputs: input.inputs,
        budget: input.budget,
        acceptance: { outputSchema: input.outputSchema, verifier: "builder-acceptance" },
      },
      { purpose: "evaluation", snapshotId: snapshot.id },
    );
  }

  /**
   * 采集产出并构造候选（自举故事步骤 3）：从 builder 工作区按产出路径约定
   * （src/<capability>.mjs）读取实现 → capability-module → 基于当前 active 组合
   * 候选快照（digest 幂等，同产出同快照）→ Candidate 记录 + proposed 事件。
   * 按 proposedSnapshot 去重：重复 collect 返回既有候选。
   */
  collectCandidate(
    builderRunId: string,
    opts: {
      capability: string;
      hypothesis: string;
      proposedBy: string;
      datasetRef?: string | null;
    },
  ): { candidate: CandidateRecord; created: boolean } {
    const run = this.deps.storage.getRun(builderRunId);
    if (!run) throw new EvolutionError("unknown_run", `builder run ${builderRunId} 不存在`);
    if (run.state !== "succeeded") {
      throw new EvolutionError(
        "builder_not_succeeded",
        `builder run ${builderRunId} 状态为 ${run.state}（${run.failureReason ?? "无原因"}）：测试未通过的产出不能构造候选`,
      );
    }
    const implPath = join(
      this.deps.instanceRoot,
      "workspaces",
      builderRunId,
      "dev",
      "src",
      `${opts.capability}.mjs`,
    );
    if (!existsSync(implPath)) {
      throw new EvolutionError(
        "implementation_missing",
        `builder 工作区缺少约定产出路径 src/${opts.capability}.mjs，无法采集`,
      );
    }
    const module = {
      kind: "capability-module-v1" as const,
      name: opts.capability,
      entry: "index.mjs",
      files: [{ path: "index.mjs", content: readFileSync(implPath, "utf8") }],
    };

    const organism = this.deps.kernel.getOrganism(this.deps.organismId);
    const baseSnapshotId = organism?.activeGenomeId ?? null;
    if (!organism || !baseSnapshotId) {
      throw new EvolutionError("no_active_genome", "默认快照未安装，无基准可组合候选");
    }
    const baseRevision = organism.revision;
    const genome = ensureCapabilityGenome(
      {
        kernel: this.deps.kernel,
        storage: this.deps.storage,
        blobs: this.deps.blobs,
        clock: this.deps.clock,
      },
      {
        baseSnapshotId,
        capabilities: [{ name: opts.capability, module }],
        createdBy: opts.proposedBy,
      },
    );

    return this.deps.storage.tx(() => {
      const existing = this.deps.storage.findCandidateByProposedSnapshot(
        this.deps.organismId,
        genome.snapshot.id,
      );
      if (existing) return { candidate: existing, created: false };
      const now = this.deps.clock.now();
      const candidate: CandidateRecord = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        baseSnapshotId,
        baseRevision,
        proposedSnapshotId: genome.snapshot.id,
        hypothesis: opts.hypothesis,
        proposedBy: opts.proposedBy,
        sourceRefs: {
          builderRunId,
          capability: opts.capability,
          builderGoalDigest: digestOf(runGoal(this.deps.storage, builderRunId)),
        },
        datasetRef: opts.datasetRef ?? null,
        createdAt: now,
      };
      this.deps.storage.insertCandidate(candidate);
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidate.id}`,
        type: "candidate.proposed",
        payload: {
          candidateId: candidate.id,
          capability: opts.capability,
          proposedSnapshotId: candidate.proposedSnapshotId,
          proposedSnapshotDigest: genome.snapshot.digest,
          baseSnapshotId: candidate.baseSnapshotId,
          baseRevision: candidate.baseRevision,
          hypothesis: opts.hypothesis,
        },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return { candidate, created: true };
    });
  }

  /** Candidate 流程状态：由 candidate-<id> 事件流投影（不物化 status 列） */
  candidateStatus(candidateId: string): { status: CandidateStatus; detail: string } {
    const events = this.deps.storage.listEvents({ streamId: `candidate-${candidateId}` }, 100);
    if (events.length === 0)
      throw new EvolutionError("unknown_candidate", `候选 ${candidateId} 不存在`);
    let status: CandidateStatus = "proposed";
    let detail = "已提议，待评估";
    for (const e of events) {
      if (e.type === "candidate.proposed") {
        status = "proposed";
        detail = "已提议，待评估";
      } else if (e.type === "candidate.evaluating") {
        status = "evaluating";
        detail = "评估进行中";
      } else if (e.type === "candidate.evaluated") {
        const verdict = String(e.payload["verdict"]);
        status = verdict === "eligible" ? "eligible" : "rejected";
        detail = String(
          e.payload["note"] ?? (verdict === "eligible" ? "证据满足条件" : "证据不满足"),
        );
      } else if (e.type === "candidate.stale") {
        status = "stale";
        detail = `基准已过期（当前 revision ${String(e.payload["currentRevision"])}），须基于新基准重构重评`;
      } else if (e.type === "candidate.adopted") {
        status = "adopted";
        detail = `已晋升（promotion ${String(e.payload["promotionId"])}，revision ${String(e.payload["revision"])}）`;
      }
    }
    return { status, detail };
  }
}

export interface EvolutionRuntimeDeps {
  kernel: Kernel;
  storage: Storage;
  blobs: BlobStore;
  runtime: Runtime;
  organismId: string;
  instanceRoot: string;
  clock: Clock;
  ids: IdGen;
}

export interface BuildInput {
  capability: string;
  /** 实现规范文本（作为 builder Run 的 goal；明示产出路径与合同） */
  goal: string;
  inputs: string[];
  executorName: string;
  testCommand: string[];
  budget: TaskBudget;
  /** verifier binding 需要一个 schema 文件路径（test-runner 裁判不消费它） */
  outputSchema: string;
  requestedBy: string;
}

export class EvolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function runGoal(storage: Storage, runId: string): string {
  const run = storage.getRun(runId);
  const task = run ? storage.getTask(run.taskId) : undefined;
  return task?.goal ?? "";
}
