import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { freezeAdaptivePlan, type AdaptiveObservation } from "../../src/app/experiment/adaptive.ts";
import { armHarness } from "../fixtures/adaptive-behavior/arm-harness.ts";
import { rehearsalObservations } from "../fixtures/adaptive-behavior/rehearsal.ts";

const opened: AppInstance[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of opened.splice(0)) app.close();
});

function fixture(arm: "single" | "budget-matched" | "compiled" = "single") {
  const h = armHarness();
  opened.push(h.app);
  const input = h.input(arm, []);
  const plan = structuredClone(input.frozen.plan);
  plan.seed = arm === "single" ? 0 : arm === "budget-matched" ? 1 : 2;
  const frozen = freezeAdaptivePlan(plan);
  const development = rehearsalObservations(frozen)
    .filter((r) => r.unitId.startsWith("development-"))
    .map((row) => ({
      ...row,
      startedAt: frozen.plan.frozenAt - 100,
      endedAt: frozen.plan.frozenAt - 50,
    }));
  const job = h.app.adaptive.register(frozen, development);
  const prepared = h.app.adaptive.prepare(job.id)!;
  expect(prepared.unit.arm).toBe(arm);
  const runPlan = {
    task: input.task,
    snapshots: input.snapshots,
    backend: input.backend,
    submission: h.submission,
  };
  const bind = () => h.app.adaptiveRuns.bind(job.id, prepared.id, runPlan);
  const start = () => h.app.adaptive.start(job.id, prepared.id);
  const admit = (ordinal = 0) => h.app.adaptiveRuns.admit(job.id, prepared.id, ordinal);
  const audit = () => h.app.adaptiveRuns.audit(job.id, prepared.id);
  const receipt = (): AdaptiveObservation => ({
    unitId: prepared.unit.id,
    manifestDigest: frozen.digest,
    source: "fixture",
    startedAt: h.app.storage.adaptiveReservations(job.id)[0]!.startedAt!,
    endedAt: Date.now(),
    state: "succeeded",
    accepted: true,
    decision: "value",
    misrouted: false,
    evidenceRefs: h.app.storage.adaptiveRunSlots(prepared.id).flatMap((slot) => [
      `run:${slot.runId}`,
      ...h.app.storage.listDecisionCalls(slot.runId!).map((c) => `decision:${c.id}`),
      ...h.app.storage
        .listProcesses(slot.runId!)
        .flatMap((p) => h.app.storage.listAttempts(p.id))
        .map((a) => `attempt:${a.id}`),
    ]),
    usage: {
      modelCalls: null,
      inputTokens: null,
      outputTokens: null,
      costAmount: null,
      costCurrency: null,
      priceRef: null,
    },
  });
  return { ...h, frozen, job, prepared, runPlan, bind, start, admit, audit, receipt };
}

it.each(["single", "budget-matched", "compiled"] as const)(
  "%s 槽位在派发前冻结，准入与 Run 原子绑定，完整执行后顺序可复算",
  async (arm) => {
    const h = fixture(arm);
    const before = h.app.kernel.getOrganism("organism-default")!.activeGenomeId;
    const slots = h.bind();
    expect(h.bind()).toEqual(slots);
    const started = h.start();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit().status).toBe("incomplete");
    for (const slot of slots) {
      const admitted = h.admit(slot.ordinal);
      expect(admitted.state).toBe("pending");
      expect(h.admit(slot.ordinal)).toEqual(admitted);
      expect(h.app.storage.getRun(admitted.runId)!.deadlineAt).toBeLessThanOrEqual(
        started.deadlineAt!,
      );
      expect(h.app.storage.getRun(admitted.runId)!.experimentId).toBe(h.job.id);
      const run = await h.app.runtime.executeRun(admitted.runId);
      expect(run.state).toBe("succeeded");
    }
    const proof = h.audit();
    expect(proof).toMatchObject({
      status: "verified",
      registrationVerification: "persisted-admission-bindings",
      orderVerification: "persisted-single-start-order",
      formalEvaluation: "not_run",
      arm: { selectedAcceptance: true },
    });
    expect(proof.slots.every((s) => s.state === "started")).toBe(true);
    expect(h.provider.requests).toHaveLength(slots.length);
    h.app.adaptive.complete(h.job.id, h.prepared.id, h.receipt());
    expect(h.app.adaptive.report(h.job.id).report.evidenceVerification).toBe(
      "unverified-host-receipts",
    );
    expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(before);
  },
);

it("槽位绑定事务中断整体回滚，不能留下部分槽位或升级旧 started 收据", () => {
  const h = fixture();
  const insert = h.app.storage.insertAdaptiveRunSlot.bind(h.app.storage);
  const fail = vi.spyOn(h.app.storage, "insertAdaptiveRunSlot").mockImplementation((slot) => {
    insert(slot);
    throw new Error("crash-after-slot-insert");
  });
  expect(h.bind).toThrow("crash-after-slot-insert");
  expect(h.app.storage.adaptiveRunSlots(h.prepared.id)).toEqual([]);
  expect(h.app.storage.adaptiveReservations(h.job.id)[0]!.runPlan).toBeUndefined();
  fail.mockRestore();
  h.start();
  expect(h.bind).toThrow("prepared");
  expect(h.app.storage.adaptiveRunSlots(h.prepared.id)).toEqual([]);
});

