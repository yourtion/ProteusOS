import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { freezeAdaptivePlan } from "../../src/app/experiment/adaptive.ts";
import { armHarness } from "../fixtures/adaptive-behavior/arm-harness.ts";
import { rehearsalObservations } from "../fixtures/adaptive-behavior/rehearsal.ts";

const opened: AppInstance[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of opened.splice(0)) app.close();
});

function fixture(
  arm: "single" | "budget-matched" = "single",
  bad: Parameters<typeof armHarness>[0] = false,
  register = true,
) {
  const h = armHarness(bad);
  opened.push(h.app);
  const input = h.input(arm, []);
  const plan = structuredClone(input.frozen.plan);
  plan.seed = arm === "single" ? 0 : 1;
  const frozen = freezeAdaptivePlan(plan);
  const development = rehearsalObservations(frozen)
    .filter((r) => r.unitId.startsWith("development-"))
    .map((r) => ({
      ...r,
      startedAt: frozen.plan.frozenAt - 100,
      endedAt: frozen.plan.frozenAt - 50,
    }));
  const job = h.app.adaptive.register(frozen, development);
  const labels = {
    version: "adaptive-judgments-v1",
    manifestDigest: frozen.digest,
    sourceRef: "PRIVATE_ROUTE_GOLD",
    cases: frozen.plan.cases
      .filter((c) => c.split === "formal" || c.split === "regression")
      .map((c) => ({
        caseId: c.id,
        taskDigest: c.taskDigest,
        evaluatorDigest: c.evaluatorDigest,
        expectedChoice: "local-process",
      })),
  };
  if (register) h.app.adaptiveRuns.registerJudgments(job.id, labels);
  const prepared = h.app.adaptive.prepare(job.id)!;
  const runPlan = {
    task: input.task,
    snapshots: input.snapshots,
    backend: input.backend,
    submission: h.submission,
  };
  const run = () => h.app.adaptiveRuns.runNext(job.id, () => runPlan);
  const observation = () => h.app.adaptive.report(job.id).observations.at(-1)!;
  return { ...h, frozen, job, labels, prepared, runPlan, run, observation };
}

it("标签冻结完整覆盖正式/回归，拒绝重写、遗漏、换摘要和事后升级", () => {
  const h = fixture("single", false, false);
  expect(() =>
    h.app.adaptiveRuns.registerJudgments(h.job.id, { ...h.labels, cases: h.labels.cases.slice(1) }),
  ).toThrow("完整覆盖");
  const wrong = structuredClone(h.labels);
  wrong.cases[0]!.taskDigest = "0".repeat(64);
  expect(() => h.app.adaptiveRuns.registerJudgments(h.job.id, wrong)).toThrow("摘要漂移");
  const first = h.app.adaptiveRuns.registerJudgments(h.job.id, h.labels);
  expect(h.app.adaptiveRuns.registerJudgments(h.job.id, h.labels)).toEqual(first);
  const changed = structuredClone(h.labels);
  changed.cases[0]!.expectedChoice = "capability/changed-file-summary";
  expect(() => h.app.adaptiveRuns.registerJudgments(h.job.id, changed)).toThrow("不得替换");
  const old = fixture("single", false, false);
  old.app.adaptiveRuns.bind(old.job.id, old.prepared.id, old.runPlan);
  expect(() => old.app.adaptiveRuns.registerJudgments(old.job.id, old.labels)).toThrow(
    "计划绑定前",
  );
});

it("原始 Run 自动推导 accepted、误派和开销，不允许再导入宿主成绩", async () => {
  const h = fixture();
  const completed = await h.run();
  expect(completed!.runReceipt).toBeDefined();
  expect(h.observation()).toMatchObject({
    accepted: true,
    decision: "value",
    misrouted: false,
    source: "fixture",
    usage: { modelCalls: null },
  });
  expect(() => h.app.adaptive.complete(h.job.id, h.prepared.id, h.observation())).toThrow(
    "不能导入宿主成绩",
  );
  const report = h.app.adaptive.report(h.job.id);
  expect(report.evidence!.runtimeResources.modelCalls).toEqual({ knownTotal: 1, unknownItems: 1 });
  expect(report.evidence!.runtimeResources.inputTokens).toEqual({
    knownTotal: 10,
    unknownItems: 1,
  });
  expect(report.report.evidenceVerification).toBe("partial-persisted-runtime-records");
  expect(JSON.stringify(h.provider.requests)).not.toMatch(
    /PRIVATE_ROUTE_GOLD|adaptive-judgments|expectedChoice/,
  );
});

it.each(["capability/changed-file-summary", "abstain", "refusal", "invalid", "transport"] as const)(
  "%s 保留可核验负结果及原分类，不重试或伪造通过",
  async (script) => {
    const h = fixture();
    h.provider.scripts.push(script);
    await h.run();
    expect(h.observation()).toMatchObject({
      accepted: false,
      misrouted: script === "capability/changed-file-summary",
    });
    expect(h.provider.requests).toHaveLength(1);
    expect(h.app.storage.adaptiveReservations(h.job.id)[0]!.runReceipt).toBeDefined();
  },
);

