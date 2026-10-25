import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { auditCompileEvidence } from "../../src/app/experiment/compile-evidence.ts";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { compileHarness } from "../fixtures/compilation/harness.ts";

const opened: AppInstance[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});
async function fixture() {
  const h = await compileHarness();
  opened.push(h.app);
  const { job } = h.app.evolution.compiler.submit(h.input);
  await h.app.evolution.compiler.run(job.id);
  return {
    ...h,
    job,
    audit: () =>
      auditCompileEvidence(
        { ...h.app, organismId: "organism-default", actorId: "principal-local" },
        job.id,
      ),
  };
}

it("核对原始请求/响应、来源 Run、执行轨迹和学习账本；清理工作区后重启可重复核验", async () => {
  const h = await fixture();
  const audited = h.audit();
  expect(audited).toMatchObject({
    version: "compile-evidence-audit-v1",
    verification: "persisted-development-records",
    declaredMode: "fixture",
    remoteExecution: "not-independently-verified",
    candidateBinding: "verified",
    sourceRuns: 3,
    learningCalls: 4,
    formalEvaluation: "not_run",
    report: {
      winner: 1,
      resources: { knownInputTokens: 110, knownOutputTokens: 26, unknownCostCalls: 7 },
    },
  });
  expect(audited.evidenceRefs.filter((ref) => ref.startsWith("attempt:"))).toHaveLength(3);
  expect(h.audit()).toEqual(audited);
  expect(h.backend.requests).toHaveLength(4);
  rmSync(join(h.app.root, "workspaces"), { recursive: true, force: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(
    auditCompileEvidence(
      { ...reopened, organismId: "organism-default", actorId: "principal-local" },
      h.job.id,
    ),
  ).toEqual(audited);
  expect(h.app.evolution.validationSet(h.input.validationSetId).usageCount).toBe(0);
});

it("更改 Trial 评分或用量不能仅靠重算汇总掩盖，必须符合原始响应", async () => {
  const h = await fixture();
  const original = h.app.storage.compileTrials(h.job.id)[0]!;
  h.app.storage.tx(() =>
    h.app.storage.updateCompileTrial({ ...original, correct: !original.correct }),
  );
  expect(() => h.audit()).toThrow("重算结果与评分");
  h.app.storage.tx(() =>
    h.app.storage.updateCompileTrial({
      ...original,
      usage: { ...original.usage!, inputTokens: 0 },
    }),
  );
  expect(() => h.audit()).toThrow("学习调用状态/用量");
  h.app.storage.tx(() =>
    h.app.storage.updateCompileTrial({
      ...original,
      usage: { ...original.usage!, costAmount: 0, costCurrency: "USD", priceRef: "forged-price" },
    }),
  );
  expect(() => h.audit()).toThrow("原始响应与编译用量");
  h.app.storage.tx(() => h.app.storage.updateCompileTrial(original));
  expect(h.audit().report.winner).toBe(1);
});

it("原始请求或响应 blob 漂移，即使 Trial 和摘要字段未变也拒绝", async () => {
  const h = await fixture();
  const trial = h.app.storage.compileTrials(h.job.id)[0]!;
  const raw = h.app.blobs.read(trial.requestRef);
  writeFileSync(join(h.app.root, "blobs", trial.requestRef), "{}");
  expect(() => h.audit()).toThrow("blob 摘要漂移");
  writeFileSync(join(h.app.root, "blobs", trial.requestRef), raw);
  writeFileSync(join(h.app.root, "blobs", trial.responseRef!), "{}");
  expect(() => h.audit()).toThrow("blob 摘要漂移");
});

it("来源用量改变或插入额外调用会破坏冻结预算，不能输出已核验开发证据", async () => {
  const h = await fixture();
  const call = h.app.storage.listDecisionCalls(h.cases[0]!.runId)[0]!;
  h.app.storage.tx(() =>
    h.app.storage.updateDecisionCall(
      call.id,
      { usage: { ...call.usage!, inputTokens: 0 } },
      { updatedAt: call.updatedAt },
    ),
  );
  expect(() => h.audit()).toThrow("来源调用用量");
  h.app.storage.tx(() => {
    h.app.storage.updateDecisionCall(call.id, { usage: call.usage }, { updatedAt: call.updatedAt });
    h.app.storage.insertDecisionCall({ ...call, id: "extra-source-call" });
  });
  expect(() => h.audit()).toThrow("额外决策调用");
});

it("unknown、取消和零改善也能核验，但不会补跑、重选或制造正式证据", async () => {
  const h = await compileHarness();
  opened.push(h.app);
  h.backend.handler = async () => {
    throw new Error("connection-lost");
  };
  const { job } = h.app.evolution.compiler.submit(h.input);
  await h.app.evolution.compiler.run(job.id);
  const audit = auditCompileEvidence(
    { ...h.app, organismId: "organism-default", actorId: "principal-local" },
    job.id,
  );
  expect(audit.report).toMatchObject({
    state: "failed",
    winner: null,
    trials: [{ state: "unknown", correct: null }],
    formalEvaluation: "not_run",
  });
  expect(h.backend.requests).toHaveLength(1);
  const queued = h.app.evolution.compiler.submit({
    ...h.input,
    budget: { ...h.input.budget, wallClockMs: 29_999 },
  }).job;
  h.app.evolution.compiler.cancel(queued.id);
  expect(
    auditCompileEvidence(
      { ...h.app, organismId: "organism-default", actorId: "principal-local" },
      queued.id,
    ),
  ).toMatchObject({ learningCalls: 0, report: { state: "cancelled", winner: null } });
  h.backend.handler = async (request) => ({
    kind: "value",
    value: "local-process",
    provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
  });
  const negative = h.app.evolution.compiler.submit({
    ...h.input,
    budget: { ...h.input.budget, wallClockMs: 29_998 },
  }).job;
  await h.app.evolution.compiler.run(negative.id);
  expect(
    auditCompileEvidence(
      { ...h.app, organismId: "organism-default", actorId: "principal-local" },
      negative.id,
    ),
  ).toMatchObject({
    candidateBinding: "none",
    learningCalls: 4,
    report: { state: "completed", winner: null },
  });
});

it("学习账本中的孤立调用、来源轨迹损坏和主体无权读取会拒绝核验", async () => {
  const h = await fixture();
  const traceRef = h.cases[0]!.metering.executions[0]!.evidence!.traceRef!;
  const originalTrace = h.app.blobs.read(traceRef);
  writeFileSync(join(h.app.root, "blobs", traceRef), "{}");
  expect(() => h.audit()).toThrow("execution_trace_digest_mismatch");
  writeFileSync(join(h.app.root, "blobs", traceRef), originalTrace);
  h.app.storage.tx(() =>
    h.app.storage.insertLearningCall({
      id: "orphan-call",
      jobId: h.job.id,
      organismId: "organism-default",
      state: "reserved",
      usage: null,
      error: null,
      createdAt: Date.now(),
      endedAt: null,
    }),
  );
  expect(() => h.audit()).toThrow("未计量调用");
  expect(() =>
    auditCompileEvidence({ ...h.app, organismId: "organism-default", actorId: "absent" }, h.job.id),
  ).toThrow();
});
