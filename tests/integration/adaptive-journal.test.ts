import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openInstance } from "../../src/app/instance.ts";
import { AdaptiveJournal } from "../../src/app/experiment/journal.ts";
import { freezeAdaptivePlan, type AdaptiveObservation } from "../../src/app/experiment/adaptive.ts";
import type { AdaptiveReservationRecord } from "../../src/app/experiment/journal-types.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { bootSeededInstance } from "../helpers.ts";
import { rehearsalObservations, rehearsalPlan } from "../fixtures/adaptive-behavior/rehearsal.ts";

function harness() {
  let inst = bootSeededInstance();
  const clock = { value: 200, now: () => clock.value };
  const makeJournal = () =>
    new AdaptiveJournal({
      ...inst,
      clock,
      ids: { next: randomUUID },
      organismId: "organism-default",
      actorId: "principal-local",
    });
  let journal = makeJournal();
  const frozen = rehearsalPlan();
  const development = rehearsalObservations(frozen).filter((row) =>
    row.unitId.startsWith("development-"),
  );
  return {
    get inst() {
      return inst;
    },
    get journal() {
      return journal;
    },
    clock,
    frozen,
    development,
    register: () => journal.register(frozen, development),
    reopen() {
      const root = inst.root;
      inst.close();
      inst = openInstance(root);
      journal = makeJournal();
    },
    receipt(
      started: AdaptiveReservationRecord,
      changes: Partial<AdaptiveObservation> = {},
    ): AdaptiveObservation {
      clock.value += 5;
      const original = rehearsalObservations(frozen).find((row) => row.unitId === started.unit.id)!;
      return {
        ...original,
        startedAt: started.startedAt!,
        endedAt: clock.value,
        ...changes,
      };
    },
    close: () => inst.close(),
  };
}

