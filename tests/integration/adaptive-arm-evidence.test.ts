import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { auditAdaptiveArm } from "../../src/app/experiment/arm-evidence.ts";
import { canonicalJson } from "../../src/storage/blobs.ts";
import { armHarness } from "../fixtures/adaptive-behavior/arm-harness.ts";
const opened: AppInstance[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of opened.splice(0)) app.close();
});
function fixture(...args: Parameters<typeof armHarness>) {
  const h = armHarness(...args);
  opened.push(h.app);
  return h;
}
it("三臂逐一核验固定组件、原始请求/响应及实际执行器，不修改 active", async () => {
  const h = fixture();
  const before = h.app.kernel.getOrganism("organism-default")!.activeGenomeId;
  for (const arm of ["single", "budget-matched", "compiled"] as const) {
    const runIds: string[] = [];
    for (let i = 0; i < (arm === "budget-matched" ? 3 : 1); i++)
      runIds.push((await h.submit(arm)).runId);
    const proof = auditAdaptiveArm(h.deps, h.input(arm, runIds));
    expect(proof).toMatchObject({
      status: "verified",
      selectedChoice: "local-process",
      selectedIndex: 0,
      selectedRunId: runIds[0],
      selectedAcceptance: true,
      registrationVerification: "not_verified",
      orderVerification: "not_verified",
      sourceModeVerification: "unavailable",
      formalEvaluation: "not_run",
    });
    expect(proof.resources.modelCalls).toEqual({
      knownTotal: runIds.length,
      unknownItems: runIds.length,
    });
    expect(proof.resources.inputTokens).toEqual({
      knownTotal: 10 * runIds.length,
      unknownItems: runIds.length,
    });
    expect(proof.resources.unknownCostItems).toBe(runIds.length);
    expect(proof.resources.items).toHaveLength(2 * runIds.length);
  }
  expect(h.provider.requests).toHaveLength(5);
  expect(JSON.stringify(h.provider.requests)).not.toMatch(
    /NEVER_PERSIST|expectedOutput|expectedChoice|formal-family/,
  );
  expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(before);
});

it("相同 choice 首次产物验收失败也不跳过，不能按 gold 选择后续通过的产物", async () => {
  const h = fixture(true);
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await h.submit("budget-matched"));
  expect(runs.map((r) => r.state)).toEqual(["failed", "succeeded", "succeeded"]);
  const proof = auditAdaptiveArm(
    h.deps,
    h.input(
      "budget-matched",
      runs.map((r) => r.runId),
    ),
  );
  expect(proof).toMatchObject({
    choices: ["local-process", "local-process", "local-process"],
    selectedIndex: 0,
    selectedRunId: runs[0]!.runId,
    selectedAcceptance: false,
    status: "verified",
  });
  expect(proof.resources.items).toHaveLength(6);
});

it("弃权/拒绝是 null 票；同票按提供顺序选最早 choice，全部调用仍计量", async () => {
  const h = fixture();
  const ids = [
    (await h.submit("budget-matched", "abstain")).runId,
    (await h.submit("budget-matched", "capability/changed-file-summary")).runId,
    (await h.submit("budget-matched")).runId,
  ];
  const proof = auditAdaptiveArm(h.deps, h.input("budget-matched", ids));
  expect(proof.choices).toEqual([null, "capability/changed-file-summary", "local-process"]);
  expect(proof.selectedChoice).toBeNull();
  expect(proof.selectedRunId).toBeNull();
  expect(proof.selectedAcceptance).toBe(false);
  expect(proof.resources.modelCalls).toEqual({ knownTotal: 3, unknownItems: 2 });
  expect(proof.proofs[0]!.decisionOutcome).toBe("model_abstain");
  const refusal = await h.submit("single", "refusal");
  expect(
    auditAdaptiveArm(h.deps, h.input("single", [refusal.runId])).proofs[0]!.decisionOutcome,
  ).toBe("service_refusal");
});

it.each(["invalid", "transport"] as const)("%s 仍为空票且保留实际调用开销", async (script) => {
  const h = fixture();
  const run = await h.submit("single", script);
  const proof = auditAdaptiveArm(h.deps, h.input("single", [run.runId]));
  expect(proof).toMatchObject({
    selectedChoice: null,
    selectedAcceptance: false,
    status: "unavailable",
  });
  expect(proof.proofs[0]!.decisionOutcome).toBe(
    script === "invalid" ? "invalid_output" : "transport_error",
  );
  expect(proof.resources.modelCalls).toEqual({ knownTotal: 1, unknownItems: 0 });
});

it("worker 失败是 null 票，决策与失败 Attempt 都留在累计开销中", async () => {
  const h = fixture("execution-failure");
  const run = await h.submit();
  expect(run.state).toBe("failed");
  const proof = auditAdaptiveArm(h.deps, h.input("single", [run.runId]));
  expect(proof).toMatchObject({
    choices: [null],
    selectedAcceptance: false,
    status: "unavailable",
  });
  expect(proof.resources.items.map((item) => item.kind)).toEqual(["decision", "execution"]);
  expect(proof.resources.modelCalls).toEqual({ knownTotal: 1, unknownItems: 1 });
});