it("相同毫秒内的三次准入和启动仍以持久化事件序号证明顺序", async () => {
  const h = fixture("budget-matched");
  h.bind();
  const started = h.start();
  vi.spyOn(Date, "now").mockReturnValue(started.startedAt! + 1);
  for (let ordinal = 0; ordinal < 3; ordinal++)
    await h.app.runtime.executeRun(h.admit(ordinal).runId);
  const proof = h.audit();
  expect(new Set(proof.slots.map((s) => s.admittedAt)).size).toBe(1);
  expect(proof).toMatchObject({
    status: "verified",
    orderVerification: "persisted-single-start-order",
  });
});

it("即使 Run 已终态，未知调用不能借宿主成功收据进入下一单元", async () => {
  const h = fixture();
  h.bind();
  h.start();
  const run = h.admit();
  await h.app.runtime.executeRun(run.runId);
  const calls = h.app.storage.listDecisionCalls.bind(h.app.storage);
  vi.spyOn(h.app.storage, "listDecisionCalls").mockImplementation((id) =>
    calls(id).map((call) => ({ ...call, state: "unknown" })),
  );
  expect(() => h.app.adaptive.complete(h.job.id, h.prepared.id, h.receipt())).toThrow(
    "尚未全部结案",
  );
  expect(() => h.app.adaptive.prepare(h.job.id)).toThrow("已有执行中的");
});

it("准入末尾崩溃时 Task、Run、预算及绑定一起回滚；重复准入只返回原 Run", () => {
  const h = fixture();
  h.bind();
  h.start();
  const runs = h.app.storage.listRuns(100).length;
  const budget = h.app.storage.inFlightBudget("organism-default", "evaluation");
  const update = h.app.storage.updateAdaptiveRunSlot.bind(h.app.storage);
  const fail = vi.spyOn(h.app.storage, "updateAdaptiveRunSlot").mockImplementation((slot) => {
    update(slot);
    if (slot.state === "admitted") throw new Error("crash-after-admission");
  });
  expect(h.admit).toThrow("crash-after-admission");
  expect(h.app.storage.listRuns(100)).toHaveLength(runs);
  expect(h.app.storage.inFlightBudget("organism-default", "evaluation")).toEqual(budget);
  expect(h.app.storage.adaptiveRunSlots(h.prepared.id)[0]!.runId).toBeNull();
  fail.mockRestore();
  const first = h.admit();
  expect(h.admit().runId).toBe(first.runId);
  expect(h.app.storage.listRuns(100)).toHaveLength(runs + 1);
  expect(h.app.storage.inFlightBudget("organism-default", "evaluation").attempts).toBe(
    budget.attempts + 1,
  );
  expect(h.provider.requests).toHaveLength(0);
});

it("两个数据库连接竞争同一槽位，最多准入一个 Run；输家回滚后重读原绑定", () => {
  const h = fixture();
  h.bind();
  h.start();
  const other = openInstance(h.app.root);
  opened.push(other);
  const admit = h.app.runtime.admitTask.bind(h.app.runtime);
  let winner: string | undefined;
  const race = vi.spyOn(h.app.runtime, "admitTask").mockImplementation((...args) => {
    winner = other.adaptiveRuns.admit(h.job.id, h.prepared.id, 0).runId;
    return admit(...args);
  });
  expect(h.admit).toThrow("已经准入");
  race.mockRestore();
  expect(h.admit().runId).toBe(winner);
  expect(h.app.storage.listRuns(100).filter((r) => r.experimentId === h.job.id)).toHaveLength(1);
  expect(h.app.storage.inFlightBudget("organism-default", "evaluation").attempts).toBe(1);
});

it("越序准入、并发领取与未完成槽位的宿主结案都被拒绝", async () => {
  const h = fixture("budget-matched");
  h.bind();
  h.start();
  expect(() => h.admit(1)).toThrow("前一槽位");
  const first = h.admit();
  expect(() => h.admit(1)).toThrow("前一槽位");
  expect(() => h.app.adaptive.complete(h.job.id, h.prepared.id, h.receipt())).toThrow(
    "尚未全部结案",
  );
  expect(() => h.app.adaptive.prepare(h.job.id)).toThrow("已有执行中的");
  await h.app.runtime.executeRun(first.runId);
  expect(h.admit(1).state).toBe("pending");
  expect(() => h.admit(2)).toThrow("前一槽位");
  expect(h.provider.requests).toHaveLength(1);
});

