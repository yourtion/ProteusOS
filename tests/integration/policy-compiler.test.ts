import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { parseLlmDemosPolicy } from "../../src/decision/index.ts";
import { compileHarness } from "../fixtures/compilation/harness.ts";

const opened: AppInstance[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});
async function fixture(shared = false) {
  const h = await compileHarness(shared);
  opened.push(h.app);
  return h;
}

describe("有界示例编译", () => {
  it("冻结 train/search、逐调用预算和证据；只生成唯一候选，正式集未消费且不能晋升", async () => {
    const h = await fixture();
    const active = h.app.kernel.getOrganism("organism-default")!.activeGenomeId;
    const { job } = h.app.evolution.compiler.submit(h.input);
    expect(h.app.evolution.compiler.submit(h.input)).toMatchObject({
      created: false,
      job: { id: job.id },
    });
    const done = await h.app.evolution.compiler.run(job.id);
    expect(done.state, done.error ?? "").toBe("completed");
    expect(done.candidateId).toBeTruthy();
    expect(h.backend.requests).toHaveLength(4);
    const report = h.app.evolution.compiler.report(job.id);
    expect(report).toMatchObject({
      winner: 1,
      executionMode: "fixture",
      formalEvaluation: "not_run",
      configurations: [
        { accuracy: 0, completed: 2, families: 2 },
        { accuracy: 1, completed: 2, families: 2 },
      ],
      resources: {
        source: { modelCalls: 3, inputTokens: 30, outputTokens: 6 },
        reserved: { calls: 7, inputTokens: 4030, outputTokens: 1030 },
      },
    });
    expect(h.app.storage.learningCalls("organism-default")).toHaveLength(4);
    const candidate = h.app.storage.getCandidate(done.candidateId!)!;
    const policyVersion = h.app.kernel
      .resolveSnapshot(candidate.proposedSnapshotId)
      .versions.get("routing-policy")!;
    expect(
      parseLlmDemosPolicy(JSON.parse(h.app.blobs.read(policyVersion.contentRef))).parameters
        .demoIds,
    ).toEqual([h.cases[0]!.id]);
    expect(h.app.storage.getValidationSet(h.input.validationSetId)).toMatchObject({
      candidateId: candidate.id,
      usageCount: 0,
      state: "ready",
    });
    expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(active);
    expect(await h.app.evolution.compiler.run(job.id)).toEqual(done);
    expect(h.app.evolution.compiler.submit(h.input).job.id).toBe(job.id);
    expect(h.app.storage.listCandidates("organism-default", 10)).toHaveLength(1);
    await expect(h.app.evolution.evaluatePolicyCandidate(candidate.id)).rejects.toThrow(
      /不是策略候选/,
    );
    expect(() =>
      h.app.evolution.promote(candidate.id, { authorizedBy: "principal-local" }),
    ).toThrow(/eligible/);
    const requestText = JSON.stringify(h.backend.requests.map((r) => r.prepared));
    expect(requestText).not.toMatch(
      /reserved-formal|reserved-regression|verificationRef|familyId|expectedChoice/,
    );
  });

  it("零改善是正常零候选，不领用验证集；报告重算不调用模型", async () => {
    const h = await fixture();
    h.backend.handler = async (request) => ({
      kind: "value",
      value: "local-process",
      provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
    });
    const { job } = h.app.evolution.compiler.submit(h.input);
    expect(await h.app.evolution.compiler.run(job.id)).toMatchObject({
      state: "completed",
      candidateId: null,
    });
    expect(h.app.evolution.compiler.report(job.id).winner).toBeNull();
    expect(h.app.storage.getValidationSet(h.input.validationSetId)!.usageCount).toBe(0);
    expect(h.app.storage.listCandidates("organism-default", 10)).toHaveLength(0);
    const snapshot = h.app.evolution.compiler.report(job.id);
    expect(h.app.evolution.compiler.report(job.id)).toEqual(snapshot);
    expect(h.backend.requests).toHaveLength(4);
    h.backend.handler = async (request) => ({
      kind: "abstain",
      reason: "来源未提供",
      provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
    });
    const unknown = h.app.evolution.compiler.submit({
      ...h.input,
      budget: { ...h.input.budget, wallClockMs: 29_999 },
    }).job;
    expect((await h.app.evolution.compiler.run(unknown.id)).candidateId).toBeNull();
    expect(
      h.app.evolution.compiler
        .report(unknown.id)
        .trials.every((t) => t.outcome === "abstain_origin_unavailable" && t.correct === false),
    ).toBe(true);
  });

  it("没有可核验 token 上界不发请求；总预算/个体累计额度不被重提重置", async () => {
    const h = await fixture();
    h.port.bounds = () => null;
    const { job } = h.app.evolution.compiler.submit(h.input);
    expect(await h.app.evolution.compiler.run(job.id)).toMatchObject({
      state: "failed",
      candidateId: null,
    });
    expect(h.backend.requests).toHaveLength(0);
    expect(h.app.storage.learningCalls("organism-default")).toHaveLength(0);
    h.port.bounds = () => ({ inputTokens: 1000, outputTokens: 256 });
    h.app.storage.setLearningCallLimit("organism-default", 1);
    const next = h.app.evolution.compiler.submit({
      ...h.input,
      budget: { ...h.input.budget, wallClockMs: 29_999 },
    }).job;
    expect((await h.app.evolution.compiler.run(next.id)).error).toContain("累计学习");
    expect(h.backend.requests).toHaveLength(1);
    expect(
      h.app.evolution.compiler.submit({
        ...h.input,
        budget: { ...h.input.budget, wallClockMs: 29_999 },
      }).job.id,
    ).toBe(next.id);
    expect(h.app.storage.learningCalls("organism-default")).toHaveLength(1);
  });

  it("取消在途调用保留未知额度、阻止迟到结果与候选；queued 取消零调用", async () => {
    const h = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (value: unknown) => void;
    h.backend.handler = () => {
      entered();
      return new Promise((resolve) => {
        release = (value) => resolve(value as never);
      });
    };
    const { job } = h.app.evolution.compiler.submit(h.input);
    const running = h.app.evolution.compiler.run(job.id);
    await started;
    expect(() => h.app.evolution.compiler.recover()).toThrow(/活跃/);
    h.app.evolution.compiler.cancel(job.id);
    const stopped = await running;
    expect(stopped).toMatchObject({ state: "cancelled", candidateId: null });
    expect(h.app.storage.learningCalls("organism-default")).toMatchObject([{ state: "unknown" }]);
    release({
      kind: "value",
      value: "local-process",
      provenance: { provider: "decision-llm", policyVersion: "late" },
    });
    await Promise.resolve();
    expect(h.app.evolution.compiler.report(job.id).trials[0]!.state).toBe("unknown");
    expect(h.app.storage.listCandidates("organism-default", 10)).toHaveLength(0);
    const queued = h.app.evolution.compiler.submit({
      ...h.input,
      budget: { ...h.input.budget, wallClockMs: 29_999 },
    }).job;
    h.app.evolution.compiler.cancel(queued.id);
    expect(await h.app.evolution.compiler.run(queued.id)).toMatchObject({ state: "cancelled" });
    expect(h.backend.requests).toHaveLength(1);
  });
});

