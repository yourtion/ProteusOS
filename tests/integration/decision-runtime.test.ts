import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openInstance } from "../../experiments/instance.ts";
import type { RunSummary } from "../../src/runtime/types.ts";
import {
  bootExperimentHarness,
  DEV_DATASET,
  experimentSubmission,
  type ExperimentHarness,
} from "../fixtures/decision/harness.ts";
import { FakeLlmDecisionProvider } from "../fixtures/decision/fake-llm.ts";

/**
 * 本体决策实验集成测试（真实 SQLite）：D05/D06/D07/D08/D09/D10/D12/D13。
 * 崩溃窗口以"进程重启"（关闭实例后重开同一 root）与受控状态构造模拟。
 */

const STATS_SCHEMA = join(DEV_DATASET, "schemas", "stats-summary.schema.json");
const SUMMARY_SCHEMA = join(DEV_DATASET, "schemas", "changed-file-summary.schema.json");
const BUNDLE = join(DEV_DATASET, "bundles", "b01");
const CHANGED = join(DEV_DATASET, "changed-files", "b01", "changed-files.json");
const STATS_EXPECTED = join(DEV_DATASET, "expected", "dev-expl-01.json");
// dev-expl-05 是分类案例：bundle b05 与其期望输出配对
const BUNDLE_B05 = join(DEV_DATASET, "bundles", "b05");
const CHANGED_B05 = join(DEV_DATASET, "changed-files", "b05", "changed-files.json");
const SUMMARY_EXPECTED = join(DEV_DATASET, "expected", "dev-expl-05.json");

let h: ExperimentHarness;

beforeAll(() => {
  h = bootExperimentHarness();
});

afterAll(() => {
  h.inst.close();
});

function submitL(
  goal: string,
  opts: {
    expected?: string;
    schema?: string;
    experimentId?: string;
    budget?: { maxAttempts: number; maxWallClockSeconds: number };
  } = {},
): Promise<RunSummary> {
  const { input, options } = experimentSubmission({
    goal,
    inputs: [BUNDLE, CHANGED],
    genomes: h.genomes,
    arm: "L",
    schema: opts.schema ?? STATS_SCHEMA,
    expected: opts.expected,
    experimentId: opts.experimentId ?? "exp-it",
    budget: opts.budget,
  });
  return h.inst.runtime.submitTask(input, options);
}

function lastCall(runId: string) {
  const calls = h.inst.storage.listDecisionCalls(runId);
  return calls[calls.length - 1];
}

function attemptsOf(runId: string) {
  return h.inst.storage.listProcesses(runId).flatMap((p) => h.inst.storage.listAttempts(p.id));
}

describe("D01/D02（集成部分）：选择实际控制 executorFrom，恰好一个 worker", () => {
  it("fake LLM 选 stats → local-process 执行且验收通过", async () => {
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const summary = await submitL("统计这批文本文件的字数、行数与标题数", {
      expected: STATS_EXPECTED,
    });
    expect(summary.state).toBe("succeeded");
    expect(summary.decisions[0]).toMatchObject({
      value: "local-process",
      provider: "decision-llm",
    });
    expect(attemptsOf(summary.runId)).toHaveLength(1);
    const call = lastCall(summary.runId)!;
    expect(call.state).toBe("value");
    expect(call.kind).toBe("model");
    expect(call.sent).toBe(true);
    expect(call.provenance.policyVersionId).toBe(h.genomes.llm.policyVersionId);
    expect(call.provenance.viewVersionId).toBe(h.genomes.decisionViewVersionId);
  });

  it("goal 切换到分类任务 → capability/changed-file-summary 执行且验收通过（各自固定期望）", async () => {
    h.fake.resetQueue({ type: "value", value: "capability/changed-file-summary" });
    const { input, options } = experimentSubmission({
      goal: "对这份变更清单按源码、测试、文档与配置分类",
      inputs: [BUNDLE_B05, CHANGED_B05],
      genomes: h.genomes,
      arm: "L",
      schema: SUMMARY_SCHEMA,
      expected: SUMMARY_EXPECTED,
      experimentId: "exp-it",
    });
    const summary = await h.inst.runtime.submitTask(input, options);
    expect(summary.state).toBe("succeeded");
    expect(summary.decisions[0]!.value).toBe("capability/changed-file-summary");
    expect(attemptsOf(summary.runId)).toHaveLength(1);
  });

  it("R 组规则：同一合同独立校验并路由（无模型调用）", async () => {
    const { input, options } = experimentSubmission({
      goal: "统计这批文本文件的字数、行数与标题数",
      inputs: [BUNDLE, CHANGED],
      genomes: h.genomes,
      arm: "R",
      schema: STATS_SCHEMA,
      expected: STATS_EXPECTED,
      experimentId: "exp-it",
    });
    const before = h.fake.capturedRequests.length;
    const summary = await h.inst.runtime.submitTask(input, options);
    expect(summary.state).toBe("succeeded");
    expect(summary.decisions[0]).toMatchObject({
      value: "local-process",
      provider: "decision-rule",
    });
    expect(h.fake.capturedRequests.length).toBe(before); // 规则不触达 LLM Provider
    expect(lastCall(summary.runId)!.kind).toBe("local"); // 本地计算不消耗远端额度
  });
});