it("缺测必须占原槽位，不能缩短三次臂、重复引用 Run 或倒排明确的执行时序", async () => {
  const h = fixture();
  const first = await h.submit("budget-matched");
  const second = await h.submit("budget-matched");
  const third = await h.submit("budget-matched");
  expect(() => auditAdaptiveArm(h.deps, h.input("budget-matched", [first.runId]))).toThrow("槽位");
  expect(() =>
    auditAdaptiveArm(h.deps, h.input("budget-matched", [first.runId, first.runId, third.runId])),
  ).toThrow("重复");
  expect(() =>
    auditAdaptiveArm(h.deps, h.input("budget-matched", [third.runId, second.runId, first.runId])),
  ).toThrow("顺序");
  const proof = auditAdaptiveArm(
    h.deps,
    h.input("budget-matched", [first.runId, null, third.runId]),
  );
  expect(proof).toMatchObject({
    status: "incomplete",
    missing: [1],
    choices: ["local-process", null, "local-process"],
  });
  expect(proof.resources.items).toHaveLength(4);
});

it("编译臂不能使用基线 Run，也不能改动另一快照的固定组件", async () => {
  const h = fixture();
  const run = await h.submit();
  expect(() => auditAdaptiveArm(h.deps, h.input("compiled", [run.runId]))).toThrow("策略臂快照");
  const input = h.input("single", [run.runId]);
  const original = h.app.kernel.resolveSnapshot.bind(h.app.kernel);
  vi.spyOn(h.app.kernel, "resolveSnapshot").mockImplementation((id) => {
    const snapshot = original(id);
    return id === input.snapshots.compiled
      ? {
          ...snapshot,
          snapshot: {
            ...snapshot.snapshot,
            bindings: { ...snapshot.snapshot.bindings, extra: "unplanned-tool" },
          },
        }
      : snapshot;
  });
  expect(() => auditAdaptiveArm(h.deps, input)).toThrow("仅允许策略不同");
});

it.each(["request", "response", "event", "provenance", "extra-call"] as const)(
  "拒绝 %s 漂移或遗漏，而不是相信宿主自报选择",
  async (kind) => {
    const h = fixture();
    const run = await h.submit("compiled");
    const original = h.app.storage.listDecisionCalls.bind(h.app.storage);
    const call = original(run.runId)[0]!;
    if (kind === "event") {
      const events = h.app.storage.runEventsByType.bind(h.app.storage);
      vi.spyOn(h.app.storage, "runEventsByType").mockImplementation((id, type) =>
        events(id, type).map((e) =>
          type === "decision.recorded"
            ? { ...e, payload: { ...e.payload, value: "capability/changed-file-summary" } }
            : e,
        ),
      );
    } else {
      const changed = structuredClone(call);
      if (kind === "request") {
        const raw = JSON.parse(h.app.blobs.read(call.requestRef!));
        raw.view.goal = "偷偷换目标";
        const blob = h.app.blobs.write(canonicalJson(raw));
        changed.requestRef = blob.ref;
        changed.requestDigest = blob.digest;
      } else if (kind === "response") {
        const blob = h.app.blobs.write(canonicalJson({ kind: "abstain", reason: "替换" }));
        changed.responseRef = blob.ref;
        changed.responseDigest = blob.digest;
      } else if (kind === "provenance") changed.provenance.serviceId = "https://different.invalid";
      vi.spyOn(h.app.storage, "listDecisionCalls").mockImplementation((id) =>
        id !== run.runId
          ? original(id)
          : kind === "extra-call"
            ? [call, { ...call, id: "unmetered-call" }]
            : [changed],
      );
    }
    expect(() => auditAdaptiveArm(h.deps, h.input("compiled", [run.runId]))).toThrow();
  },
);

it("清理任务文件与工作区后重开复算，不调用 Provider 或补跑缺测", async () => {
  const h = fixture();
  const run = await h.submit("compiled");
  const input = h.input("compiled", [run.runId]);
  const proof = auditAdaptiveArm(h.deps, input);
  const capsule = h.app.blobs.write(canonicalJson(input));
  rmSync(h.dir, { recursive: true });
  rmSync(join(h.app.root, "workspaces"), { recursive: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(
    auditAdaptiveArm(
      { ...reopened, organismId: "organism-default", actorId: "principal-local" },
      JSON.parse(reopened.blobs.read(capsule.ref)),
    ),
  ).toEqual(proof);
  expect(h.provider.requests).toHaveLength(1);
  expect(() => auditAdaptiveArm({ ...h.deps, actorId: "absent" }, input)).toThrow();
});