it("任务标注与用途不能被重包装，search 不能入示例；来源漂移在发送前阻止", async () => {
  const h = await fixture();
  const first = h.cases[0]!;
  expect(() =>
    h.app.evolution.compiler.registerCase({
      datasetId: first.datasetId,
      runId: first.runId,
      decisionId: first.decisionId,
      caseId: "renamed",
      split: "search",
      permission: "synthetic",
      expectedChoice: "local-process",
      verifiedBy: "principal-local",
    }),
  ).toThrow(/family/);
  expect(() =>
    h.app.evolution.compiler.registerCase({
      datasetId: first.datasetId,
      runId: first.runId,
      decisionId: first.decisionId,
      caseId: first.caseId,
      split: "train",
      permission: "synthetic",
      expectedChoice: "capability/changed-file-summary",
      verifiedBy: "principal-local",
    }),
  ).toThrow(/独立路由/);
  expect(() =>
    h.app.evolution.compiler.submit({ ...h.input, parameterSets: [[], [h.cases[1]!.id]] }),
  ).toThrow(/未知/);
  expect(() =>
    h.app.evolution.compiler.submit({ ...h.input, parameterSets: [[], [], [first.id]] }),
  ).toThrow(/重复/);
  expect(() =>
    h.app.evolution.compiler.submit({ ...h.input, budget: { ...h.input.budget, maxCalls: 6 } }),
  ).toThrow(/总预算/);
  const job = h.app.evolution.compiler.submit(h.input).job;
  const call = h.app.storage.getDecisionCall(first.decisionId)!;
  writeFileSync(join(h.root, "blobs", call.requestRef!), "corrupted source request");
  const failed = await h.app.evolution.compiler.run(job.id);
  expect(failed.state).toBe("failed");
  expect(h.backend.requests).toHaveLength(0);
});

