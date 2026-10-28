import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import type { DecisionRequest, DecisionResult } from "../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  prepareObservedRunner,
  openObservedRunner,
} from "../../src/app/experiment/observed-runner.ts";
import { ObservedExperiment } from "../../src/app/experiment/observed.ts";
import { openInstance } from "../../src/app/instance.ts";
import { freezeObservedPlan } from "../../src/app/experiment/observed-plan.ts";
import {
  buildLlmChoiceBody,
  resolveLlmDemosRequest,
} from "../../src/adapters/decision-llm/request.ts";
import { isLlmDemosPolicy, parseLlmPolicy } from "../../src/decision/index.ts";

class Fake extends LlmDecisionProvider {
  generated = 0;
  drift = false;
  throwOnSend = false;
  counter = 100;
  onSend?: () => Promise<void>;
  bodies: unknown[] = [];
  servedModel: string | null = "GLM-5.3-Flash";
  constructor() {
    super({ apiKey: "FAKE_NO_NETWORK", baseUrl: "https://observed.invalid" });
  }
  override countInputTokens() {
    return Promise.resolve(this.counter);
  }
  override async decide(r: DecisionRequest): Promise<DecisionResult> {
    this.generated++;
    this.bodies.push(
      isLlmDemosPolicy(r.policy.content)
        ? resolveLlmDemosRequest(r)
        : buildLlmChoiceBody(parseLlmPolicy(r.policy.content)!, r.view!, r.options),
    );
    await this.onSend?.();
    if (this.throwOnSend) throw new Error("fixture lost response");
    return {
      kind: "value",
      value: "local-process",
      raw: canonicalJson({ kind: "value", value: "local-process" }),
      provenance: { provider: this.name, policyVersion: r.policy.versionId },
      evidence: {
        inputTokens: this.drift ? 101 : 100,
        outputTokens: 5,
        servedModel: this.servedModel,
      },
    };
  }
}
function boot() {
  const root = mkdtempSync(join(tmpdir(), "proteus-observed-"));
  const provider = new Fake();
  const h = prepareObservedRunner(join(root, "instance"), "obs:fixture", provider, {
    mode: "fixture",
    sourceCommit: "fixture",
    small: true,
  });
  return { ...h, root, provider };
}
const node26 = Number(process.versions.node.split(".")[0]) >= 26;

