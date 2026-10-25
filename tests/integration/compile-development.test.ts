import {
  cpSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AdaptiveJournal } from "../../src/app/experiment/journal.ts";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import {
  adaptiveTask,
  freezeAdaptivePlan,
  reportAdaptiveExperiment,
} from "../../src/app/experiment/adaptive.ts";
import {
  bindCompileDevelopment,
  prepareCompileDevelopment,
} from "../../src/app/experiment/development.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { compileHarness } from "../fixtures/compilation/harness.ts";
import { DEV_DATASET } from "../fixtures/decision/harness.ts";
import { rehearsalPlan } from "../fixtures/adaptive-behavior/rehearsal.ts";

const opened: AppInstance[] = [];
const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of opened.splice(0)) app.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(mode: "fixture" | "real" = "fixture", winner = true, shared = false) {
  const dataset = mkdtempSync(join(tmpdir(), "proteus-development-"));
  folders.push(dataset);
  cpSync(DEV_DATASET, dataset, { recursive: true });
  const h = await compileHarness(shared, dataset);
  opened.push(h.app);
  h.port.mode = mode;
  if (!winner)
    h.backend.handler = async (request) => ({
      kind: "value",
      value: "local-process",
      provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
      evidence: { inputTokens: 20, outputTokens: 5 },
    });
  const { job } = h.app.evolution.compiler.submit(h.input);
  await h.app.evolution.compiler.run(job.id);
  const deps = { ...h.app, organismId: "organism-default", actorId: "principal-local" };
  return { ...h, dataset, job, deps };
}

function manifest(prepared: ReturnType<typeof prepareCompileDevelopment>) {
  const { bundle } = prepared;
  const plan = rehearsalPlan().plan;
  plan.cases = [
    ...bundle.cases,
    ...plan.cases.filter((c) => c.split === "formal" || c.split === "regression"),
  ];
  plan.development = structuredClone(bundle.development);
  plan.policies = {
    baseDigest: bundle.policies.baseDigest,
    candidateDigest: bundle.policies.candidateDigest ?? digestOf("no-candidate"),
  };
  Object.assign(plan.fixed, bundle.fixed);
  plan.source = bundle.source;
  plan.sourceDigest = digestOf(
    canonicalJson({ developmentDigest: prepared.record.digest, cases: plan.cases }),
  );
  plan.developmentClosedAt = Math.max(Date.now(), prepared.record.createdAt);
  plan.frozenAt = plan.developmentClosedAt;
  plan.budget.modelCalls = 128;
  plan.budget.outputTokens = 20000;
  return freezeAdaptivePlan(plan);
}

it("所有来源决策、Attempt 和搜索调用映射一次；已知用量不因执行器未知而丢失", async () => {
  const h = await fixture();
  const before = h.app.kernel.getOrganism("organism-default")!.activeGenomeId;
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  expect(prepared.bundle.development).toHaveLength(10);
  expect(prepared.bundle.unknownBoundUnits).toHaveLength(3);
  expect(prepared.bundle.tasks[0]!.task.inputs.map((input) => input.name)).toEqual([
    "b01/file-a.md",
    "b01/file-b.txt",
    "changed-files.json",
  ]);
  const frozen = manifest(prepared);
  const bound = bindCompileDevelopment(h.deps, h.job.id, frozen);
  expect(bound.observations.every((row) => row.accepted === null && row.misrouted === null)).toBe(
    true,
  );
  const report = reportAdaptiveExperiment(frozen, bound.observations);
  expect(report.resources).toMatchObject({
    modelCalls: { knownTotal: 7, unknownUnits: 3 },
    inputTokens: { knownTotal: 110, unknownUnits: 3 },
    outputTokens: { knownTotal: 26, unknownUnits: 3 },
    unknownCostUnits: 10,
  });
  for (const snapshot of prepared.bundle.tasks) {
    expect(
      adaptiveTask(frozen, snapshot.caseId, { ...snapshot.task, expectedChoice: "PRIVATE" }),
    ).toEqual(snapshot.task);
  }
  const registered = h.app.adaptive.register(frozen, bound.observations);
  expect(h.app.adaptive.report(registered.id).reserved).toMatchObject({
    modelCalls: 7,
    inputTokens: 4030,
    outputTokens: 1030,
  });
  expect(h.app.adaptive.report(registered.id).report).toMatchObject({
    formalEvaluation: "not_run",
    benefit: "not_evaluated",
    evidenceVerification: "unverified-host-receipts",
  });
  expect(h.app.evolution.validationSet(h.input.validationSetId).usageCount).toBe(0);
  expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(before);
  expect(h.backend.requests).toHaveLength(4);
});