it("累计 token 预留不随已知实际用量退还；后端违反上界保留响应并停止", async () => {
  const h = await fixture();
  const job = h.app.evolution.compiler.submit({
    ...h.input,
    budget: { ...h.input.budget, maxInputTokens: 1030 },
  }).job;
  expect((await h.app.evolution.compiler.run(job.id)).error).toContain("累计预算");
  expect(h.app.evolution.compiler.report(job.id).resources.reserved.inputTokens).toBe(1030);
  expect(h.backend.requests).toHaveLength(1);
  h.backend.handler = async (request) => ({
    kind: "value",
    value: "local-process",
    provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
    evidence: { inputTokens: 1001, outputTokens: 1 },
  });
  const breach = h.app.evolution.compiler.submit(h.input).job;
  expect((await h.app.evolution.compiler.run(breach.id)).error).toContain("token 上界");
  const report = h.app.evolution.compiler.report(breach.id);
  expect(report.trials[0]).toMatchObject({
    state: "completed",
    usage: { inputTokens: 1001 },
    responseRef: expect.any(String),
  });
  expect(report.candidateId).toBeNull();
});

it("同一作业并发领取仅一个 worker；并发取消不创建候选", async () => {
  const h = await fixture();
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.backend.handler = async () => {
    entered();
    return new Promise(() => {});
  };
  const job = h.app.evolution.compiler.submit(h.input).job;
  const first = h.app.evolution.compiler.run(job.id);
  await reached;
  expect((await h.app.evolution.compiler.run(job.id)).state).toBe("running");
  expect(h.backend.requests).toHaveLength(1);
  h.app.evolution.compiler.cancel(job.id);
  await first;
  expect(h.app.storage.listCandidates("organism-default", 10)).toHaveLength(0);
});

it("超时不补考，未知调用与额度在重新打开实例后仍保留", async () => {
  const h = await fixture();
  h.backend.handler = async () => new Promise(() => {});
  const job = h.app.evolution.compiler.submit({
    ...h.input,
    budget: { ...h.input.budget, callTimeoutMs: 10 },
  }).job;
  expect((await h.app.evolution.compiler.run(job.id)).state).toBe("failed");
  expect(h.app.evolution.compiler.report(job.id).trials[0]).toMatchObject({
    state: "unknown",
    outcome: "timeout",
  });
  const fresh = openInstance(h.root);
  opened.push(fresh);
  expect((await fresh.evolution.compiler.run(job.id)).state).toBe("failed");
  expect(fresh.storage.learningCalls("organism-default")).toHaveLength(1);
  expect(fresh.evolution.compiler.recover()).toEqual([]);
  expect(h.backend.requests).toHaveLength(1);
});