describe("持久化适应实验派发账本", () => {
  it("完整三臂轮次可重启后只读复算；预留不因实际少用而退还，fixture 不产生真实收益", () => {
    const h = harness();
    try {
      const active = h.inst.kernel.getOrganism("organism-default")!.activeGenomeId;
      const job = h.register();
      let prepared;
      while ((prepared = h.journal.prepare(job.id))) {
        const started = h.journal.start(job.id, prepared.id);
        expect(started.deadlineAt).toBe(
          Math.min(job.deadlineAt, started.startedAt! + started.unit.allowance.durationMs),
        );
        const receipt = h.receipt(started);
        h.journal.complete(job.id, started.id, receipt);
        expect(h.journal.complete(job.id, started.id, receipt)).toMatchObject({
          state: "completed",
        });
      }
      const report = h.journal.report(job.id);
      expect(report.job.state).toBe("completed");
      expect(report.reservations).toHaveLength(36);
      expect(report.observations).toHaveLength(40);
      expect(report.reserved).toMatchObject({
        modelCalls: 64,
        inputTokens: 131072,
        outputTokens: 16384,
      });
      expect(report.report).toMatchObject({
        engineering: "passed",
        realModel: "not_run",
        benefit: "not_evaluated",
        evidenceVerification: "unverified-host-receipts",
        formalEvaluation: "not_run",
      });
      expect(report.report.resources.inputTokens.knownTotal).toBe(640);
      expect(h.inst.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(active);
      h.reopen();
      expect(h.journal.report(job.id)).toEqual(report);
      expect(h.journal.prepare(job.id)).toBeNull();
      expect(h.register().id).toBe(job.id);
    } finally {
      h.close();
    }
  });

  it("注册固定清单与全部开发收据，拒绝换收据、预填正式成绩、未来时间和不可执行费用上限", () => {
    const h = harness();
    try {
      const job = h.register();
      expect(h.journal.register(h.frozen, [...h.development].reverse()).id).toBe(job.id);
      const changed = structuredClone(h.development);
      changed[0]!.usage.inputTokens = 11;
      expect(() => h.journal.register(h.frozen, changed)).toThrow("不得替换");
      expect(() => h.journal.register(h.frozen, h.development.slice(1))).toThrow("完整固定");
      expect(() => h.journal.register(h.frozen, rehearsalObservations())).toThrow("不能预填");
      const wrongDigest = { ...h.frozen, digest: digestOf("wrong") };
      expect(() => h.journal.register(wrongDigest, h.development)).toThrow("摘要漂移");
      const priced = structuredClone(h.frozen.plan);
      priced.budget.cost = { currency: "USD", maxAmount: 1 };
      expect(() => h.journal.register(freezeAdaptivePlan(priced), [])).toThrow("货币硬上限");
      const future = structuredClone(h.frozen.plan);
      future.frozenAt++;
      const frozen = freezeAdaptivePlan(future);
      const rows = h.development.map((row) => ({ ...row, manifestDigest: frozen.digest }));
      expect(() => h.journal.register(frozen, rows)).toThrow("未来");
      const duplicate = structuredClone(h.development);
      duplicate[1]!.evidenceRefs = duplicate[0]!.evidenceRefs;
      expect(() => h.journal.register(h.frozen, duplicate)).toThrow("重复计量");
    } finally {
      h.close();
    }
  });

  it("两个 SQLite 连接共享原预留，只有一次 start 可以提交；下一单元不能与它重叠", () => {
    const h = harness();
    const other = openInstance(h.inst.root);
    const otherJournal = new AdaptiveJournal({
      ...other,
      clock: h.clock,
      ids: { next: randomUUID },
      organismId: "organism-default",
      actorId: "principal-local",
    });
    try {
      const job = h.register();
      const prepared = h.journal.prepare(job.id)!;
      expect(otherJournal.prepare(job.id)).toEqual(prepared);
      const started = otherJournal.start(job.id, prepared.id);
      expect(() => h.journal.start(job.id, prepared.id)).toThrow("禁止重发");
      expect(() => h.journal.prepare(job.id)).toThrow("不能并行");
      otherJournal.complete(job.id, started.id, h.receipt(started));
      const second = h.journal.prepare(job.id)!;
      expect(second.ordinal).toBe(1);
      expect(otherJournal.prepare(job.id)).toEqual(second);
    } finally {
      other.close();
      h.close();
    }
  });

  it("prepared 崩溃可以沿原 ID/预留恢复；started 崩溃保留 unknown，拒绝补跑和迟到覆盖", () => {
    const h = harness();
    try {
      const job = h.register();
      const prepared = h.journal.prepare(job.id)!;
      const reserved = h.journal.report(job.id).reserved;
      h.reopen();
      expect(h.journal.recover(job.id).deadlineAt).toBe(job.deadlineAt);
      expect(h.journal.prepare(job.id)).toEqual(prepared);
      const started = h.journal.start(job.id, prepared.id);
      const late = h.receipt(started);
      h.reopen();
      expect(h.journal.recover(job.id)).toMatchObject({
        state: "failed",
        deadlineAt: job.deadlineAt,
      });
      const report = h.journal.report(job.id);
      expect(report.reservations[0]).toMatchObject({ id: prepared.id, state: "unknown" });
      expect(report.observations.at(-1)).toMatchObject({
        state: "unknown",
        usage: { modelCalls: null },
      });
      expect(report.reserved).toEqual(reserved);
      expect(h.journal.prepare(job.id)).toBeNull();
      expect(() => h.journal.start(job.id, prepared.id)).toThrow("禁止重发");
      expect(() => h.journal.complete(job.id, prepared.id, late)).toThrow("迟到");
      expect(h.journal.recover(job.id)).toEqual(h.journal.job(job.id));
    } finally {
      h.close();
    }
  });

  it("结果落盘后崩溃不会重派；结果/实验状态事务提交失败时整体回滚并保留 unknown", () => {
    const h = harness();
    try {
      const job = h.register();
      const first = h.journal.start(job.id, h.journal.prepare(job.id)!.id);
      h.journal.complete(job.id, first.id, h.receipt(first));
      h.reopen();
      h.journal.recover(job.id);
      const second = h.journal.start(job.id, h.journal.prepare(job.id)!.id);
      expect(second.ordinal).toBe(1);
      const before = h.journal.report(job.id);
      const fail = vi
        .spyOn(h.inst.storage, "updateAdaptiveExperiment")
        .mockImplementationOnce(() => {
          throw new Error("crash-before-commit");
        });
      expect(() => h.journal.complete(job.id, second.id, h.receipt(second))).toThrow(
        "crash-before-commit",
      );
      fail.mockRestore();
      expect(h.journal.report(job.id).observations).toEqual(before.observations);
      expect(h.journal.report(job.id).reservations[1]!.state).toBe("started");
      h.reopen();
      h.journal.recover(job.id);
      expect(h.journal.report(job.id).reservations.map((r) => r.state)).toEqual([
        "completed",
        "unknown",
      ]);
    } finally {
      h.close();
    }
  });

  it.each([false, true])("取消封闭账本，不返还预留；started=%s 的在途结果不能再覆盖", (send) => {
    const h = harness();
    try {
      const job = h.register();
      const prepared = h.journal.prepare(job.id)!;
      const reserved = h.journal.report(job.id).reserved;
      const started = send ? h.journal.start(job.id, prepared.id) : null;
      const late = started ? h.receipt(started) : null;
      expect(h.journal.cancel(job.id).state).toBe("cancelled");
      expect(h.journal.cancel(job.id).state).toBe("cancelled");
      expect(h.journal.report(job.id).reserved).toEqual(reserved);
      expect(h.journal.report(job.id).reservations[0]!.state).toBe(send ? "unknown" : "prepared");
      expect(h.journal.prepare(job.id)).toBeNull();
      if (late) expect(() => h.journal.complete(job.id, prepared.id, late)).toThrow("迟到");
      h.reopen();
      expect(h.journal.recover(job.id).state).toBe("cancelled");
    } finally {
      h.close();
    }
  });

  it("超额收据保留并立即停止后续派发，不以丢弃坏结果或重试来规避预算", () => {
    const h = harness();
    try {
      const job = h.register();
      const started = h.journal.start(job.id, h.journal.prepare(job.id)!.id);
      const receipt = h.receipt(started);
      receipt.usage.inputTokens = started.unit.allowance.inputTokens + 1;
      h.journal.complete(job.id, started.id, receipt);
      const report = h.journal.report(job.id);
      expect(report.job.state).toBe("failed");
      expect(report.report.problems.join()).toContain("超额 inputTokens");
      expect(report.observations.at(-1)).toEqual(receipt);
      expect(h.journal.prepare(job.id)).toBeNull();
      expect(h.journal.complete(job.id, started.id, receipt).state).toBe("completed");
      expect(() => h.journal.complete(job.id, started.id, { ...receipt, accepted: false })).toThrow(
        "不能替换",
      );
    } finally {
      h.close();
    }
  });

  it("单元自身的截止点可早于全轮期限；等待超时也不能重发", () => {
    const h = harness();
    try {
      const job = h.register();
      const started = h.journal.start(job.id, h.journal.prepare(job.id)!.id);
      expect(started.deadlineAt).toBeLessThan(job.deadlineAt);
      h.clock.value = started.deadlineAt!;
      expect(h.journal.prepare(job.id)).toBeNull();
      expect(h.journal.job(job.id)).toMatchObject({
        state: "failed",
        error: "执行单元截止点已到达",
      });
      expect(h.journal.report(job.id).reservations[0]!.state).toBe("unknown");
    } finally {
      h.close();
    }
  });

  it("请求时检查当前个体权限；不能读写另一主体或个体的实验", () => {
    const h = harness();
    try {
      const job = h.register();
      h.inst.storage.tx(() => h.inst.kernel.createPrincipal("principal-other", "user"));
      const other = new AdaptiveJournal({
        ...h.inst,
        clock: h.clock,
        ids: { next: randomUUID },
        organismId: "organism-default",
        actorId: "principal-other",
      });
      expect(() => other.report(job.id)).toThrow("无权");
      expect(() => other.prepare(job.id)).toThrow("无权");
      expect(() => other.cancel(job.id)).toThrow("无权");
      h.inst.storage.tx(() =>
        h.inst.kernel.grantAccess(
          "organism:organism-default",
          "principal-other",
          "operate",
          "principal-local",
        ),
      );
      const prepared = other.prepare(job.id)!;
      h.inst.storage.tx(() =>
        h.inst.kernel.revokeAccess(
          "organism:organism-default",
          "principal-other",
          "operate",
          "principal-local",
        ),
      );
      expect(() => other.start(job.id, prepared.id)).toThrow("无权");
      h.inst.storage.tx(() =>
        h.inst.kernel.createOrganism(
          "organism-other",
          "principal-other",
          "principal:principal-other",
        ),
      );
      const isolated = new AdaptiveJournal({
        ...h.inst,
        clock: h.clock,
        ids: { next: randomUUID },
        organismId: "organism-other",
        actorId: "principal-other",
      });
      expect(() => isolated.job(job.id)).toThrow("属于其他个体");
    } finally {
      h.close();
    }
  });

  it.each([false, true])("绝对期限含开发时间和空闲等待，重启不延长；started=%s", (send) => {
    const h = harness();
    try {
      const job = h.register();
      expect(job.startedAt).toBe(0);
      const prepared = h.journal.prepare(job.id)!;
      if (send) h.journal.start(job.id, prepared.id);
      h.clock.value = job.deadlineAt;
      h.reopen();
      h.journal.recover(job.id);
      expect(h.journal.job(job.id)).toMatchObject({ state: "failed", deadlineAt: job.deadlineAt });
      expect(h.journal.prepare(job.id)).toBeNull();
      expect(h.journal.report(job.id).reservations[0]!.state).toBe(send ? "unknown" : "prepared");
    } finally {
      h.close();
    }
  });

  it("冻结 blob 漂移、错误收据绑定和额外字段不能进入可派发证据", () => {
    const h = harness();
    try {
      const job = h.register();
      const started = h.journal.start(job.id, h.journal.prepare(job.id)!.id);
      const receipt = h.receipt(started);
      expect(() => h.journal.complete(job.id, started.id, { ...receipt, unitId: "other" })).toThrow(
        "不匹配",
      );
      expect(() =>
        h.journal.complete(job.id, started.id, { ...receipt, evaluatorSays: true }),
      ).toThrow();
      writeFileSync(join(h.inst.root, "blobs", job.manifestRef), canonicalJson({ bad: true }));
      expect(() => h.journal.report(job.id)).toThrow("摘要漂移");
      expect(() => h.journal.complete(job.id, started.id, receipt)).toThrow("摘要漂移");
    } finally {
      h.close();
    }
  });
});