it.skipIf(!node26)(
  "延续只执行未开始槽位，冻结策略不变，父报告逐字段不变",
  async () => {
    const h = boot();
    let child: ReturnType<typeof openObservedRunner> | undefined;
    try {
      for (let i = 0; i < 8; i++) await h.experiment.runNext();
      h.experiment.stop("fixture active-time limit");
      const before = h.experiment.report();
      const sent = h.provider.generated;
      child = openObservedRunner(h.app.root, "obs:continuation", h.provider);
      const continued = child.experiment.continueFrom(
        "obs:fixture",
        "fixture-continuation",
        digestOf(canonicalJson(before)),
      );
      expect(continued.importedRuns).toBe(8);
      expect(() =>
        child!.experiment.register({
          ...continued.frozen.plan,
          seed: continued.frozen.plan.seed + 1,
        }),
      ).toThrow(/cannot change/);
      while (await child.experiment.runNext()) {}
      const result = child.experiment.report();
      expect(result).toMatchObject({
        protocol: "adaptive-observed-v3",
        dispatchComplete: true,
        engineering: "passed",
        completedRuns: 34,
        sentModelCalls: 32,
        knownInputTokens: 3200,
        continuation: { importedRuns: 8, newRuns: 26 },
      });
      expect(h.provider.generated - sent).toBe(32 - sent);
      expect(h.experiment.report()).toEqual(before);
      rmSync(join(h.app.root, "workspaces"), { recursive: true });
      rmSync(join(h.app.root, "observed-materials"), { recursive: true });
      expect(child.experiment.report()).toEqual(result);
    } finally {
      child?.app.close();
      h.app.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(!node26)(
  "延续保留历史未知调用的额度和完整分母，不重发该调用",
  async () => {
    const h = boot();
    let child: ReturnType<typeof openObservedRunner> | undefined;
    try {
      for (let i = 0; i < 4; i++) await h.experiment.runNext();
      h.provider.throwOnSend = true;
      await expect(h.experiment.runNext()).rejects.toThrow(/unknown/);
      const parent = h.experiment.report();
      expect(parent.unknownUsageCalls).toBe(1);
      h.provider.throwOnSend = false;
      child = openObservedRunner(h.app.root, "obs:continuation-unknown", h.provider);
      child.experiment.continueFrom("obs:fixture", "fixture-unknown-continuation");
      while (await child.experiment.runNext()) {}
      expect(child.experiment.report()).toMatchObject({
        dispatchComplete: true,
        engineering: "incomplete",
        completedRuns: 34,
        sentModelCalls: 32,
        unknownUsageCalls: 1,
        reservedModelCalls: 32,
        qualityGate: false,
      });
      expect(h.provider.generated).toBe(32);
      expect(h.experiment.report()).toEqual(parent);
    } finally {
      child?.app.close();
      h.app.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(!node26)(
  "观测协议完整三臂、无改善 fallback、全部原始计量及清理复算，旧协议不变",
  async () => {
    const h = boot();
    try {
      while (await h.experiment.runNext()) {}
      const report = h.experiment.report();
      expect(report).toMatchObject({
        engineering: "passed",
        realModel: "not_run",
        benefit: "not_evaluated",
        formalEvaluation: "not_run",
        adoption: "not_run",
        plannedRuns: 34,
        completedRuns: 34,
        plannedModelCalls: 32,
        sentModelCalls: 32,
        knownInputTokens: 3200,
        unknownUsageCalls: 0,
        qualityGate: false,
        activeUnchanged: true,
        selection: { kind: "prespecified-fixed-demo-ablation" },
      });
      for (const arm of Object.values(report.arms)) expect(arm.formal.successRate).toBe(1);
      expect(h.provider.generated).toBe(32);
      expect(
        h.app.storage.getDecisionCall(report.receipts[2]!.callId)!.provenance.servedModel,
      ).toBeNull();
      expect(JSON.stringify(h.provider.bodies)).not.toMatch(
        /familyId|expectedChoice|private-expected|source:|formal-0/,
      );
      expect(await h.experiment.runNext()).toBeNull();
      expect(h.provider.generated).toBe(32);
      rmSync(join(h.app.root, "workspaces"), { recursive: true });
      rmSync(join(h.app.root, "observed-materials"), { recursive: true });
      const app = openInstance(h.app.root);
      try {
        expect(new ObservedExperiment(app, "obs:fixture").report()).toEqual(report);
      } finally {
        app.close();
      }
      expect(() => freezeObservedPlan({ ...h.frozen.plan, mode: "real" })).toThrow(
        /requires 20 train/,
      );
      const call = h.app.storage.getDecisionCall(report.receipts[0]!.callId)!;
      writeFileSync(join(h.app.root, "blobs", call.responseRef!), '{"tampered":true}');
      expect(() => h.experiment.report()).toThrow(/response drift/);
    } finally {
      h.app.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(!node26)("计数超限不生成，但保留计数请求和预留；未绑定 Run 不能绕过入口", async () => {
  const h = boot();
  try {
    await h.experiment.runNext();
    await h.experiment.runNext();
    h.provider.counter = 2049;
    await expect(h.experiment.runNext()).rejects.toThrow(/unknown/);
    const report = h.experiment.report();
    expect(report).toMatchObject({
      engineering: "incomplete",
      sentModelCalls: 0,
      countRequests: 1,
      reservedModelCalls: 1,
      reservedInputTokens: 2048,
    });
    expect(h.provider.generated).toBe(0);
    const task = h.app.storage.getTask(h.app.storage.listRuns(1)[0]!.taskId)!;
    expect(() =>
      h.app.runtime.admitTask(
        { ...task, familyId: task.familyId ?? undefined },
        {
          experimentId: "obs:fixture",
          snapshotId: h.frozen.plan.snapshots.base,
        },
      ),
    ).toThrow(/closed/);
  } finally {
    h.app.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

it.skipIf(!node26)("服务模型身份必须来自原始响应，缺失时停止而不是放宽身份门", async () => {
  const h = boot();
  try {
    await h.experiment.runNext();
    await h.experiment.runNext();
    h.provider.servedModel = null;
    await expect(h.experiment.runNext()).rejects.toThrow(/unknown/);
    expect(h.experiment.report()).toMatchObject({
      engineering: "incomplete",
      knownInputTokens: 100,
      unverifiedUsageCalls: 1,
    });
    expect(h.provider.generated).toBe(1);
  } finally {
    h.app.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

it.skipIf(!node26)("取消后的迟到响应用量可保留，不能改写终态或补跑", async () => {
  const h = boot();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  try {
    await h.experiment.runNext();
    await h.experiment.runNext();
    h.provider.onSend = async () => {
      entered();
      await gate;
    };
    const running = h.experiment.runNext();
    await started;
    const current = h.app.storage.listRuns(1)[0]!;
    await h.app.runtime.cancel(current.id);
    await expect(running).rejects.toThrow(/unknown/);
    release();
    await new Promise<void>((r) => setImmediate(r));
    const report = h.experiment.report();
    expect(report).toMatchObject({
      engineering: "incomplete",
      sentModelCalls: 1,
      knownInputTokens: 100,
      knownOutputTokens: 5,
    });
    expect(report.lateUsage).toHaveLength(1);
    expect(await h.experiment.runNext()).toBeNull();
    expect(h.provider.generated).toBe(1);
  } finally {
    release();
    h.app.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

it.skipIf(!node26)("服务实际计量漂移后保留该调用及未知量，停止且不重发", async () => {
  const h = boot();
  try {
    await h.experiment.runNext();
    await h.experiment.runNext();
    h.provider.drift = true;
    await expect(h.experiment.runNext()).rejects.toThrow(/count drift/);
    const report = h.experiment.report();
    expect(report).toMatchObject({
      engineering: "incomplete",
      sentModelCalls: 1,
      knownInputTokens: 101,
      knownOutputTokens: 5,
      unknownUsageCalls: 0,
      unverifiedUsageCalls: 1,
    });
    expect(await h.experiment.runNext()).toBeNull();
    expect(h.provider.generated).toBe(1);
  } finally {
    h.app.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

it.skipIf(!node26)("发送后响应丢失仍保留预留，复开不能补跑", async () => {
  const h = boot();
  try {
    await h.experiment.runNext();
    await h.experiment.runNext();
    h.provider.throwOnSend = true;
    await expect(h.experiment.runNext()).rejects.toThrow(/unknown/);
    const report = h.experiment.report();
    expect(report).toMatchObject({
      engineering: "incomplete",
      reservedModelCalls: 1,
      sentModelCalls: 1,
      unknownUsageCalls: 1,
    });
    const other = openInstance(h.app.root);
    try {
      expect(await new ObservedExperiment(other, "obs:fixture").runNext()).toBeNull();
    } finally {
      other.close();
    }
    expect(h.provider.generated).toBe(1);
  } finally {
    h.app.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

it.skipIf(!node26)("执行已完成但结案前宿主中断，不遗漏未结调用和 Attempt 开销", async () => {
  const h = boot();
  try {
    await h.experiment.runNext();
    await h.experiment.runNext();
    const execute = h.app.runtime.executeRun.bind(h.app.runtime);
    h.app.runtime.executeRun = async (id) => {
      await execute(id);
      throw new Error("host interrupted before receipt");
    };
    await expect(h.experiment.runNext()).rejects.toThrow(/before receipt/);
    const report = h.experiment.report();
    expect(report).toMatchObject({
      engineering: "incomplete",
      sentModelCalls: 1,
      knownInputTokens: 100,
      knownOutputTokens: 5,
      unknownCostItems: 5,
    });
    expect(report.partial[0]!.attempts).toHaveLength(1);
    expect(await h.experiment.runNext()).toBeNull();
    expect(h.provider.generated).toBe(1);
  } finally {
    h.app.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});
