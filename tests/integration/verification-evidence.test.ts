import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { openInstance } from "../../src/app/instance.ts";
import { auditRunVerification } from "../../src/app/experiment/run-verification.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  persistJsonVerification,
  readJsonVerification,
  type StoredVerificationEvidence,
} from "../../src/runtime/verification-evidence.ts";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

const opened: AppInstance[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of opened.splice(0)) app.close();
});

function fixture() {
  const app = bootSeededInstance();
  opened.push(app);
  const dir = join(app.root, "materials");
  mkdirSync(dir);
  const input = join(dir, "sample.md");
  const schema = join(dir, "schema.json");
  const expected = join(dir, "expected.json");
  writeFileSync(input, "# A\nhello world\n");
  writeFileSync(schema, readFileSync(fixturePath("schemas", "stats-summary.schema.json")));
  const stats = { bytes: 16, lines: 2, words: 4, headings: 1 };
  writeFileSync(
    expected,
    canonicalJson({ files: [{ path: "sample.md", ...stats }], totals: { files: 1, ...stats } }),
  );
  const task = {
    requestedBy: "principal-local",
    goal: "统计文本",
    inputs: [input],
    budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
    acceptance: { outputSchema: schema, expectedOutput: expected, verifier: "stats-acceptance" },
  };
  const evidence = (runId: string) =>
    app.storage.listEvents({ runId }, 1000).find((e) => e.type === "verify.completed")!.payload[
      "evidence"
    ] as StoredVerificationEvidence;
  const audit = (runId: string) =>
    auditRunVerification(
      { ...app, organismId: "organism-default", actorId: "principal-local" },
      runId,
    );
  return { app, dir, task, evidence, audit };
}

it("持久化当时实际读取的 JSON 文档与裁判版本；删除原文件/工作区后仍可重开复算", async () => {
  const h = fixture();
  const run = await h.app.runtime.submitTask(h.task);
  expect(run.state).toBe("succeeded");
  const evidence = h.evidence(run.runId);
  const replay = readJsonVerification(evidence, h.app.blobs);
  expect(replay.record).toMatchObject({
    runId: run.runId,
    taskId: run.taskId,
    snapshotId: run.snapshotId,
    nodeId: "check",
    inputFrom: "stats",
    algorithm: "stats-acceptance-v1",
    passed: true,
  });
  expect(replay.evaluation.checks).toEqual(run.checks);
  const audit = h.audit(run.runId);
  expect(audit).toMatchObject({
    status: "verified",
    runtimeAccepted: true,
    verifiedAcceptance: true,
    scope: "json-verification-only",
    taskInputVerification: "not_verified",
    formalEvaluation: "not_run",
  });
  expect(replay.record.documents.expected!.digest).toBe(
    digestOf(readFileSync(h.task.acceptance.expectedOutput, "utf8")),
  );
  rmSync(h.dir, { recursive: true });
  rmSync(join(h.app.root, "workspaces"), { recursive: true });
  const reopened = openInstance(h.app.root);
  opened.push(reopened);
  expect(readJsonVerification(evidence, reopened.blobs)).toEqual(replay);
  expect(
    auditRunVerification(
      { ...reopened, organismId: "organism-default", actorId: "principal-local" },
      run.runId,
    ),
  ).toEqual(audit);
});

it("真实负结果原样复算；不能仅改 passed/checks 或损坏正文来生成正面证明", async () => {
  const h = fixture();
  writeFileSync(h.task.acceptance.expectedOutput, "{}");
  const run = await h.app.runtime.submitTask(h.task);
  expect(run.state).toBe("failed");
  const evidence = h.evidence(run.runId);
  const replay = readJsonVerification(evidence, h.app.blobs);
  expect(replay.evaluation.passed).toBe(false);
  expect(h.audit(run.runId)).toMatchObject({
    status: "verified",
    runtimeAccepted: false,
    verifiedAcceptance: false,
  });
  expect(evidence.status).toBe("available");
  if (evidence.status !== "available") throw new Error("missing evidence");
  const forged = h.app.blobs.write(canonicalJson({ ...replay.record, passed: true }));
  expect(() => readJsonVerification({ ...evidence, ...forged }, h.app.blobs)).toThrow(
    "verification_verdict_mismatch",
  );
  writeFileSync(join(h.app.root, "blobs", replay.record.documents.schema.ref), "{}");
  expect(() => readJsonVerification(evidence, h.app.blobs)).toThrow("digest_mismatch");
});

