import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import { resolveLlmDemosRequest } from "../../src/adapters/decision-llm/request.ts";
import {
  prepareDiagnosticRunner,
  openDiagnosticRunner,
} from "../../src/app/experiment/diagnostic-runner.ts";
import { DiagnosticExperiment, freezeDiagnosticPlan } from "../../src/app/experiment/diagnostic.ts";
import { diagnosticDataset } from "../../src/app/experiment/diagnostic-data.ts";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import type { DecisionRequest, DecisionResult } from "../../src/decision/index.ts";

class Model extends LlmDecisionProvider {
  count = 100;
  calls = 0;
  decisionDeadlines: number[] = [];
  fault: "none" | "drift" | "lost" | "budget" | "all-empty" | "service5xx" | "budget1024" = "none";
  constructor() {
    super({ apiKey: "NO_NETWORK", baseUrl: "https://open.bigmodel.cn/api/anthropic" });
  }
  override countInputTokens(_request: DecisionRequest) {
    return Promise.resolve(this.count);
  }
  override async decide(r: DecisionRequest): Promise<DecisionResult> {
    this.calls++;
    this.decisionDeadlines.push(r.deadlineMs);
    if (this.fault === "service5xx")
      throw Object.assign(new Error("503 overloaded"), { status: 503 });
    if (this.fault === "lost") throw new Error("lost service response");
    const c = [...diagnosticDataset("matrix"), ...diagnosticDataset("confirmation")].find(
      (c) => c.task.goal === r.view!.goal,
    )!;
    const output = resolveLlmDemosRequest(r).max_tokens;
    const truncated =
      this.fault === "all-empty" ||
      (this.fault === "budget" && output === 256) ||
      (this.fault === "budget1024" && output === 1024);
    const raw = truncated ? "" : canonicalJson({ kind: "value", value: c.expectedChoice });
    const common = {
      raw,
      provenance: { provider: this.name, policyVersion: r.policy.versionId },
      evidence: {
        inputTokens: this.fault === "drift" ? 101 : 100,
        outputTokens: truncated ? output : 10,
        servedModel: "GLM-5.3-Flash",
        serviceResponse: {
          version: "llm-service-response-v1" as const,
          stopReason: truncated ? "max_tokens" : "end_turn",
          contentBlockTypes: ["text"],
          textBytes: Buffer.byteLength(raw),
        },
      },
    };
    return truncated
      ? { ...common, kind: "invalid_output", detail: "empty" }
      : { ...common, kind: "value", value: c.expectedChoice };
  }
}
let parent: string;
let fixedParent: string;
let capParent: string;
const opened = new Set<AppInstance>();
const roots: string[] = [];
beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "proteus-diagnostic-parent-"));
  execFileSync("tar", [
    "-xzf",
    "docs/experiments/results/adaptive-observed-v3/evidence.tar.gz",
    "-C",
    parent,
  ]);
});
afterEach(() => {
  for (const app of opened) app.close();
  opened.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeAll(() => {
  fixedParent = mkdtempSync(join(tmpdir(), "proteus-cap-parent-"));
  execFileSync("tar", [
    "-xzf",
    "docs/experiments/results/routing-fixed-output-v1/evidence.tar.gz",
    "-C",
    fixedParent,
  ]);
});
beforeAll(() => {
  capParent = mkdtempSync(join(tmpdir(), "proteus-layout-parent-"));
  execFileSync("tar", [
    "-xzf",
    "docs/experiments/results/routing-output-cap-v1/evidence.tar.gz",
    "-C",
    capParent,
  ]);
});
afterAll(() => {
  rmSync(capParent, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
  rmSync(fixedParent, { recursive: true, force: true });
});
function fixture(
  mode: Model["fault"] = "none",
  opts?: {
    parent?: string;
    stage?: "confirmation" | "fixed-output" | "output-cap" | "layout" | "demo-increment";
    small?: boolean;
  },
) {
  const out = mkdtempSync(join(tmpdir(), "proteus-diagnostic-test-"));
  roots.push(out);
  const transport = new Model();
  transport.fault = mode;
  const id = `diag:${crypto.randomUUID()}`;
  const h = prepareDiagnosticRunner(join(out, "instance"), id, transport, {
    parent: opts?.parent ?? parent,
    stage: opts?.stage ?? "matrix",
    mode: "fixture",
    sourceCommit: "fixture",
    small: opts?.small ?? true,
  });
  opened.add(h.app);
  return { ...h, out, id, transport };
}
async function finish(h: ReturnType<typeof fixture>) {
  while (await h.experiment.runNext()) {}
  return h.experiment.report();
}
function close(app: AppInstance) {
  opened.delete(app);
  app.close();
}
async function stoppedServiceParent() {
  const h = fixture("service5xx");
  await expect(h.experiment.runNext()).rejects.toThrow(/stop without retry/);
  const report = h.experiment.report();
  writeFileSync(join(h.out, "run.json"), JSON.stringify({ id: h.id }));
  writeFileSync(join(h.out, "manifest.json"), canonicalJson(h.frozen.plan));
  writeFileSync(join(h.out, "report.json"), canonicalJson(report));
  writeFileSync(
    join(h.out, "summary.json"),
    JSON.stringify({ reportDigest: digestOf(canonicalJson(report)) }),
  );
  close(h.app);
  return h;
}

describe("O2 原始诊断：冻结额度、同正文计数和受约束执行", () => {
  it("布局与示例分阶段冻结，平局选零示例且继承累计未知", async () => {
    const layout = fixture("none", { parent: capParent, stage: "layout" });
    expect(layout.frozen.plan.conditions.map((c) => c.id)).toEqual(["v1-t1024-d0", "v2-t1024-d0"]);
    expect(() =>
      freezeDiagnosticPlan({
        ...layout.frozen.plan,
        conditions: [
          layout.frozen.plan.conditions[0],
          { ...layout.frozen.plan.conditions[1], demos: 2 },
        ],
      }),
    ).toThrow(/conditions drift/);
    const first = await finish(layout);
    expect(first).toMatchObject({
      engineering: "passed",
      developmentRecommendation: "v1-t1024-d0",
      confirmationPassed: false,
      totalUnknownUsageCallsIncludingHistory: 2,
    });
    writeFileSync(join(layout.out, "run.json"), JSON.stringify({ id: layout.id }));
    writeFileSync(join(layout.out, "manifest.json"), canonicalJson(layout.frozen.plan));
    writeFileSync(join(layout.out, "report.json"), canonicalJson(first));
    writeFileSync(
      join(layout.out, "summary.json"),
      JSON.stringify({ reportDigest: digestOf(canonicalJson(first)) }),
    );
    close(layout.app);
    const demos = fixture("none", { parent: layout.out, stage: "demo-increment" });
    expect(demos.frozen.plan.conditions.map((c) => c.id)).toEqual(["v1-t1024-d0", "v1-t1024-d2"]);
    const second = await finish(demos);
    expect(second).toMatchObject({
      engineering: "passed",
      developmentRecommendation: "v1-t1024-d0",
      confirmationPassed: false,
      totalUnknownUsageCallsIncludingHistory: 2,
    });
    expect(demos.transport.calls).toBe(4);
  });
  it("1024/2048 独立协议复用冻结任务、放宽共同时间窗，旧协议限额保持", async () => {
    const h = fixture("none", { parent: fixedParent, stage: "output-cap" });
    const p = h.frozen.plan;
    expect(p).toMatchObject({ protocol: "routing-output-cap-v1", runMs: 90000, decisionMs: 85000 });
    expect(p.conditions.map((c) => [c.layout, c.demos, c.output])).toEqual([
      [1, 0, 1024],
      [1, 0, 2048],
    ]);
    const parentPlan = JSON.parse(readFileSync(join(fixedParent, "manifest.json"), "utf8"));
    expect(p.cases).toEqual([parentPlan.cases[0], parentPlan.cases[2]]);
    expect(() => freezeDiagnosticPlan({ ...p, protocol: "routing-fixed-output-v1" })).toThrow(
      /bounds drift/,
    );
    expect(() => freezeDiagnosticPlan({ ...p, runMs: 30000 })).toThrow(/bounds drift/);
    expect(() =>
      freezeDiagnosticPlan({
        ...p,
        conditions: [p.conditions[0], { ...p.conditions[1], layout: 2 }],
      }),
    ).toThrow(/conditions drift/);
    const r = await finish(h);
    expect(r).toMatchObject({
      completedRuns: 4,
      engineering: "passed",
      confirmationPassed: false,
      selected: null,
      totalModelCallsIncludingHistory: 1059,
      totalUnknownUsageCallsIncludingHistory: 2,
      developmentRecommendation: "v1-t1024-d0",
      qualityGates: [
        { conditionId: "v1-t1024-d0", passed: true },
        { conditionId: "v1-t2048-d0", passed: true },
      ],
    });
    const run = h.app.storage.getRun(r.receipts[0]!.runId)!;
    expect(run.budget.maxWallClockSeconds).toBe(90);
    expect(h.transport.decisionDeadlines.every((ms) => ms > 28000 && ms <= 85000)).toBe(true);
    close(h.app);
    const fresh = openDiagnosticRunner(join(h.out, "instance"), h.id, h.transport, 85000);
    opened.add(fresh.app);
    expect(fresh.experiment.report()).toEqual(r);
    expect(await fresh.experiment.runNext()).toBeNull();
    expect(h.transport.calls).toBe(4);
  });
  it("1024 截断计为失败，仅 2048 达门时才推荐 2048；不伪称旧确认通过", async () => {
    const h = fixture("budget1024", { parent: fixedParent, stage: "output-cap" });
    const r = await finish(h);
    expect(r).toMatchObject({
      confirmationPassed: false,
      developmentRecommendation: "v1-t2048-d0",
      qualityGates: [
        { conditionId: "v1-t1024-d0", passed: false },
        { conditionId: "v1-t2048-d0", passed: true },
      ],
    });
    expect(r.metrics[0]!.stopReasons).toEqual({ max_tokens: 2 });
  });
  it("1024/2048 的未知仍占分母与额度，不重发且不能推荐配置", async () => {
    const h = fixture("service5xx", { parent: fixedParent, stage: "output-cap" });
    await h.experiment.runNext();
    h.transport.fault = "none";
    const r = await finish(h);
    expect(r).toMatchObject({
      dispatchComplete: true,
      engineering: "incomplete",
      unknownUsageCalls: 1,
      totalUnknownUsageCallsIncludingHistory: 3,
      developmentRecommendation: null,
    });
    expect(r.qualityGates?.every((g) => !g.passed)).toBe(true);
    expect(h.transport.calls).toBe(4);
  });
  it("独立固定额度轮可保留两次 5xx 后完成其他槽位，旧矩阵保持失败且不重发", async () => {
    const parent = await stoppedServiceParent();
    const h = fixture("service5xx", { parent: parent.out, stage: "fixed-output" });
    expect((await h.experiment.runNext())!.decision).toBe("transport_error");
    expect((await h.experiment.runNext())!.decision).toBe("transport_error");
    h.transport.fault = "none";
    const r = await finish(h);
    expect(r).toMatchObject({
      protocol: "routing-fixed-output-v1",
      dispatchComplete: true,
      engineering: "incomplete",
      unknownUsageCalls: 2,
      completedRuns: 4,
      totalModelCallsIncludingHistory: 798,
      totalUnknownUsageCallsIncludingHistory: 4,
      confirmationPassed: false,
    });
    expect(r.metrics.map((c) => c.id)).toEqual(["v1-t512-d0", "v1-t256-d0"]);
    expect(h.transport.calls).toBe(4);
    expect(parent.transport.calls).toBe(1);
  });
  it("独立固定额度轮第三次 5xx 停止，不补齐或返还未知占用", async () => {
    const parent = await stoppedServiceParent();
    const h = fixture("service5xx", { parent: parent.out, stage: "fixed-output" });
    await h.experiment.runNext();
    await h.experiment.runNext();
    await expect(h.experiment.runNext()).rejects.toThrow(/stop without retry/);
    expect(h.experiment.report()).toMatchObject({
      completedRuns: 3,
      sentModelCalls: 3,
      unknownUsageCalls: 3,
      dispatchComplete: false,
    });
    expect(await h.experiment.runNext()).toBeNull();
    expect(h.transport.calls).toBe(3);
  });
  it("计数阶段 5xx 不在容错范围，不能生成或重发", async () => {
    const parent = await stoppedServiceParent();
    const h = fixture("none", { parent: parent.out, stage: "fixed-output" });
    h.transport.countInputTokens = () =>
      Promise.reject(Object.assign(new Error("503 count failed"), { status: 503 }));
    await expect(h.experiment.runNext()).rejects.toThrow(/stop without retry/);
    expect(h.experiment.report()).toMatchObject({
      reservedModelCalls: 1,
      sentModelCalls: 0,
      dispatchComplete: false,
    });
    expect(h.transport.calls).toBe(0);
  });
  it("首十六次无有效 value 即停止，完整分母保留，不追加或重发", async () => {
    const h = fixture("all-empty", { small: false });
    while (await h.experiment.runNext()) {}
    const r = h.experiment.report();
    expect(r).toMatchObject({
      plannedRuns: 160,
      completedRuns: 16,
      sentModelCalls: 16,
      unknownUsageCalls: 0,
      engineering: "incomplete",
      stopReason: "first sixteen cells contain no valid value",
    });
    expect(h.transport.calls).toBe(16);
    expect(r.selected).toBeNull();
  });
  it("计数之后正文发生变化不会生成，条件标注也不能冒充另一策略", async () => {
    const h = fixture();
    const conditions = structuredClone(h.frozen.plan.conditions);
    Object.assign(conditions[0]!, {
      snapshotId: conditions[1]!.snapshotId,
      snapshotDigest: conditions[1]!.snapshotDigest,
    });
    expect(() =>
      new DiagnosticExperiment(h.app, "diag:mislabelled").register({
        ...h.frozen.plan,
        conditions,
      }),
    ).toThrow(/example selection drift/);
    h.transport.countInputTokens = async (request) => {
      request.prepared!.body.messages = [];
      return 100;
    };
    await expect(h.experiment.runNext()).rejects.toThrow(/stop without retry/);
    expect(h.transport.calls).toBe(0);
    expect(h.experiment.report().sentModelCalls).toBe(0);
  });
  it("剩余时限不足一个完整 Run 时不领取新槽位", async () => {
    const h = fixture();
    const registered = h.app.storage.listEvents({ streamId: `diagnostic-${h.id}` }, 1)[0]!;
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(registered.occurredAt + h.frozen.wallMs - 29999);
    try {
      expect(await h.experiment.runNext()).toBeNull();
    } finally {
      clock.mockRestore();
    }
    expect(h.experiment.report()).toMatchObject({
      completedRuns: 0,
      sentModelCalls: 0,
      stopReason: "insufficient full Run time; no next send",
    });
  });
  it("八条件完整流程，全部实际 worker 验收通过；清理重开后复算一致，篡改被拒绝", async () => {
    const h = fixture();
    const report = await finish(h);
    expect(report).toMatchObject({
      engineering: "passed",
      dispatchComplete: true,
      completedRuns: 16,
      sentModelCalls: 16,
      unknownUsageCalls: 0,
      activeUnchanged: true,
      totalModelCallsIncludingHistory: 809,
      totalUnknownUsageCallsIncludingHistory: 1,
    });
    expect(report.metrics).toHaveLength(8);
    expect(report.metrics.every((c) => c.successRate === 1 && c.jsonValidRate === 1)).toBe(true);
    expect(report.benefit).toBe("not_evaluated");
    expect(report.receipts.every((r) => r.serviceEvidenceComplete)).toBe(true);
    rmSync(join(h.app.root, "workspaces"), { recursive: true, force: true });
    rmSync(join(h.app.root, "diagnostic-materials"), { recursive: true, force: true });
    close(h.app);
    const app = openInstance(join(h.out, "instance"));
    opened.add(app);
    const experiment = new DiagnosticExperiment(app, h.id);
    expect(experiment.report()).toEqual(report);
    const call = app.storage.getDecisionCall(report.receipts[0]!.callId)!;
    writeFileSync(join(app.root, "blobs", call.responseRef!), "tampered");
    expect(() => experiment.report()).toThrow(/digest drift/);
  });
  it("计数超限不生成，已预留槽位保留且不重新发送", async () => {
    const h = fixture();
    h.transport.count = 2049;
    await expect(h.experiment.runNext()).rejects.toThrow(/stop without retry/);
    expect(h.transport.calls).toBe(0);
    expect(h.experiment.report()).toMatchObject({
      engineering: "incomplete",
      reservedModelCalls: 1,
      sentModelCalls: 0,
      completedRuns: 1,
    });
    expect(await h.experiment.runNext()).toBeNull();
  });
  it.each(["drift", "lost"] as const)("%s 保留实际调用及已知/未知用量，不能补考", async (fault) => {
    const h = fixture(fault);
    await expect(h.experiment.runNext()).rejects.toThrow(/stop without retry/);
    const r = h.experiment.report();
    expect(r.sentModelCalls).toBe(1);
    expect(r.reservedModelCalls).toBe(1);
    expect(r.engineering).toBe("incomplete");
    expect(r.unverifiedUsageCalls).toBe(1);
    expect(r.unknownUsageCalls).toBe(fault === "lost" ? 1 : 0);
    expect(r.knownInputTokens).toBe(fault === "lost" ? 0 : 101);
    expect(await h.experiment.runNext()).toBeNull();
    expect(h.transport.calls).toBe(1);
  });
  it("两个连接争用仅准入一个槽位，另一个不能重复发送", async () => {
    const h = fixture();
    const other = openDiagnosticRunner(h.app.root, h.id, h.transport);
    opened.add(other.app);
    const results = await Promise.allSettled([h.experiment.runNext(), other.experiment.runNext()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.transport.calls).toBe(1);
    expect(h.experiment.report().completedRuns).toBe(1);
  });
  it("结果已返回但收据未封闭：保留部分调用及执行成本，重开不重发", async () => {
    const h = fixture();
    const append = h.app.storage.appendEvent.bind(h.app.storage);
    vi.spyOn(h.app.storage, "appendEvent").mockImplementation((event) => {
      if (event.type === "diagnostic.closed") throw new Error("host crash");
      return append(event);
    });
    vi.spyOn(h.experiment, "stop").mockImplementation(() => {});
    await expect(h.experiment.runNext()).rejects.toThrow("host crash");
    const r = h.experiment.report();
    expect(r).toMatchObject({
      completedRuns: 0,
      sentModelCalls: 1,
      knownInputTokens: 100,
      knownOutputTokens: 10,
      unknownCostItems: 2,
    });
    expect(r.partialRuns).toHaveLength(1);
    close(h.app);
    const fresh = openDiagnosticRunner(join(h.out, "instance"), h.id, h.transport);
    opened.add(fresh.app);
    await expect(fresh.experiment.runNext()).rejects.toThrow(/unfinished slot/);
    expect(h.transport.calls).toBe(1);
    expect(fresh.experiment.report()).toEqual(r);
  });
  it("512 在 fixture 中改善时，冻结确认对照为旧布局 256；开发成本跨阶段累计", async () => {
    const h = fixture("budget");
    const matrix = await finish(h);
    expect(matrix.selected?.id).toBe("v1-t512-d0");
    writeFileSync(join(h.out, "run.json"), JSON.stringify({ id: h.id }));
    writeFileSync(join(h.out, "manifest.json"), canonicalJson(h.frozen.plan));
    writeFileSync(join(h.out, "report.json"), canonicalJson(matrix));
    writeFileSync(
      join(h.out, "summary.json"),
      JSON.stringify({ reportDigest: digestOf(canonicalJson(matrix)) }),
    );
    close(h.app);
    const confirm = fixture("budget", { parent: h.out, stage: "confirmation" });
    const report = await finish(confirm);
    expect(report.metrics.map((c) => c.id)).toEqual(["v1-t512-d0", "v1-t256-d0"]);
    expect(report.confirmationPassed).toBe(true);
    expect(report.sentModelCalls).toBe(4);
    expect(report.totalModelCallsIncludingHistory).toBe(813);
    expect(report.totalUnknownUsageCallsIncludingHistory).toBe(1);
  });
  it("拒绝把小型 fixture 改标为完整 real，或省去一个矩阵条件", () => {
    const h = fixture();
    expect(() => freezeDiagnosticPlan({ ...h.frozen.plan, mode: "real" })).toThrow(/real case/);
    expect(() =>
      freezeDiagnosticPlan({ ...h.frozen.plan, conditions: h.frozen.plan.conditions.slice(1) }),
    ).toThrow(/complete factorial/);
  });
});