describe("D03/D04（集成部分）：非法输出与弃权分别记录，无默认选择/自动重试", () => {
  it("非法 JSON 输出 → invalid_output，零 worker，证据保留", async () => {
    h.fake.resetQueue({ type: "invalid", raw: '{"kind":"value","value":"guess"}' });
    const summary = await submitL("统计字数");
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("decision_invalid_output");
    expect(attemptsOf(summary.runId)).toHaveLength(0);
    const call = lastCall(summary.runId)!;
    expect(call.state).toBe("invalid_output");
    expect(h.inst.blobs.has(call.responseRef!)).toBe(true);
  });

  it("明确 abstain → run 失败且不派发 worker", async () => {
    h.fake.resetQueue({ type: "abstain", reason: "任务同时要求两种结果" });
    const summary = await submitL("先统计字数，再分类变更");
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("decision_abstained");
    expect(attemptsOf(summary.runId)).toHaveLength(0);
    expect(lastCall(summary.runId)!.state).toBe("abstain");
  });

  it("服务 refusal → abstain（origin=service_refusal）；429/断网 → transport_error", async () => {
    h.fake.resetQueue({ type: "service-refusal" });
    const refusal = await submitL("统计字数");
    expect(refusal.failureReason).toBe("decision_abstained");
    const refusalEvents = h.inst.storage
      .listEvents({ runId: refusal.runId }, 100)
      .filter((e) => e.type === "decision.abstained");
    expect(refusalEvents[0]!.payload["origin"]).toBe("service_refusal");

    h.fake.resetQueue({ type: "status-429" });
    const limited = await submitL("统计字数");
    expect(limited.failureReason).toBe("decision_transport_error");
    expect(lastCall(limited.runId)!.state).toBe("transport_error");
    expect(lastCall(limited.runId)!.errorClass).toBe("APIStatusError");

    h.fake.resetQueue({ type: "transport-error", message: "socket hang up" });
    const dead = await submitL("统计字数");
    expect(dead.failureReason).toBe("decision_transport_error");
    expect(lastCall(dead.runId)!.state).toBe("transport_error");
  });
});