for (const checkpoint of ["prepared", "started", "before-candidate"] as const) {
  it(`崩溃恢复 ${checkpoint}：原调用、截止点与唯一候选原子边界`, async () => {
    const h = await fixture();
    const job = h.app.evolution.compiler.submit(h.input).job;
    const realTx = h.app.storage.tx.bind(h.app.storage);
    let armed = true;
    const tx = vi.spyOn(h.app.storage, "tx").mockImplementation((fn) => {
      const result = realTx(fn);
      const trial = h.app.storage.compileTrials(job.id).at(-1);
      if (armed && checkpoint !== "before-candidate" && trial?.state === checkpoint) {
        armed = false;
        throw new Error(`simulated process loss after ${checkpoint} commit`);
      }
      return result;
    });
    const insert =
      checkpoint === "before-candidate"
        ? vi.spyOn(h.app.storage, "insertCandidate").mockImplementation(() => {
            throw new Error("simulated loss before candidate commit");
          })
        : null;
    await h.app.evolution.compiler.run(job.id);
    tx.mockRestore();
    insert?.mockRestore();
    expect(h.app.storage.listCandidates("organism-default", 10)).toHaveLength(0);
    const interrupted = h.app.evolution.compiler.job(job.id);
    // 模拟真正进程终止时保留 running（测试中的可捕获异常会先记 failed）。
    h.app.storage.updateCompileJob({ ...interrupted, state: "running", error: null });
    const deadline = interrupted.deadlineAt;
    const fresh = openInstance(h.root, { compileBackend: h.port });
    opened.push(fresh);
    const beforeCalls = h.backend.requests.length;
    const recovered = fresh.evolution.compiler.recover();
    if (checkpoint === "started") {
      expect(recovered[0]!.state).toBe("failed");
      expect((await fresh.evolution.compiler.run(job.id)).state).toBe("failed");
      expect(fresh.storage.learningCalls("organism-default")).toMatchObject([{ state: "unknown" }]);
      expect(h.backend.requests).toHaveLength(beforeCalls);
    } else {
      expect(recovered[0]!.state).toBe("queued");
      const complete = await fresh.evolution.compiler.run(job.id);
      expect(complete.state, complete.error ?? "").toBe("completed");
      expect(complete.deadlineAt).toBe(deadline);
      expect(fresh.storage.learningCalls("organism-default")).toHaveLength(4);
      expect(fresh.storage.listCandidates("organism-default", 10)).toHaveLength(1);
      if (checkpoint === "before-candidate") expect(h.backend.requests).toHaveLength(beforeCalls);
      else expect(h.backend.requests).toHaveLength(4);
      expect((await fresh.evolution.compiler.run(job.id)).candidateId).toBe(complete.candidateId);
    }
  });
}

it("编译期间撤销版本读取权后停止新调用，报告仍留给有权 operator 读取", async () => {
  const h = await fixture(true);
  h.app.kernel.createPrincipal("compiler-operator", "user");
  h.app.kernel.grantAccess(
    "organism:organism-default",
    "compiler-operator",
    "manage",
    "principal-local",
  );
  h.app.kernel.grantAccess("team:compiler-sources", "compiler-operator", "read", "principal-local");
  const delegated = openInstance(h.root, { actorId: "compiler-operator", compileBackend: h.port });
  opened.push(delegated);
  const job = delegated.evolution.compiler.submit({
    ...h.input,
    requestedBy: "compiler-operator",
  }).job;
  h.backend.handler = async (request) => {
    h.app.kernel.revokeAccess(
      "team:compiler-sources",
      "compiler-operator",
      "read",
      "principal-local",
    );
    return {
      kind: "value",
      value: "local-process",
      provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
    };
  };
  const stopped = await delegated.evolution.compiler.run(job.id);
  expect(stopped).toMatchObject({ state: "failed", candidateId: null });
  expect(h.backend.requests).toHaveLength(1);
  expect(h.app.evolution.compiler.report(job.id).trials).toHaveLength(1);
  expect(() => delegated.evolution.compiler.report(job.id)).toThrow(/权限/);
});

it("跨单元更换编译后端版本会停止，不能借恢复或新配置换服务", async () => {
  const h = await fixture();
  const job = h.app.evolution.compiler.submit(h.input).job;
  h.backend.handler = async (request) => {
    h.port.version = "changed-backend-version";
    return {
      kind: "value",
      value: "local-process",
      provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
    };
  };
  expect((await h.app.evolution.compiler.run(job.id)).error).toContain("后端或端点漂移");
  expect(h.backend.requests).toHaveLength(1);
  expect(h.app.storage.learningCalls("organism-default")).toHaveLength(1);
});