it("首个同选项产物验收失败不能换成后两个通过的产物，全部六个计量项保留", async () => {
  const h = fixture("budget-matched", true);
  await h.run();
  expect(h.observation()).toMatchObject({ accepted: false, misrouted: false });
  const report = h.app.adaptive.report(h.job.id);
  expect(report.evidence!.runtimeResources).toMatchObject({
    items: 6,
    modelCalls: { knownTotal: 3, unknownItems: 3 },
    inputTokens: { knownTotal: 30, unknownItems: 3 },
  });
  expect(h.provider.requests).toHaveLength(3);
});

it("worker 失败形成负收据；验收正文采集失败则保留 unknown 并停止", async () => {
  const failed = fixture("single", "execution-failure");
  await failed.run();
  expect(failed.observation()).toMatchObject({
    state: "failed",
    accepted: false,
    decision: "value",
    misrouted: false,
  });
  const h = fixture();
  const write = h.app.blobs.write.bind(h.app.blobs);
  vi.spyOn(h.app.blobs, "write").mockImplementation((raw) => {
    if (raw.includes('"version":"json-verification-evidence-v1"')) throw new Error("disk full");
    return write(raw);
  });
  await h.run();
  expect(h.observation()).toMatchObject({ state: "unknown", accepted: null, decision: "unknown" });
  expect(h.app.adaptive.job(h.job.id).state).toBe("failed");
  expect(h.app.adaptive.prepare(h.job.id)).toBeNull();
  expect(h.provider.requests).toHaveLength(1);
});

it("结案事务失败回滚观察、证据和状态；重读原 Run 结案幂等，不重新执行", async () => {
  const h = fixture();
  h.app.adaptiveRuns.bind(h.job.id, h.prepared.id, h.runPlan);
  h.app.adaptive.start(h.job.id, h.prepared.id);
  const run = h.app.adaptiveRuns.admit(h.job.id, h.prepared.id, 0);
  await h.app.runtime.executeRun(run.runId);
  const update = h.app.storage.updateAdaptiveReservation.bind(h.app.storage);
  const fail = vi.spyOn(h.app.storage, "updateAdaptiveReservation").mockImplementation((record) => {
    update(record);
    if (record.runReceipt) throw new Error("crash-receipt-commit");
  });
  expect(() => h.app.adaptive.completeFromRuns(h.job.id, h.prepared.id)).toThrow(
    "crash-receipt-commit",
  );
  expect(h.app.storage.adaptiveReservations(h.job.id)[0]).toMatchObject({
    state: "started",
    observationRef: null,
  });
  expect(h.app.storage.adaptiveReservations(h.job.id)[0]!.runReceipt).toBeUndefined();
  fail.mockRestore();
  const first = h.app.adaptive.completeFromRuns(h.job.id, h.prepared.id);
  expect(h.app.adaptive.completeFromRuns(h.job.id, h.prepared.id)).toEqual(first);
  const other = openInstance(h.app.root);
  opened.push(other);
  expect(other.adaptive.completeFromRuns(h.job.id, h.prepared.id)).toEqual(first);
  expect(h.provider.requests).toHaveLength(1);
});

it("运行器领取后发生不可恢复错误即封存 unknown，重开不发送第二次", async () => {
  const h = fixture();
  vi.spyOn(h.app.runtime, "executeRun").mockRejectedValue(
    new Error("host crashed after admission"),
  );
  await expect(h.run()).rejects.toThrow("host crashed");
  const report = h.app.adaptive.report(h.job.id);
  expect(report.job.state).toBe("failed");
  expect(report.observations.at(-1)).toMatchObject({ state: "unknown", accepted: false });
  expect(report.observations.at(-1)!.evidenceRefs.some((r) => r.startsWith("run:"))).toBe(true);
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(await reopened.adaptiveRuns.runNext(h.job.id, () => h.runPlan)).toBeNull();
  expect(h.provider.requests).toHaveLength(0);
});

it("清理工作区后从原记录重算，已提交收据被改写不能静默修复", async () => {
  const h = fixture();
  await h.run();
  const before = h.app.adaptive.report(h.job.id);
  rmSync(h.dir, { recursive: true });
  rmSync(join(h.app.root, "workspaces"), { recursive: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(reopened.adaptive.report(h.job.id)).toEqual(before);
  const receipt = before.reservations[0]!.runReceipt!;
  const path = join(h.app.root, "blobs", receipt.ref);
  const raw = readFileSync(path, "utf8");
  writeFileSync(path, `${raw} `);
  expect(() => reopened.adaptive.report(h.job.id)).toThrow("收据摘要漂移");
  expect(h.provider.requests).toHaveLength(1);
});