it("绑定拒绝省略执行或搜索开销、降低预留、换 family/任务/策略及冻结组件", async () => {
  const h = await fixture();
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  const original = manifest(prepared);
  const changed = (mutate: (plan: typeof original.plan) => void) => {
    const plan = structuredClone(original.plan);
    mutate(plan);
    return freezeAdaptivePlan(plan);
  };
  for (const prefix of ["compile-trial:", "compile-execution:"]) {
    const frozen = changed((plan) => {
      plan.development = plan.development.filter((unit) => !unit.id.startsWith(prefix));
    });
    expect(() => bindCompileDevelopment(h.deps, h.job.id, frozen)).toThrow("遗漏/追加");
  }
  expect(() =>
    bindCompileDevelopment(
      h.deps,
      h.job.id,
      changed((p) => {
        p.development[0]!.allowance.inputTokens--;
      }),
    ),
  ).toThrow("预留不足");
  expect(() =>
    bindCompileDevelopment(
      h.deps,
      h.job.id,
      changed((p) => {
        p.cases[0]!.taskDigest = digestOf("other-input");
      }),
    ),
  ).toThrow("开发 case");
  expect(() =>
    bindCompileDevelopment(
      h.deps,
      h.job.id,
      changed((p) => {
        p.cases[0]!.familyId = "another-family";
      }),
    ),
  ).toThrow("开发 case");
  expect(() =>
    bindCompileDevelopment(
      h.deps,
      h.job.id,
      changed((p) => {
        p.policies.candidateDigest = digestOf("other-policy");
      }),
    ),
  ).toThrow("冻结策略");
  expect(() =>
    bindCompileDevelopment(
      h.deps,
      h.job.id,
      changed((p) => {
        p.fixed.instructionDigest = digestOf("other-prompt");
      }),
    ),
  ).toThrow("冻结组件");
  expect(() =>
    bindCompileDevelopment(
      h.deps,
      h.job.id,
      changed((p) => {
        p.developmentClosedAt = prepared.record.createdAt - 1;
      }),
    ),
  ).toThrow("晚于开发截止点");
});