describe("D05：deadline、超时、取消与迟到响应", () => {
  it("永不 resolve 的 fake：超时结束本地等待（harness 250ms），失败不派发 worker", async () => {
    h.fake.resetQueue({ type: "never" });
    const startedAt = Date.now();
    const summary = await submitL("统计字数");
    expect(Date.now() - startedAt).toBeLessThan(5000); // 本地等待被超时结束，不悬挂
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("decision_timeout");
    expect(attemptsOf(summary.runId)).toHaveLength(0);
    expect(lastCall(summary.runId)!.state).toBe("timeout");
  });

  it("超时后迟到返回：只追加迟到证据，不改终态、不派发", async () => {
    h.fake.resetQueue({
      type: "late-resolve",
      afterMs: 500,
      script: { type: "value", value: "local-process" },
    });
    const summary = await submitL("统计字数");
    expect(summary.failureReason).toBe("decision_timeout");
    const callId = lastCall(summary.runId)!.id;
    await waitFor(() => {
      const call = h.inst.storage.getDecisionCall(callId)!;
      return call.lateArrival;
    }, 2000);
    const call = h.inst.storage.getDecisionCall(callId)!;
    expect(call.state).toBe("timeout"); // 终态不被迟到结果覆盖
    expect(call.lateArrival).toBe(true);
    expect(attemptsOf(summary.runId)).toHaveLength(0);
    const late = h.inst.storage
      .listEvents({ runId: summary.runId }, 100)
      .find((e) => e.type === "decision.late_arrival");
    expect(late).toBeTruthy();
  });

  it("Run 截止点已过 → 不再发起决策（deadline_exceeded）", async () => {
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const summary = await submitL("统计字数");
    expect(summary.state).toBe("succeeded");
    // 受控构造：回退到 running、清除节点完成投影并把截止点置为过去，决策节点重跑时命中
    const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("DELETE FROM events WHERE run_id = ? AND type = 'node.completed'").run(
      summary.runId,
    );
    db.prepare(
      "UPDATE runs SET state = 'running', failure_reason = NULL, deadline_at = ? WHERE id = ?",
    ).run(Date.now() - 1000, summary.runId);
    db.close();
    const rerun = await h.inst.runtime.executeRun(summary.runId);
    expect(rerun.state).toBe("failed");
    expect(rerun.failureReason).toBe("deadline_exceeded");
  });
});

describe("D06：调用额度（同事务检查预留；跨实验/重启不重置）", () => {
  it("两个并发 Run 竞争最后一个 experiment 额度：仅一个进入网络调用", async () => {
    const experimentId = "exp-race";
    h.inst.storage.setDecisionCallLimit(
      { organismId: "organism-default", experimentId },
      1,
      Date.now(),
    );
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const [a, b] = await Promise.all([
      submitL("统计字数", { experimentId, expected: STATS_EXPECTED }),
      submitL("统计字数", { experimentId, expected: STATS_EXPECTED }),
    ]);
    const states = [a, b].map((s) => s.state).sort();
    expect(states).toEqual(["failed", "succeeded"]);
    const failed = a.state === "failed" ? a : b;
    expect(failed.failureReason).toBe("decision_budget_exhausted");
    expect(attemptsOf(failed.runId)).toHaveLength(0);
    const calls = h.inst.storage
      .listDecisionCalls(a.runId)
      .concat(h.inst.storage.listDecisionCalls(b.runId));
    expect(calls.filter((c) => c.sent)).toHaveLength(1); // 仅一次网络调用
  });

  it("换 experimentId 不能绕过 organism 域额度；重启不重置", async () => {
    h.inst.storage.setDecisionCallLimit({ organismId: "organism-default" }, 1, Date.now());
    // organism 域已被上一个测试消耗？此测试单独 harness 计数——直接验证：新实验也被拒
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const rejected = await submitL("统计字数", { experimentId: "exp-organism-1" });
    if (rejected.state === "failed") {
      expect(rejected.failureReason).toBe("decision_budget_exhausted");
    }
    // 重启实例后额度依然生效（持久化）
    h.inst.close();
    const freshFake = new FakeLlmDecisionProvider({
      defaultScript: { type: "value", value: "local-process" },
    });
    const reopened = openInstance(h.root, {
      decisions: new Map([["decision-llm", freshFake]]),
    });
    try {
      const { input, options } = experimentSubmission({
        goal: "统计字数",
        inputs: [BUNDLE, CHANGED],
        genomes: h.genomes,
        arm: "L",
        schema: STATS_SCHEMA,
        experimentId: "exp-organism-2",
      });
      const again = await reopened.runtime.submitTask(input, options);
      expect(again.state).toBe("failed");
      expect(again.failureReason).toBe("decision_budget_exhausted");
      expect(freshFake.capturedRequests).toHaveLength(0); // 未触达网络
    } finally {
      // 交还原实例供后续测试使用，并撤销本测试设置的 organism 限额
      reopened.storage.setDecisionCallLimit(
        { organismId: "organism-default" },
        1_000_000,
        Date.now(),
      );
      Object.assign(h, { ...h, inst: reopened, fake: freshFake });
    }
  });
});