it("证据落盘失败不改变验收结果或重派 worker，状态明确为 failed", async () => {
  const h = fixture();
  const write = h.app.blobs.write.bind(h.app.blobs);
  vi.spyOn(h.app.blobs, "write").mockImplementation((raw) => {
    if (raw.includes('"version":"json-verification-evidence-v1"')) throw new Error("disk-full");
    return write(raw);
  });
  const run = await h.app.runtime.submitTask(h.task);
  expect(run.state).toBe("succeeded");
  expect(h.evidence(run.runId)).toMatchObject({
    status: "failed",
    reason: "verification_evidence_persistence_failed",
  });
  expect(() => readJsonVerification(h.evidence(run.runId), h.app.blobs)).toThrow("unavailable");
  expect(run.attempts).toHaveLength(1);
  expect(h.audit(run.runId)).toMatchObject({
    status: "unavailable",
    runtimeAccepted: true,
    verifiedAcceptance: false,
  });
});

it("旧 pipeline 保持原 stats 判据，不把无新增证据的旧路径升级为 JSON 证明", async () => {
  const h = fixture();
  installCustomGenome(h.app, {
    graph: {
      schemaVersion: 1,
      kind: "pipeline-v1",
      nodes: [{ id: "stats", type: "execute", executor: "local-process" }],
    },
  });
  const run = await h.app.runtime.submitTask(h.task);
  expect(run.state).toBe("succeeded");
  expect(
    h.app.storage
      .listEvents({ runId: run.runId }, 1000)
      .filter((event) => event.type === "verify.completed"),
  ).toHaveLength(0);
  expect(run.checks.every((check) => check.passed)).toBe(true);
  expect(h.audit(run.runId)).toMatchObject({
    status: "unavailable",
    runtimeAccepted: true,
    verifiedAcceptance: false,
  });
});

it("test-runner 结果保持原样，但明确不提供可重放 JSON 裁判证据", async () => {
  const h = fixture();
  installCustomGenome(h.app, {
    graph: {
      schemaVersion: 2,
      kind: "dag-v1",
      nodes: [
        { id: "stats", type: "execute", executor: "local-process", dependsOn: [] },
        {
          id: "check",
          type: "verify",
          verifier: "coding-acceptance",
          inputFrom: "stats",
          dependsOn: ["stats"],
        },
      ],
    },
    evaluator: { kind: "test-runner-v1", command: [process.execPath, "-e", "process.exit(0)"] },
  });
  const run = await h.app.runtime.submitTask({
    ...h.task,
    acceptance: { ...h.task.acceptance, verifier: "coding-acceptance" },
  });
  expect(run.state).toBe("succeeded");
  expect(run.checks.map((c) => c.name)).toEqual(["tests"]);
  expect(h.evidence(run.runId)).toMatchObject({
    status: "unavailable",
    reason: "test_runner_not_json",
  });
  expect(h.audit(run.runId)).toMatchObject({
    status: "unavailable",
    runtimeAccepted: true,
    verifiedAcceptance: false,
  });
});

it("正文超出证据上限时不截断、不伪造空证明", async () => {
  const h = fixture();
  const snapshot = h.app.kernel.resolveSnapshot(
    h.app.kernel.getOrganism("organism-default")!.activeGenomeId!,
  );
  const evaluator = snapshot.versions.get("acceptance-evaluator")!;
  const result = persistJsonVerification(
    h.app.blobs,
    {
      runId: "oversized",
      taskId: "task",
      snapshotId: snapshot.snapshot.id,
      nodeId: "check",
      inputFrom: "stats",
      evaluator: {
        versionId: evaluator.id,
        contentRef: evaluator.contentRef,
        contentDigest: evaluator.contentDigest,
      },
      algorithm: "stats-acceptance-v1",
      passed: false,
      checks: [],
      recordedAt: Date.now(),
    },
    {
      output: "x".repeat(4 * 1024 * 1024 + 1),
      schema: "{}",
      expected: null,
    },
  );
  expect(result).toEqual({
    version: "verification-evidence-v1",
    status: "unavailable",
    reason: "json_documents_exceed_4_mib",
  });
});

it("其他 Run 的有效正文不能被换绑为当前 Run 的验收证据", async () => {
  const h = fixture();
  const first = await h.app.runtime.submitTask(h.task);
  const second = await h.app.runtime.submitTask(h.task);
  const otherEvidence = h.evidence(second.runId);
  const original = h.app.storage.runEventsByType.bind(h.app.storage);
  vi.spyOn(h.app.storage, "runEventsByType").mockImplementation((id, type) => {
    const events = original(id, type);
    return id === first.runId && type === "verify.completed"
      ? events.map((event) => ({
          ...event,
          payload: { ...event.payload, evidence: otherEvidence },
        }))
      : events;
  });
  expect(() => h.audit(first.runId)).toThrow("Run/任务/快照/节点绑定");
});

