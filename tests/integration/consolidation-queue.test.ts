import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { openInstance } from "../../src/app/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
import type { RouteProposer } from "../../src/evolution/consolidation.ts";
import {
  bootSeededInstance,
  policyValidationPlan,
  registerPolicyValidationSet,
  tempInstanceRoot,
  upgradeJudgeToActive,
} from "../helpers.ts";

/**
 * Consolidation 异步队列 + LLM 归纳模式（fake proposer）。
 * - 队列状态机：submit → queued → run → completed（含零提议）；
 *   cancel 仅作用 queued；同参数幂等；失败保留证据
 * - LLM 模式：提议只看缺口样本（不含 gold）；必须过统计门槛重算，
 *   不达标丢弃；provenance 记入候选 sourceRefs；未装配明确报错
 * 真实 LLM 调用见 tests/e2e（PROTEUS_LLM_API_KEY + PROTEUS_E2E 门控）。
 */

const CFS = fileURLToPath(new URL("../fixtures/changed-file-summary", import.meta.url));
const PE = fileURLToPath(new URL("../fixtures/policy-evolution", import.meta.url));

let inst: AppInstance | undefined;

afterAll(() => {
  inst?.close();
});

/** 可控提议者：记录调用输入、返回脚本化提议 */
class FakeRouteProposer implements RouteProposer {
  readonly name = "fake-proposer";
  lastInput: Parameters<RouteProposer["propose"]>[0] | null = null;
  proposals: Array<{ feature: string; choose: string; rationale: string }> = [];
  lastProvenance = { promptDigest: "p-digest", responseDigest: "r-digest" };

  async propose(input: Parameters<RouteProposer["propose"]>[0]) {
    this.lastInput = input;
    return [...this.proposals];
  }
}

class SlowAbortableProposer implements RouteProposer {
  readonly name = "slow-abortable-proposer";
  called = false;
  aborted = false;