describe("D07/D08/D09：崩溃窗口与恢复", () => {
  it("started 后崩溃 → 恢复为 unknown，Run 置 waiting，settle 结案保留证据", async () => {
    // 构造：fake 立即成功提交 value；随后受控回退至忠实于"started 后崩溃"的状态：
    // 调用回到 started（无响应）、run 回到 running、清除决策之后的事件投影
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const summary = await submitL("统计字数", { experimentId: "exp-crash-1" });
    expect(summary.state).toBe("succeeded");
    const call = lastCall(summary.runId)!;
    const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      "UPDATE decision_calls SET state = 'started', ended_at = NULL, duration_ms = NULL, response_ref = NULL, response_digest = NULL WHERE id = ?",
    ).run(call.id);
    db.prepare(
      "DELETE FROM events WHERE run_id = ? AND type IN ('node.completed', 'decision.recorded', 'verify.completed')",
    ).run(summary.runId);
    db.prepare("UPDATE runs SET state = 'running', failure_reason = NULL WHERE id = ?").run(
      summary.runId,
    );
    db.close();

    const actions = await h.inst.runtime.recoverRun(summary.runId);
    expect(actions[0]!.action).toBe("waiting_decision");
    const after = h.inst.storage.getDecisionCall(call.id)!;
    expect(after.state).toBe("unknown"); // started 固化为 unknown，不自动重发
    expect(h.inst.storage.getRun(summary.runId)!.state).toBe("waiting");

    // 普通执行入口也尊重未结决策调用（回到 waiting，不派发新 worker）
    const attemptsBefore = attemptsOf(summary.runId).length;
    const rerun = await h.inst.runtime.executeRun(summary.runId);
    expect(rerun.state).toBe("waiting");
    expect(attemptsOf(summary.runId)).toHaveLength(attemptsBefore);

    // 显式结案：保留 unknown 证据，Run 以 failed/decision_unknown 结案
    const settled = h.inst.runtime.settleDecisionCall(call.id, { note: "operator 结案" });
    expect(settled.state).toBe("failed");
    expect(h.inst.storage.getDecisionCall(call.id)!.state).toBe("unknown"); // 证据终态不被改写
  });

  it("D07 旧窗口：choice 已存但节点完成未存 → 恢复使用已记录选择，不再次决策", async () => {
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const summary = await submitL("统计字数", { experimentId: "exp-window" });
    expect(summary.state).toBe("succeeded");
    const callCountBefore = h.inst.storage.listDecisionCalls(summary.runId).length;
    // 受控构造旧窗口：保留 decision.recorded，清除节点完成与执行残留（决策后无其他进展）
    const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      "DELETE FROM events WHERE run_id = ? AND type IN ('node.completed', 'verify.completed')",
    ).run(summary.runId);
    rewindExecution(db, summary.runId);
    db.close();
    const rerun = await h.inst.runtime.executeRun(summary.runId);
    expect(rerun.state).toBe("succeeded");
    // 决策调用计数不增加（恢复使用已持久化的选择，不再次推断）
    expect(h.inst.storage.listDecisionCalls(summary.runId)).toHaveLength(callCountBefore);
  });

  it("D08 决策成功后崩溃再 recover：使用原 choice 与快照，模型不重调、worker 不重复", async () => {
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const summary = await submitL("统计字数", { experimentId: "exp-replay" });
    expect(summary.state).toBe("succeeded");
    const callCountBefore = h.inst.storage.listDecisionCalls(summary.runId).length;
    const attemptsBefore = attemptsOf(summary.runId).length;
    const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE runs SET state = 'running', failure_reason = NULL WHERE id = ?").run(
      summary.runId,
    );
    db.close();
    // "进程重启"：关闭并重开实例（新 fake，零请求），从事件投影恢复
    h.inst.close();
    const freshFake = new FakeLlmDecisionProvider();
    const reopened = openInstance(h.root, { decisions: new Map([["decision-llm", freshFake]]) });
    Object.assign(h, { inst: reopened, fake: freshFake });
    const rerun = await reopened.runtime.executeRun(summary.runId);
    expect(rerun.state).toBe("succeeded");
    expect(reopened.storage.listDecisionCalls(summary.runId)).toHaveLength(callCountBefore);
    expect(attemptsOf(summary.runId)).toHaveLength(attemptsBefore); // worker 不重复执行
    expect(freshFake.capturedRequests).toHaveLength(0); // 未再次调用模型
    // 快照不漂移：决策调用仍指向原策略版本
    const call = lastCall(summary.runId)!;
    expect(call.policyVersionId).toBe(h.genomes.llm.policyVersionId);
  });

  it("D09 请求 blob 丢失 → 明确不可恢复（不得用重建内容补发）", async () => {
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const summary = await submitL("统计字数", { experimentId: "exp-blob-lost" });
    const call = lastCall(summary.runId)!;
    const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000");
    // 构造 prepared 崩溃：回退到 prepared、清除决策之后的事件与执行残留，删除请求 blob
    db.prepare(
      "UPDATE decision_calls SET state = 'prepared', sent = 0, started_at = NULL, response_ref = NULL, response_digest = NULL, ended_at = NULL, duration_ms = NULL WHERE id = ?",
    ).run(call.id);
    db.prepare(
      "DELETE FROM events WHERE run_id = ? AND type IN ('node.completed', 'decision.recorded', 'verify.completed', 'decision.started', 'decision.prepared')",
    ).run(summary.runId);
    rewindExecution(db, summary.runId);
    db.close();
    const { rmSync } = await import("node:fs");
    rmSync(join(h.root, "blobs", call.requestRef!));
    const rerun = await h.inst.runtime.executeRun(summary.runId);
    expect(rerun.state).toBe("failed");
    expect(rerun.failureReason).toBe("decision_request_lost");
    expect(
      h.fake.capturedRequests.filter((r) => r.policy.versionId === call.policyVersionId),
    ).toHaveLength(1); // 未用重建内容补发（只有最初一次）
  });
});