it("单次启动许可在调用前提交，两个执行入口不能发送同一 Run 两次", async () => {
  const h = fixture();
  h.bind();
  h.start();
  const run = h.admit();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const decide = h.provider.decide.bind(h.provider);
  vi.spyOn(h.provider, "decide").mockImplementation(async (request) => {
    entered();
    await gate;
    return decide(request);
  });
  const first = h.app.runtime.executeRun(run.runId);
  await started;
  await expect(h.app.runtime.executeRun(run.runId)).rejects.toThrow("启动许可已经消耗");
  release();
  expect((await first).state).toBe("succeeded");
  expect(h.provider.requests).toHaveLength(1);
  expect(h.app.runtime.getRunSummary(run.runId).attempts).toHaveLength(1);
});

it("领取启动许可后崩溃不重发；重启恢复封存 unknown 并保留 Run 引用", async () => {
  const h = fixture();
  h.bind();
  h.start();
  const run = h.admit();
  const update = h.app.storage.updateRunState.bind(h.app.storage);
  const fail = vi.spyOn(h.app.storage, "updateRunState").mockImplementation((...args) => {
    update(...args);
    if (args[1] === "running") throw new Error("crash-before-execution");
  });
  await expect(h.app.runtime.executeRun(run.runId)).rejects.toThrow("crash-before-execution");
  fail.mockRestore();
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  await expect(reopened.runtime.executeRun(run.runId)).rejects.toThrow("启动许可已经消耗");
  expect(reopened.adaptive.recover(h.job.id).state).toBe("failed");
  const report = reopened.adaptive.report(h.job.id);
  expect(report.observations.at(-1)).toMatchObject({
    state: "unknown",
    evidenceRefs: expect.arrayContaining([`run:${run.runId}`]),
  });
  expect(h.provider.requests).toHaveLength(0);
});

it("已注册实验不能绕过槽位准入，也不能在取消后启动已准入 Run", async () => {
  const h = fixture();
  h.bind();
  h.start();
  expect(() =>
    h.app.runtime.admitTask(h.submission, {
      purpose: "evaluation",
      snapshotId: h.runPlan.snapshots.base,
      experimentId: h.job.id,
    }),
  ).toThrow("必须在准入事务中绑定");
  const run = h.admit();
  h.app.adaptive.cancel(h.job.id);
  await expect(h.app.runtime.executeRun(run.runId)).rejects.toThrow("已封闭");
  expect(h.provider.requests).toHaveLength(0);
  expect(h.app.adaptive.report(h.job.id).observations.at(-1)!.evidenceRefs).toContain(
    `run:${run.runId}`,
  );
});

it("文件漂移在准入/启动前拦截；未消费启动许可时可恢复原内容后首次执行", async () => {
  const h = fixture();
  h.bind();
  h.start();
  const path = h.submission.inputs[0]!;
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("hello", "world"));
  expect(h.admit).toThrow("冻结输入/目标");
  expect(h.app.storage.adaptiveRunSlots(h.prepared.id)[0]!.runId).toBeNull();
  writeFileSync(path, original);
  const run = h.admit();
  writeFileSync(path, "another input");
  await expect(h.app.runtime.executeRun(run.runId)).rejects.toThrow("冻结输入/目标");
  expect(h.app.storage.adaptiveRunSlots(h.prepared.id)[0]!.state).toBe("admitted");
  writeFileSync(path, original);
  expect((await h.app.runtime.executeRun(run.runId)).state).toBe("succeeded");
  expect(h.provider.requests).toHaveLength(1);
});

it("权限、期限与绑定事件不可绕过；原文件清理后核验仍可重开复算", async () => {
  const h = fixture("compiled");
  h.bind();
  const started = h.start();
  const run = h.admit();
  const access = h.app.kernel.assertVersionAccess.bind(h.app.kernel);
  const revoked = vi.spyOn(h.app.kernel, "assertVersionAccess").mockImplementation((...args) => {
    if (args[0] === h.candidate.version.id) throw new Error("revoked");
    return access(...args);
  });
  await expect(h.app.runtime.executeRun(run.runId)).rejects.toThrow("revoked");
  revoked.mockRestore();
  const now = vi.spyOn(Date, "now").mockReturnValue(started.deadlineAt! + 1);
  await expect(h.app.runtime.executeRun(run.runId)).rejects.toThrow("过期");
  now.mockRestore();
  await h.app.runtime.executeRun(run.runId);
  const proof = h.audit();
  const event = h.app.storage.eventById.bind(h.app.storage);
  const tamper = vi.spyOn(h.app.storage, "eventById").mockImplementation((id) => {
    const e = event(id);
    return e ? { ...e, payload: { ...e.payload, ordinal: 9 } } : e;
  });
  expect(h.audit).toThrow("槽位事件合同");
  tamper.mockRestore();
  rmSync(h.dir, { recursive: true });
  rmSync(join(h.app.root, "workspaces"), { recursive: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(reopened.adaptiveRuns.audit(h.job.id, h.prepared.id)).toEqual(proof);
  expect(h.provider.requests).toHaveLength(1);
});