  async propose(
    _input: Parameters<RouteProposer["propose"]>[0],
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ feature: string; choose: string; rationale: string }>> {
    this.called = true;
    return new Promise((_, reject) => {
      const signal = options?.signal;
      if (!signal) return reject(new Error("missing abort signal"));
      const abort = () => {
        this.aborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

async function setup(fresh = false, routeProposer?: RouteProposer): Promise<AppInstance> {
  if (fresh) {
    const previous = inst;
    inst = undefined;
    previous?.close();
  }
  if (inst) return inst;
  const { ensureCapabilityGenome } = await import("../../src/evolution/assets.ts");
  const app = routeProposer
    ? openInstance(tempInstanceRoot(), {
        runtimeAdapter: {
          version: "proteus-runtime-adapter-v1",
          id: "test-learning@1",
          routeProposer,
        },
      })
    : bootSeededInstance();
  if (routeProposer) {
    installSeed({
      kernel: app.kernel,
      storage: app.storage,
      blobs: app.blobs,
      clock: { now: Date.now },
    });
  }
  upgradeJudgeToActive(app);
  const genome = ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
      capabilities: [
        {
          name: "changed-file-summary",
          module: {
            kind: "capability-module-v1",
            name: "changed-file-summary",
            entry: "index.mjs",
            files: [
              {
                path: "index.mjs",
                content: readFileSync(join(CFS, "implementation.mjs"), "utf8"),
              },
            ],
          },
        },
      ],
      createdBy: "principal-local",
    },
  );
  app.storage.tx(() => {
    const fresh = app.kernel.getOrganism("organism-default")!;
    if (!app.kernel.installAsActive("organism-default", genome.snapshot.id, fresh.revision).ok) {
      throw new Error("装配 CAS 冲突");
    }
  });
  inst = app;
  return app;
}

const SUMMARY_GOAL = "请把这次改动的文件按类别整理成清单";

async function seedFailingExperiences(app: AppInstance): Promise<void> {
  for (const goal of [SUMMARY_GOAL, `${SUMMARY_GOAL}（第二次）`]) {
    const failed = await app.runtime.submitTask({
      requestedBy: "principal-local",
      goal,
      inputs: [join(CFS, "inputs", "changed-files.json")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: join(CFS, "schema.json"),
        verifier: "stats-acceptance",
      },
    });
    expect(failed.state).toBe("failed");
  }
}

describe("Consolidation 异步队列", () => {
  it("submit → queued → run → completed（零提议也是 completed）；同参数幂等", async () => {
    const app = await setup();
    await seedFailingExperiences(app);
    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });

    const { job, created } = app.evolution.submitConsolidationJob({
      datasetId: frozen.dataset.id,
      createdBy: "principal-local",
    });
    expect(created).toBe(true);
    expect(job.state).toBe("queued");

    // 同参数再提交：幂等复用
    const dup = app.evolution.submitConsolidationJob({
      datasetId: frozen.dataset.id,
      createdBy: "principal-local",
    });
    expect(dup.created).toBe(false);
    expect(dup.job.id).toBe(job.id);

    // 无 gold：执行完成但零提议（正常结果，不是失败）
    const results = await app.evolution.runPendingConsolidationJobs(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("completed");
    expect(results[0]!.detail).toContain("零提议");

    const done = app.evolution.consolidationJob(job.id);
    expect(done.state).toBe("completed");
    expect(done.result?.candidateId).toBeNull();
    expect(done.result?.hypothesis).toContain("证据不足");
    // 事件留痕
    const events = app.storage.listEvents({ streamId: `job-${job.id}` }, 10);
    expect(events.map((e) => e.type)).toEqual([
      "consolidation.job.submitted",
      "consolidation.job.started",
      "consolidation.job.completed",
    ]);
    // 队列清空
    expect(await app.evolution.runPendingConsolidationJobs(1)).toHaveLength(0);
  });

  it("带 gold 的作业产出候选；cancel 仅作用 queued", async () => {
    const app = await setup();
    await seedFailingExperiences(app);
    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const gold = JSON.parse(readFileSync(join(PE, "gold.json"), "utf8")) as Array<{
      goal: string;
      choice: string;
    }>;
    const validationSetId = registerPolicyValidationSet(app, policyValidationPlan());

    const { job } = app.evolution.submitConsolidationJob({
      datasetId: frozen.dataset.id,
      validationSetId,
      goldMatches: gold,
      createdBy: "principal-local",
    });

    // 取消 queued 作业后重新提交执行
    const cancelled = app.evolution.cancelConsolidationJob(job.id);
    expect(cancelled.state).toBe("cancelled");
    const { job: job2 } = app.evolution.submitConsolidationJob({
      datasetId: frozen.dataset.id,
      validationSetId,
      goldMatches: gold,
      createdBy: "principal-local",
    });
    const results = await app.evolution.runPendingConsolidationJobs(1);
    expect(results[0]!.outcome).toBe("completed");
    expect(results[0]!.detail).toContain("候选");

    const done = app.evolution.consolidationJob(job2.id);
    expect(done.result?.candidateId).toBeTruthy();

    // 终态作业不能取消
    const after = app.evolution.cancelConsolidationJob(job2.id);
    expect(after.state).toBe("completed");
    expect(after.note).toContain("不能取消");
  });

  it("非 development 数据集拒绝入队", async () => {
    const app = bootSeededInstance();
    const regression = app.evolution.freezeExperienceWindow({
      purpose: "regression",
      runIds: [],
      createdBy: "principal-local",
    });
    expect(() =>
      app.evolution.submitConsolidationJob({
        datasetId: regression.dataset.id,
        createdBy: "principal-local",
      }),
    ).toThrowError(/仅 development 许可/);
    app.close();
  });
});

describe("LLM 归纳模式（fake proposer）", () => {
  it("提议只看缺口样本（不含 gold），统计门槛重算后达标才成候选；provenance 入 sourceRefs", async () => {
    // 独立实例：避免与前序 rule 候选 digest 去重（同 bindings 复用旧记录是
    // 正确幂等行为，但 provenance 属首次构造）
    const app = await setup(true);
    await seedFailingExperiences(app);

    // 真实混合场景：既有能力路由成功的经验（证据来源），也有未声明能力的
    // 失败样本（缺口提示）。LLM 只看缺口，重算证据来自成功经验。
    for (const goal of [
      "对变更清单生成可验证的文件分类摘要（成功经验样本一）",
      "按类别汇总变更文件（成功经验样本二）",
    ]) {
      const ok = await app.runtime.submitTask({
        requestedBy: "principal-local",
        goal,
        inputs: [join(CFS, "inputs", "changed-files.json")],
        budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
        requires: ["changed-file-summary"],
        acceptance: { outputSchema: join(CFS, "schema.json"), verifier: "stats-acceptance" },
      });
      expect(ok.state).toBe("succeeded");
    }
    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const validationSetId = registerPolicyValidationSet(app, policyValidationPlan());

    const fake = new FakeRouteProposer();
    // 达标提议（成功经验支撑）+ 不达标提议（无证据的猜测）
    fake.proposals = [
      {
        feature: "hasChangeIntent",
        choose: "capability/changed-file-summary",
        rationale: "变更类任务",
      },
      { feature: "hasStatsIntent", choose: "local-process", rationale: "猜测" },
    ];
    const { Evolution } = await import("../../src/evolution/index.ts");
    const evo = new Evolution({
      kernel: app.kernel,
      storage: app.storage,
      blobs: app.blobs,
      runtime: app.runtime,
      organismId: "organism-default",
      instanceRoot: app.root,
      clock: { now: Date.now },
      ids: { next: () => crypto.randomUUID() },
      routeProposer: fake,
    });

    const result = await evo.proposePolicyCandidate({
      datasetId: frozen.dataset.id,
      validationSetId,
      mode: "llm",
      createdBy: "principal-local",
    });

    // 调用合同：gapSamples 不含正确答案，仅缺口摘要
    expect(fake.lastInput).not.toBeNull();
    expect(fake.lastInput!.gapSamples.length).toBeGreaterThanOrEqual(2);
    expect(fake.lastInput!.gapSamples[0]).toMatchObject({ goal: SUMMARY_GOAL });
    expect("choice" in (fake.lastInput!.gapSamples[0] as object)).toBe(false);
    expect(fake.lastInput!.options).toContain("capability/changed-file-summary");
    expect(fake.lastInput!.features).toContain("hasChangeIntent");

    // 统计重算：达标提议成候选（成功经验支撑），无证据猜测被丢弃
    expect(result.candidate).not.toBeNull();
    const hypothesis = result.consolidation.hypothesis;
    expect(hypothesis).toContain("统计重算保留 1 条");
    expect(hypothesis).toContain("丢弃 1 条");
    // provenance 记入候选 sourceRefs
    const stored = app.storage.getCandidate(result.candidate!.id)!;
    expect(stored.sourceRefs["llmProposer"]).toBe("fake-proposer");
    expect(stored.sourceRefs["llmPromptDigest"]).toBe("p-digest");
    expect(stored.sourceRefs["llmResponseDigest"]).toBe("r-digest");
    // 候选策略内容含达标规则、不含被丢弃的猜测
    const policyContent = JSON.parse(
      app.blobs.read(
        app.kernel.resolveSnapshot(stored.proposedSnapshotId).versions.get("routing-policy")!
          .contentRef,
      ),
    ) as { featureRoutes: Array<{ feature: string }> };
    expect(policyContent.featureRoutes.map((r) => r.feature)).toEqual(["hasChangeIntent"]);
  });

  it("refineProposals：无证据支持的提议被丢弃并记录原因", async () => {
    const { refineProposals } = await import("../../src/evolution/consolidation.ts");
    const samples = [
      {
        runId: "r1",
        experienceId: "e1",
        features: { hasChangeIntent: true },
        chosen: "capability/x",
        succeeded: false,
        origin: "gold" as const,
      },
      {
        runId: "r2",
        experienceId: "e2",
        features: { hasChangeIntent: true },
        chosen: "capability/x",
        succeeded: false,
        origin: "gold" as const,
      },
    ];
    const refined = refineProposals(
      samples,
      [
        { feature: "hasChangeIntent", choose: "capability/x", rationale: "正确方向" },
        { feature: "hasStatsIntent", choose: "local-process", rationale: "无证据猜测" },
        { feature: "bogus-feature", choose: "local-process" },
      ],
      { minSupport: 2, minPrecision: 0.8, maxRules: 4 },
    );
    expect(refined.accepted).toHaveLength(1);
    expect(refined.accepted[0]).toMatchObject({
      feature: "hasChangeIntent",
      choose: "capability/x",
      support: 2,
      byOrigin: { experience: 0, gold: 2 },
    });
    expect(refined.rejected.length).toBe(2);
    expect(refined.rejected.find((r) => r.feature === "bogus-feature")).toBeTruthy();
  });

  it("mode=llm 未装配 proposer 明确报错", async () => {
    const app = await setup();
    await seedFailingExperiences(app);
    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const validationSetId = registerPolicyValidationSet(app, policyValidationPlan());
    // 默认实例（openInstance 未注入 proposer）提交 llm 作业并执行
    const { job } = app.evolution.submitConsolidationJob({
      datasetId: frozen.dataset.id,
      validationSetId,
      mode: "llm",
      createdBy: "principal-local",
    });
    const results = await app.evolution.runPendingConsolidationJobs(1);
    expect(results[0]!.outcome).toBe("failed");
    expect(results[0]!.detail).toContain("RouteProposer");
    const done = app.evolution.consolidationJob(job.id);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("PROTEUS_LLM_API_KEY");
  });

  it("额度为零不调用 proposer；运行中取消传递 abort 并保留 unknown 额度", async () => {
    const deniedProposer = new SlowAbortableProposer();
    const denied = await setup(true, deniedProposer);
    await seedFailingExperiences(denied);
    const dev = denied.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const deniedSet = registerPolicyValidationSet(denied, policyValidationPlan());
    denied.storage.setLearningCallLimit("organism-default", 0);
    const deniedJob = denied.evolution.submitConsolidationJob({
      datasetId: dev.dataset.id,
      validationSetId: deniedSet,
      mode: "llm",
      createdBy: "principal-local",
    }).job;
    const deniedResult = await denied.evolution.runPendingConsolidationJobs(1);
    expect(deniedResult[0]!.outcome).toBe("failed");
    expect(deniedResult[0]!.detail).toContain("学习调用额度耗尽");
    expect(deniedProposer.called).toBe(false);
    expect(denied.storage.learningCalls("organism-default")).toHaveLength(0);
    expect(denied.evolution.consolidationJob(deniedJob.id).state).toBe("failed");

    const slow = new SlowAbortableProposer();
    const app = await setup(true, slow);
    await seedFailingExperiences(app);
    const dataset = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const validationSetId = registerPolicyValidationSet(app, policyValidationPlan());
    app.storage.setLearningCallLimit("organism-default", 1);
    const job = app.evolution.submitConsolidationJob({
      datasetId: dataset.dataset.id,
      validationSetId,
      mode: "llm",
      createdBy: "principal-local",
    }).job;
    const running = app.evolution.runPendingConsolidationJobs(1);
    for (let attempt = 0; attempt < 100 && !slow.called; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(slow.called).toBe(true);
    const cancel = app.evolution.cancelConsolidationJob(job.id);
    expect(cancel.note).toContain("未知成本");
    const results = await running;
    expect(results[0]!.outcome).toBe("cancelled");
    expect(slow.aborted).toBe(true);
    const calls = app.storage.learningCalls("organism-default");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toBe("unknown");
    expect(app.storage.learningCallLimit("organism-default")).toBe(1);
  });
});