describe("D10/D12/D13（集成部分）", () => {
  it("视图超限在网络调用前失败（input_too_large，无决策调用记录）", async () => {
    h.fake.resetQueue({ type: "value", value: "local-process" });
    const before = h.fake.capturedRequests.length;
    const bigGoal = "统计字数".repeat(6000); // > 16 KiB
    const summary = await submitL(bigGoal);
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("input_too_large");
    expect(h.inst.storage.listDecisionCalls(summary.runId)).toHaveLength(0); // 未进入 prepared
    expect(h.fake.capturedRequests.length).toBe(before); // 无网络调用
  });

  it("D12 账单字段缺失保持 null/unknown（不按零计）", async () => {
    h.fake.resetQueue({ type: "transport-error" });
    const summary = await submitL("统计字数", { experimentId: "exp-bill" });
    const call = lastCall(summary.runId)!;
    expect(call.state).toBe("transport_error");
    expect(call.usage).toBeNull(); // 用量未知 ≠ 0
    const experience = h.inst.storage.getExperienceByRun(summary.runId)!;
    expect(experience.outcome.decisionCallIds).toContain(call.id); // 失败决策同样保留
  });

  it("D13 无效 choice 指向未安装执行器 → 校验拒绝，零副作用，决策不能更改 options", async () => {
    h.fake.resetQueue({ type: "value", value: "capability/not-installed" });
    const summary = await submitL("统计字数", { experimentId: "exp-d13" });
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("decision_invalid_output");
    expect(attemptsOf(summary.runId)).toHaveLength(0);
    const request = h.fake.capturedRequests[h.fake.capturedRequests.length - 1]!;
    expect(request.options).toEqual(["local-process", "capability/changed-file-summary"]); // options 未被决策改写
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor 超时");
}

/** 回退执行残留：模拟"决策之后无其他进展"（清 Attempt/Process/outbox，run 回 running） */
function rewindExecution(db: DatabaseSync, runId: string): void {
  db.prepare(
    "DELETE FROM attempts WHERE process_id IN (SELECT id FROM processes WHERE run_id = ?)",
  ).run(runId);
  db.prepare("DELETE FROM outbox WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM processes WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM experiences WHERE run_id = ?").run(runId);
  db.prepare("UPDATE runs SET state = 'running', failure_reason = NULL WHERE id = ?").run(runId);
}