it("冻结后的资料包不可替换；删除输入及工作区后，跨连接/重启仍复用原包并核对账本", async () => {
  const h = await fixture();
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  const frozen = manifest(prepared);
  const bound = bindCompileDevelopment(h.deps, h.job.id, frozen);
  rmSync(h.dataset, { recursive: true });
  rmSync(join(h.app.root, "workspaces"), { recursive: true, force: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  const deps = { ...reopened, organismId: "organism-default", actorId: "principal-local" };
  expect(prepareCompileDevelopment(deps, h.job.id)).toEqual(prepared);
  expect(bindCompileDevelopment(deps, h.job.id, frozen)).toEqual(bound);
  const path = join(h.app.root, "blobs", prepared.record.ref);
  writeFileSync(path, "{}");
  expect(() => prepareCompileDevelopment(deps, h.job.id)).toThrow("开发证据包摘要漂移");
});

it("首次冻结前输入或裁判资料变化会拒绝；恢复原资料后才可生成原始投影", async () => {
  const h = await fixture();
  const input = join(h.dataset, "bundles", "b01", "file-a.md");
  const original = readFileSync(input);
  writeFileSync(input, "changed after compilation");
  expect(() => prepareCompileDevelopment(h.deps, h.job.id)).toThrow("已漂移");
  expect(h.app.storage.compileDevelopmentBundle(h.job.id)).toBeUndefined();
  writeFileSync(input, original);
  const schema = join(h.dataset, "schemas", "stats-summary.schema.json");
  const originalSchema = readFileSync(schema);
  writeFileSync(schema, "{}");
  expect(() => prepareCompileDevelopment(h.deps, h.job.id)).toThrow("已漂移");
  writeFileSync(schema, originalSchema);
  expect(prepareCompileDevelopment(h.deps, h.job.id).bundle.tasks).toHaveLength(3);
});

it("符号链接即使指向相同内容也不能进入任务胶囊，且未通过时不留已注册资料包", async () => {
  const h = await fixture();
  const input = join(h.dataset, "bundles", "b01", "file-a.md");
  const target = join(h.dataset, "same-content.md");
  cpSync(input, target);
  rmSync(input);
  symlinkSync(target, input);
  expect(() => prepareCompileDevelopment(h.deps, h.job.id)).toThrow("符号链接");
  expect(h.app.storage.compileDevelopmentBundle(h.job.id)).toBeUndefined();
});

it("后端仅声明 real 不能把未知来源模式和执行器边界升级为可运行真实轮", async () => {
  const h = await fixture("real"); // 仍为无网络 fake，只验证声明不足以通过预检。
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  const plan = manifest(prepared).plan;
  plan.mode = "real";
  plan.cases = [
    ...prepared.bundle.cases,
    ...["train", "search", "formal", "regression"].flatMap((split) =>
      Array.from(
        { length: split === "formal" ? 40 : split === "regression" ? 10 : 20 },
        (_, i) => ({
          id: `extra-${split}-${i}`,
          familyId: `extra-family-${split}-${i}`,
          split: split as (typeof plan.cases)[number]["split"],
          taskDigest: digestOf(`extra-task-${split}-${i}`),
          evaluatorDigest: digestOf(`extra-evaluator-${split}-${i}`),
          critical: split === "regression",
        }),
      ),
    ),
  ];
  plan.budget = {
    modelCalls: 800,
    inputTokens: 1_638_400,
    outputTokens: 204_800,
    durationMs: 30_000_000,
    wallClockMs: 3_600_000,
    cost: null,
  };
  const frozen = freezeAdaptivePlan(plan);
  expect(() => bindCompileDevelopment(h.deps, h.job.id, frozen)).toThrow(
    "来源模式或执行器模型调用上界不可核验",
  );
  expect(h.app.evolution.validationSet(h.input.validationSetId).usageCount).toBe(0);
});

it("零改善可冻结完整开发成本，但不能用占位候选开始正式比较", async () => {
  const h = await fixture("fixture", false);
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  expect(prepared.bundle.candidateId).toBeNull();
  expect(prepared.bundle.observations).toHaveLength(10);
  expect(() => bindCompileDevelopment(h.deps, h.job.id, manifest(prepared))).toThrow(
    "没有获胜候选",
  );
  expect(h.backend.requests).toHaveLength(4);
  expect(h.app.evolution.validationSet(h.input.validationSetId).usageCount).toBe(0);
});

it("编译来源、开发收据和实验记录原子绑定；重启及普通幂等调用不会丢掉来源", async () => {
  const h = await fixture();
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  const frozen = manifest(prepared);
  const job = h.app.adaptive.registerCompiled(frozen, h.job.id);
  expect(job.compilationEvidence).toEqual({
    jobId: h.job.id,
    bundleDigest: prepared.record.digest,
    auditDigest: prepared.bundle.auditDigest,
  });
  expect(h.app.adaptive.report(job.id).report).toMatchObject({
    developmentVerification: "persisted-development-records",
    evidenceVerification: "unverified-host-receipts",
    formalEvaluation: "not_run",
    benefit: "not_evaluated",
  });
  expect(h.app.adaptive.registerCompiled(frozen, h.job.id)).toEqual(job);
  const bound = bindCompileDevelopment(h.deps, h.job.id, frozen);
  expect(h.app.adaptive.register(frozen, bound.observations)).toEqual(job);
  rmSync(h.dataset, { recursive: true });
  const other = openInstance(h.app.root);
  opened.push(other);
  expect(other.adaptive.report(job.id)).toEqual(h.app.adaptive.report(job.id));
  expect(other.adaptive.registerCompiled(frozen, h.job.id)).toEqual(job);
  const reserved = other.adaptive.prepare(job.id)!;
  expect(h.app.adaptive.prepare(job.id)).toEqual(reserved);
  expect(h.app.evolution.validationSet(h.input.validationSetId).usageCount).toBe(0);
});

it("普通宿主收据注册的实验不能原地升级为编译来源核验合同", async () => {
  const h = await fixture();
  const prepared = prepareCompileDevelopment(h.deps, h.job.id);
  const frozen = manifest(prepared);
  const bound = bindCompileDevelopment(h.deps, h.job.id, frozen);
  const job = h.app.adaptive.register(frozen, bound.observations);
  expect(() => h.app.adaptive.registerCompiled(frozen, h.job.id)).toThrow(
    "不得替换或升级开发来源合同",
  );
  expect(h.app.adaptive.job(job.id).compilationEvidence).toBeUndefined();
  expect(h.app.adaptive.report(job.id).report.developmentVerification).toBe(
    "unverified-host-receipts",
  );
});

it("实验插入后故障会回滚来源关联和收据引用，重试不会留孤立实验或领用正式集", async () => {
  const h = await fixture();
  const frozen = manifest(prepareCompileDevelopment(h.deps, h.job.id));
  const insert = h.app.storage.insertAdaptiveExperiment.bind(h.app.storage);
  const fault = vi
    .spyOn(h.app.storage, "insertAdaptiveExperiment")
    .mockImplementationOnce((record) => {
      insert(record);
      throw new Error("crash-before-registration-commit");
    });
  expect(() => h.app.adaptive.registerCompiled(frozen, h.job.id)).toThrow(
    "crash-before-registration-commit",
  );
  fault.mockRestore();
  expect(h.app.storage.adaptiveExperiments("organism-default")).toHaveLength(0);
  const job = h.app.adaptive.registerCompiled(frozen, h.job.id);
  expect(job.compilationEvidence?.jobId).toBe(h.job.id);
  expect(h.app.storage.adaptiveExperiments("organism-default")).toHaveLength(1);
  expect(h.app.evolution.validationSet(h.input.validationSetId).usageCount).toBe(0);
});

it("准备后来源漂移或缺少核验端口会阻止 start；封存未知结果不依赖来源仍可核验", async () => {
  const h = await fixture();
  const frozen = manifest(prepareCompileDevelopment(h.deps, h.job.id));
  const job = h.app.adaptive.registerCompiled(frozen, h.job.id);
  const reservation = h.app.adaptive.prepare(job.id)!;
  const original = h.app.storage.compileTrials(h.job.id)[0]!;
  h.app.storage.tx(() =>
    h.app.storage.updateCompileTrial({ ...original, correct: !original.correct }),
  );
  expect(() => h.app.adaptive.start(job.id, reservation.id)).toThrow("重算结果与评分");
  expect(h.app.storage.adaptiveReservations(job.id)[0]!.state).toBe("prepared");
  expect(() => h.app.adaptive.report(job.id)).toThrow("重算结果与评分");
  h.app.storage.tx(() => h.app.storage.updateCompileTrial(original));
  const noPort = new AdaptiveJournal({
    ...h.app,
    clock: { now: Date.now },
    ids: { next: randomUUID },
    organismId: "organism-default",
    actorId: "principal-local",
  });
  expect(() => noPort.start(job.id, reservation.id)).toThrow("未装配");
  h.app.adaptive.start(job.id, reservation.id);
  h.app.storage.tx(() =>
    h.app.storage.updateCompileTrial({ ...original, correct: !original.correct }),
  );
  expect(noPort.cancel(job.id).state).toBe("cancelled");
  expect(h.app.storage.adaptiveReservations(job.id)[0]!.state).toBe("unknown");
  h.app.storage.tx(() => h.app.storage.updateCompileTrial(original));
  expect(h.app.adaptive.report(job.id).report.open).toEqual([reservation.unit.id]);
  expect(h.backend.requests).toHaveLength(4);
});

it("来源核验结束到 start 提交之间撤销团队读取权，也不能取得派发许可", async () => {
  const h = await fixture("fixture", true, true);
  const frozen = manifest(prepareCompileDevelopment(h.deps, h.job.id));
  const job = h.app.adaptive.registerCompiled(frozen, h.job.id);
  const reservation = h.app.adaptive.prepare(job.id)!;
  h.app.storage.tx(() => {
    h.app.kernel.createPrincipal("principal-reader", "user");
    for (const action of ["operate", "read"] as const)
      h.app.kernel.grantAccess(
        "organism:organism-default",
        "principal-reader",
        action,
        "principal-local",
      );
    h.app.kernel.grantAccess(
      "team:compiler-sources",
      "principal-reader",
      "read",
      "principal-local",
    );
  });
  const reader = openInstance(h.app.root, { actorId: "principal-reader" });
  opened.push(reader);
  const journal = new AdaptiveJournal({
    ...reader,
    clock: { now: Date.now },
    ids: { next: randomUUID },
    organismId: "organism-default",
    actorId: "principal-reader",
    bindCompilation: (id, plan) => {
      const bound = bindCompileDevelopment(
        { ...reader, organismId: "organism-default", actorId: "principal-reader" },
        id,
        plan,
      );
      h.app.storage.tx(() =>
        h.app.kernel.revokeAccess(
          "team:compiler-sources",
          "principal-reader",
          "read",
          "principal-local",
        ),
      );
      return bound;
    },
  });
  expect(() => journal.start(job.id, reservation.id)).toThrow("read 权限");
  expect(h.app.storage.adaptiveReservations(job.id)[0]!.state).toBe("prepared");
  expect(h.backend.requests).toHaveLength(4);
});

it("任务声明的私有裁判路径不能因位于输入树中而进入任务内容包", async () => {
  const h = await fixture();
  const source = h.app.storage.getRun(h.sourceRuns[0]!)!;
  const task = h.app.storage.getTask(source.taskId)!;
  linkSync(task.acceptance.outputSchema, join(h.dataset, "bundles", "b01", "private-schema.json"));
  expect(() => prepareCompileDevelopment(h.deps, h.job.id)).toThrow(
    "裁判或期望输出文件不能进入任务输入投影",
  );
  expect(h.app.storage.compileDevelopmentBundle(h.job.id)).toBeUndefined();
});
