import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { canonicalJson } from "../../src/app/seed.ts";
import { bootSeededInstance, fixturePath } from "../helpers.ts";

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const BASE = {
  requestedBy: "principal-local",
  goal: "统计摘要（DAG 测试）",
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
};

function submit() {
  return instance().runtime.submitTask({
    ...BASE,
    inputs: [fixturePath("input-a")],
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "stats-acceptance",
    },
  });
}

/** 以当前快照为基准注册新版本并 CAS 安装为默认（测试用自定义图/策略） */
function installCustomGenome(overrides: { graph?: object; policy?: object }): void {
  const app = instance();
  const organism = app.kernel.getOrganism("organism-default")!;
  const { snapshot, versions } = app.kernel.resolveSnapshot(organism.activeGenomeId!);
  app.storage.tx(() => {
    const bindings = { ...snapshot.bindings };
    const slots: Array<["task-graph" | "routing-policy", object | undefined]> = [
      ["task-graph", overrides.graph],
      ["routing-policy", overrides.policy],
    ];
    for (const [slot, content] of slots) {
      if (!content) continue;
      const current = versions.get(slot)!;
      const artifact = app.storage.getArtifact(current.artifactId)!;
      const { digest, ref } = app.blobs.write(canonicalJson(content));
      const version = app.kernel.registerVersion({
        artifact,
        schemaVersion: 2,
        contentDigest: digest,
        contentRef: ref,
        parents: [current.id],
        dependencies: [],
        createdBy: "test",
      });
      bindings[slot] = version.id;
    }
    const next = app.kernel.createSnapshot(bindings, "test");
    const fresh = app.kernel.getOrganism("organism-default")!;
    const result = app.kernel.installAsActive("organism-default", next.id, fresh.revision);
    if (!result.ok) throw new Error("测试装配 CAS 冲突");
  });
}

describe("M0 切片②：DAG（decision → execute → verify）", () => {
  it("默认 seed：三节点全部成功，决策被记录且执行器来自决策", async () => {
    const summary = await submit();

    expect(summary.state).toBe("succeeded");
    expect(summary.graphSource).toBe("dag-v1");
    expect(summary.nodes).toEqual([
      { id: "route", type: "decision", state: "succeeded" },
      { id: "stats", type: "execute", state: "succeeded" },
      { id: "check", type: "verify", state: "succeeded" },
    ]);
    expect(summary.decisions).toHaveLength(1);
    expect(summary.decisions[0]).toMatchObject({
      nodeId: "route",
      value: "local-process",
      provider: "decision-rule",
    });
    expect(summary.attempts).toHaveLength(1);
    expect(summary.checks.every((c) => c.passed)).toBe(true);

    const events = instance().storage.listEvents({ runId: summary.runId }, 100);
    const types = events.map((e) => e.type);
    for (const expected of ["decision.recorded", "node.completed", "verify.completed"]) {
      expect(types).toContain(expected);
    }
    const nodeCompleted = events.filter((e) => e.type === "node.completed");
    expect(nodeCompleted).toHaveLength(3);

    // 决策事件携带策略版本（可追溯到 routing-policy 的精确版本）
    const decisionEvent = events.find((e) => e.type === "decision.recorded")!;
    expect(decisionEvent.payload["policyVersion"]).toBe(summary.decisions[0]!.policyVersion);
  });

  it("策略无命中 route：abstain → run 失败，下游节点跳过且不产生执行", async () => {
    installCustomGenome({
      policy: {
        schemaVersion: 2,
        kind: "rule-v1",
        routes: [{ when: { nodeType: "something-else" }, choose: "local-process" }],
      },
    });
    const summary = await submit();

    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("decision_abstained");
    expect(summary.nodes.find((n) => n.id === "route")!.state).toBe("failed");
    expect(summary.nodes.find((n) => n.id === "stats")!.state).toBe("skipped");
    expect(summary.nodes.find((n) => n.id === "check")!.state).toBe("skipped");
    expect(summary.attempts).toHaveLength(0);
    expect(instance().storage.listProcesses(summary.runId)).toHaveLength(0);
    const experience = instance().storage.getExperienceByRun(summary.runId)!;
    expect(experience.outcome.result).toBe("failed");
  });

  it("决策选出未装配的执行器：unknown_executor，证据保留", async () => {
    installCustomGenome({
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          {
            id: "route",
            type: "decision",
            provider: "decision-rule",
            problem: "choice",
            options: ["local-process", "ghost-runner"],
            context: { nodeType: "execute" },
          },
          { id: "stats", type: "execute", executorFrom: "route", dependsOn: ["route"] },
          {
            id: "check",
            type: "verify",
            verifier: "stats-acceptance",
            inputFrom: "stats",
            dependsOn: ["stats"],
          },
        ],
      },
      policy: {
        schemaVersion: 2,
        kind: "rule-v1",
        routes: [{ when: { nodeType: "execute" }, choose: "ghost-runner" }],
      },
    });
    const summary = await submit();

    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("unknown_executor");
    // 决策本身合法（候选内），失败在执行器装配
    expect(summary.decisions[0]!.value).toBe("ghost-runner");
  });

  it("verify 节点声明与快照验收器不一致：拒绝执行", async () => {
    installCustomGenome({
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          { id: "stats", type: "execute", executor: "local-process", dependsOn: [] },
          {
            id: "check",
            type: "verify",
            verifier: "other-evaluator",
            inputFrom: "stats",
            dependsOn: ["stats"],
          },
        ],
      },
    });
    const summary = await submit();

    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("verifier_mismatch");
  });

  it("事后汇总（getRunSummary）从事件投影重建节点与决策", async () => {
    // 装回一张可运行的简单图（前一用例的图会在节点前失败）
    installCustomGenome({
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          { id: "stats", type: "execute", executor: "local-process", dependsOn: [] },
          {
            id: "check",
            type: "verify",
            verifier: "stats-acceptance",
            inputFrom: "stats",
            dependsOn: ["stats"],
          },
        ],
      },
    });
    const submitted = await submit();
    expect(submitted.state).toBe("succeeded");
    const summary = instance().runtime.getRunSummary(submitted.runId);
    expect(summary.nodes).toHaveLength(2);
    expect(summary.nodes.every((n) => n.state === "succeeded")).toBe(true);
  });
});