it("重复验收事件不能按最后一条覆盖；旧事件缺少正文时只报告 unavailable", async () => {
  const h = fixture();
  const run = await h.app.runtime.submitTask(h.task);
  const original = h.app.storage.runEventsByType.bind(h.app.storage);
  const legacy = vi.spyOn(h.app.storage, "runEventsByType").mockImplementation((id, type) =>
    original(id, type).map((event) => {
      if (type !== "verify.completed") return event;
      const { evidence: _evidence, ...payload } = event.payload;
      return { ...event, payload };
    }),
  );
  expect(h.audit(run.runId)).toMatchObject({
    status: "unavailable",
    runtimeAccepted: true,
    verifiedAcceptance: false,
  });
  legacy.mockRestore();
  const event = original(run.runId, "verify.completed")[0]!;
  h.app.storage.tx(() =>
    h.app.storage.appendEvent({
      streamId: event.streamId,
      type: event.type,
      payload: event.payload,
      runId: run.runId,
      organismId: "organism-default",
      occurredAt: Date.now(),
    }),
  );
  expect(() => h.audit(run.runId)).toThrow("重复");
});

it("正文复算还需与 Attempt 实际输出以及最终经验结案一致", async () => {
  const h = fixture();
  const run = await h.app.runtime.submitTask(h.task);
  const experience = h.app.storage.getExperienceByRun(run.runId)!;
  h.app.storage.tx(() =>
    h.app.storage.insertExperience({
      ...experience,
      outcome: { ...experience.outcome, checks: [] },
    }),
  );
  expect(() => h.audit(run.runId)).toThrow("最终结案与验收检查");
  h.app.storage.tx(() => h.app.storage.insertExperience(experience));
  const original = h.app.storage.runEventsByType.bind(h.app.storage);
  vi.spyOn(h.app.storage, "runEventsByType").mockImplementation((id, type) =>
    original(id, type).map((event) =>
      type === "attempt.evidence.recorded"
        ? {
            ...event,
            payload: {
              evidence: {
                ...(event.payload["evidence"] as object),
                outputDigest: digestOf("different-worker-output"),
              },
            },
          }
        : event,
    ),
  );
  expect(() => h.audit(run.runId)).toThrow("实际执行输出/任务与验收正文");
});

it("评估 Run 使用显式钉住的 hybrid 裁判，核验不能退回快照默认裁判", async () => {
  const h = fixture();
  const snapshotId = h.app.kernel.getOrganism("organism-default")!.activeGenomeId!;
  const base = h.app.kernel.resolveSnapshot(snapshotId).versions.get("acceptance-evaluator")!;
  const blob = h.app.blobs.write(canonicalJson({ schemaVersion: 1, kind: "hybrid-acceptance-v1" }));
  const pinned = h.app.storage.tx(() =>
    h.app.kernel.registerVersion({
      artifact: h.app.storage.getArtifact(base.artifactId)!,
      schemaVersion: 1,
      contentRef: blob.ref,
      contentDigest: blob.digest,
      parents: [base.id],
      dependencies: [],
      createdBy: "principal-local",
    }),
  );
  const run = await h.app.runtime.submitTask(h.task, {
    purpose: "evaluation",
    snapshotId,
    evaluatorVersionId: pinned.id,
  });
  expect(run.state).toBe("succeeded");
  const audit = h.audit(run.runId);
  expect(audit).toMatchObject({
    status: "verified",
    purpose: "evaluation",
    verifiedAcceptance: true,
  });
  expect(audit.receipts[0]!.record).toMatchObject({
    algorithm: "hybrid-acceptance-v1",
    evaluator: { versionId: pinned.id },
  });
  expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(snapshotId);
});

it("核验有当前权限和终态要求，不生成额外执行或正式 Evaluation", async () => {
  const h = fixture();
  const run = await h.app.runtime.submitTask(h.task);
  expect(() =>
    auditRunVerification(
      { ...h.app, organismId: "organism-default", actorId: "absent" },
      run.runId,
    ),
  ).toThrow();
  h.app.storage.tx(() =>
    h.app.storage.updateRunState(run.runId, "running", { updatedAt: Date.now() }),
  );
  expect(() => h.audit(run.runId)).toThrow("尚未终态");
  expect(
    h.app.storage.listProcesses(run.runId).flatMap((p) => h.app.storage.listAttempts(p.id)),
  ).toHaveLength(1);
});
