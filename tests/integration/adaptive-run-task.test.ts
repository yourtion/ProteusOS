import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { freezeAdaptivePlan } from "../../src/app/experiment/adaptive.ts";
import {
  auditAdaptiveRunTask,
  auditRunVerification,
} from "../../src/app/experiment/run-verification.ts";
import { adaptiveTaskInputDigest } from "../../src/app/experiment/task-input.ts";
import { executionInputDigest } from "../../src/runtime/execution-evidence.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { rehearsalPlan } from "../fixtures/adaptive-behavior/rehearsal.ts";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

const opened: AppInstance[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of opened.splice(0)) app.close();
});

function fixture(expectedRaw?: string) {
  const app = bootSeededInstance();
  opened.push(app);
  const dir = join(app.root, "materials");
  mkdirSync(dir);
  const task = { goal: "统计文本", inputs: [{ name: "sample.md", content: "# A\nhello world\n" }] };
  const input = join(dir, "sample.md");
  const schema = join(dir, "schema.json");
  const expected = join(dir, "expected.json");
  writeFileSync(input, task.inputs[0]!.content);
  const schemaRaw = readFileSync(fixturePath("schemas", "stats-summary.schema.json"), "utf8");
  writeFileSync(schema, schemaRaw);
  const stats = { bytes: 16, lines: 2, words: 4, headings: 1 };
  const gold =
    expectedRaw ??
    canonicalJson({ files: [{ path: "sample.md", ...stats }], totals: { files: 1, ...stats } });
  writeFileSync(expected, gold);
  const plan = rehearsalPlan().plan;
  plan.developmentClosedAt = Date.now();
  plan.frozenAt = plan.developmentClosedAt;
  const c = plan.cases.find((c) => c.id === "formal-0")!;
  c.taskDigest = digestOf(canonicalJson(task));
  c.evaluatorDigest = digestOf(
    canonicalJson({
      verifier: "stats-acceptance",
      outputSchemaDigest: digestOf(schemaRaw),
      expectedOutputDigest: digestOf(gold),
    }),
  );
  const frozen = freezeAdaptivePlan(plan);
  const binding = { frozen, caseId: c.id, task };
  const submission = {
    requestedBy: "principal-local",
    goal: task.goal,
    inputs: [input],
    budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
    acceptance: { outputSchema: schema, expectedOutput: expected, verifier: "stats-acceptance" },
  };
  const audit = (runId: string, selected = binding) =>
    auditAdaptiveRunTask(
      { ...app, organismId: "organism-default", actorId: "principal-local" },
      runId,
      selected,
    );
  return { app, dir, input, schema, expected, binding, submission, audit };
}

it("实际输入与冻结正文、目标及独立裁判绑定；清理重开后不依赖原文件", async () => {
  const h = fixture();
  const capsule = h.app.blobs.write(canonicalJson(h.binding));
  const before = h.app.kernel.getOrganism("organism-default")!.activeGenomeId;
  const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
  const proof = h.audit(run.runId);
  expect(proof).toMatchObject({
    version: "adaptive-run-task-audit-v1",
    status: "verified",
    taskInputVerification: "verified",
    evaluatorVerification: "verified",
    verifiedAcceptance: true,
    split: "formal",
    registrationVerification: "not_verified",
    armVerification: "not_verified",
    costVerification: "not_verified",
    formalEvaluation: "not_run",
    verifiedInputs: [run.attempts[0]!.id],
    unavailableInputs: [],
  });
  expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(before);
  rmSync(h.dir, { recursive: true });
  rmSync(join(h.app.root, "workspaces"), { recursive: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(
    auditAdaptiveRunTask(
      { ...reopened, organismId: "organism-default", actorId: "principal-local" },
      run.runId,
      JSON.parse(reopened.blobs.read(capsule.ref)),
    ),
  ).toEqual(proof);
  expect(run.attempts).toHaveLength(1);
});

it("统计结果和 JSON 验收完全相同的另一份文本，不能冒充冻结输入", async () => {
  const h = fixture();
  writeFileSync(h.input, "# B\nhello earth\n");
  const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
  expect(run.state).toBe("succeeded");
  expect(
    auditRunVerification(
      { ...h.app, organismId: "organism-default", actorId: "principal-local" },
      run.runId,
    ).verifiedAcceptance,
  ).toBe(true);
  expect(() => h.audit(run.runId)).toThrow("冻结任务实际输入");
});

it.each(["schema", "expected"] as const)(
  "裁判 %s 的语义相同而字节改变，不能替换冻结裁判资料",
  async (key) => {
    const h = fixture();
    writeFileSync(h[key], `${readFileSync(h[key], "utf8")}\n`);
    const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
    expect(run.state).toBe("succeeded");
    expect(() => h.audit(run.runId)).toThrow("冻结任务独立裁判资料");
  },
);

it("独立裁判给出的负结果保持 verified 的负证据，不改成成功", async () => {
  const h = fixture("{}");
  const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
  expect(run.state).toBe("failed");
  expect(h.audit(run.runId)).toMatchObject({
    status: "verified",
    verifiedAcceptance: false,
    verification: { runtimeState: "failed" },
  });
});

it("决策弃权而未执行时保留缺测，不能把零个输入证据当作核验通过", async () => {
  const h = fixture();
  installCustomGenome(h.app, { policy: { schemaVersion: 2, kind: "rule-v1", routes: [] } });
  const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
  expect(run.state).toBe("failed");
  expect(run.attempts).toHaveLength(0);
  expect(h.audit(run.runId)).toMatchObject({
    status: "unavailable",
    taskInputVerification: "unavailable",
    evaluatorVerification: "unavailable",
    verifiedInputs: [],
    verifiedAcceptance: false,
    verification: { unexecuted: ["check"] },
  });
});

it("目标、修订、清单及用途必须匹配；开发 case 不能作为正式任务", async () => {
  const h = fixture();
  const normal = await h.app.runtime.submitTask(h.submission);
  expect(() => h.audit(normal.runId)).toThrow("evaluation");
  const wrongGoal = await h.app.runtime.submitTask(
    { ...h.submission, goal: "另一个任务" },
    { purpose: "evaluation" },
  );
  expect(() => h.audit(wrongGoal.runId)).toThrow("冻结目标与任务修订");
  const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
  const original = h.app.storage.getTask.bind(h.app.storage);
  const revision = vi.spyOn(h.app.storage, "getTask").mockImplementation((id) => {
    const task = original(id);
    return task && id === run.taskId ? { ...task, revision: task.revision + 1 } : task;
  });
  expect(() => h.audit(run.runId)).toThrow("冻结目标与任务修订");
  revision.mockRestore();
  const changed = structuredClone(h.binding);
  changed.frozen.plan.frozenAt = Date.now() + 10000;
  expect(() => h.audit(run.runId, changed)).toThrow("清单摘要");
  changed.frozen = freezeAdaptivePlan(changed.frozen.plan);
  expect(() => h.audit(run.runId, changed)).toThrow("冻结后");
  const train = structuredClone(h.binding);
  train.caseId = "train-0";
  train.frozen.plan.cases.find((c) => c.id === train.caseId)!.taskDigest = digestOf(
    canonicalJson(train.task),
  );
  // 同一输入不能跨 split；改回原正式任务摘要后仅核验 train 用途的拒绝。
  train.frozen.plan.cases.find((c) => c.id === "formal-0")!.taskDigest =
    digestOf("another-formal-task");
  train.frozen = freezeAdaptivePlan(train.frozen.plan);
  expect(() => h.audit(run.runId, train)).toThrow("formal/regression");
});

it("缺失输入指纹保持 unavailable；正文或清单提供方不能补成可核验接受", async () => {
  const h = fixture();
  const run = await h.app.runtime.submitTask(h.submission, { purpose: "evaluation" });
  const original = h.app.storage.runEventsByType.bind(h.app.storage);
  vi.spyOn(h.app.storage, "runEventsByType").mockImplementation((id, type) =>
    original(id, type).map((event) =>
      type === "attempt.evidence.recorded"
        ? {
            ...event,
            payload: { evidence: { ...(event.payload["evidence"] as object), inputDigest: null } },
          }
        : event,
    ),
  );
  expect(h.audit(run.runId)).toMatchObject({
    status: "unavailable",
    taskInputVerification: "unavailable",
    verifiedAcceptance: false,
    unavailableInputs: [run.attempts[0]!.id],
    verification: { verifiedAcceptance: true },
  });
});

it("核验所有执行节点的输入，不能只检查最终产出 Attempt", async () => {
  const h = fixture();
  installCustomGenome(h.app, {
    graph: {
      schemaVersion: 1,
      kind: "dag-v1",
      nodes: [
        { id: "preflight", type: "execute", executor: "local-process", dependsOn: [] },
        { id: "stats", type: "execute", executor: "local-process", dependsOn: ["preflight"] },
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
  const run = await h.app.runtime.submitTask(
    { ...h.submission, budget: { ...h.submission.budget, maxAttempts: 2 } },
    { purpose: "evaluation" },
  );
  expect(run.state).toBe("succeeded");
  expect(h.audit(run.runId).verifiedInputs).toHaveLength(2);
  const first = h.app.storage.listAttempts(
    h.app.storage.listProcesses(run.runId).find((p) => p.nodeId === "preflight")!.id,
  )[0]!;
  const original = h.app.storage.runEventsByType.bind(h.app.storage);
  vi.spyOn(h.app.storage, "runEventsByType").mockImplementation((id, type) =>
    original(id, type).map((event) =>
      type === "attempt.evidence.recorded" && event.attemptId === first.id
        ? {
            ...event,
            payload: {
              evidence: {
                ...(event.payload["evidence"] as object),
                inputDigest: digestOf("different-preflight-input"),
              },
            },
          }
        : event,
    ),
  );
  expect(() => h.audit(run.runId)).toThrow("冻结任务实际输入");
});

it("嵌套 UTF-8 文件的纯投影与派发前真实目录摘要一致，额外空目录不会被忽略", async () => {
  const h = fixture();
  const root = join(h.dir, "nested");
  const inputs = [
    { name: "nested/z.txt", content: "中文 🚀\n" },
    { name: "nested/a/b.md", content: "# deeper\n" },
    { name: "nested/a.txt", content: "" },
    { name: "nested/notes.bin", content: "worker 不读取也必须计入\n" },
  ];
  for (const file of inputs) {
    const path = join(h.dir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  h.binding.task.inputs = inputs;
  h.binding.frozen.plan.cases.find((c) => c.id === "formal-0")!.taskDigest = digestOf(
    canonicalJson(h.binding.task),
  );
  h.binding.frozen.plan.cases.find((c) => c.id === "formal-0")!.evaluatorDigest = digestOf(
    canonicalJson({
      verifier: "stats-acceptance",
      outputSchemaDigest: digestOf(readFileSync(h.schema, "utf8")),
      expectedOutputDigest: null,
    }),
  );
  h.binding.frozen = freezeAdaptivePlan(h.binding.frozen.plan);
  const submission = {
    ...h.submission,
    inputs: [root],
    acceptance: { ...h.submission.acceptance, expectedOutput: undefined },
  };
  const run = await h.app.runtime.submitTask(submission, { purpose: "evaluation" });
  expect(run.state).toBe("succeeded");
  const proof = h.audit(run.runId);
  expect(proof.inputDigest).toBe(
    executionInputDigest(join(h.app.root, "workspaces", run.runId, "stats", "inputs")),
  );
  expect(proof.verifiedAcceptance).toBe(true);
  mkdirSync(join(root, "empty"));
  const withEmpty = await h.app.runtime.submitTask(submission, { purpose: "evaluation" });
  expect(withEmpty.state).toBe("succeeded");
  expect(() => h.audit(withEmpty.runId)).toThrow("冻结任务实际输入");
});

it.each([
  "../file",
  "/absolute",
  "a//b",
  "a/./b",
  "a/../b",
  "a\\b",
  "C:/file",
  "trailing/",
  "nul\0name",
])("非规范冻结路径 %j 不得归一化后冒充相同输入", (name) => {
  expect(() => adaptiveTaskInputDigest({ goal: "test", inputs: [{ name, content: "x" }] })).toThrow(
    "路径不合法",
  );
});

it("拒绝文件/目录重叠、重名、非法 UTF-8 及超额投影", () => {
  const projected = (inputs: Array<{ name: string; content: string }>) => ({
    goal: "test",
    inputs,
  });
  expect(() =>
    adaptiveTaskInputDigest(
      projected([
        { name: "a", content: "x" },
        { name: "a/b", content: "y" },
      ]),
    ),
  ).toThrow("文件与目录冲突");
  expect(() =>
    adaptiveTaskInputDigest(
      projected([
        { name: "a", content: "x" },
        { name: "a", content: "x" },
      ]),
    ),
  ).toThrow("重名");
  expect(() => adaptiveTaskInputDigest(projected([{ name: "a", content: "\ud800" }]))).toThrow(
    "UTF-8",
  );
  expect(() =>
    adaptiveTaskInputDigest(projected([{ name: "a", content: "x".repeat(4 * 1024 * 1024 + 1) }])),
  ).toThrow("4 MiB");
  expect(() =>
    adaptiveTaskInputDigest(
      projected(Array.from({ length: 513 }, (_, i) => ({ name: String(i), content: "" }))),
    ),
  ).toThrow("512");
});
