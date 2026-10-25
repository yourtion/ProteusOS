import type { Kernel } from "../../kernel/index.ts";
import { canonicalJson, digestOf, type BlobStore } from "../../storage/blobs.ts";
import type { Storage } from "../../storage/store.ts";
import { normalizeDag, parseGraph } from "../../runtime/graph.ts";
import {
  readJsonVerification,
  type StoredVerificationEvidence,
  type JsonVerificationRecord,
} from "../../runtime/verification-evidence.ts";
import type { StoredExecutionEvidence } from "../../runtime/execution-evidence.ts";
import { adaptiveTask, freezeAdaptivePlan, type FrozenAdaptivePlan } from "./adaptive.ts";
import { adaptiveTaskInputDigest } from "./task-input.ts";

export interface RunVerificationDeps {
  kernel: Kernel;
  storage: Storage;
  blobs: BlobStore;
  organismId: string;
  actorId: string;
}

interface AdaptiveRunTaskBinding {
  frozen: FrozenAdaptivePlan;
  caseId: string;
  task: unknown;
}

function equal(a: unknown, b: unknown, reason: string): void {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`Run 验收证据不匹配：${reason}`);
}

/** 只核验已经发生的 JSON 验收，不读取可变资料、不调模型、不构造正式 Evaluation。 */
export function auditRunVerification(deps: RunVerificationDeps, runId: string) {
  return deps.storage.tx(() => readRunVerification(deps, runId));
}

/** 验收与冻结任务在同一读事务核对；尚不证明预派发登记、策略臂或完整开销。 */
export function auditAdaptiveRunTask(
  deps: RunVerificationDeps,
  runId: string,
  binding: AdaptiveRunTaskBinding,
) {
  return deps.storage.tx(() => readAdaptiveRunTask(deps, runId, binding));
}

/** @internal 调用者须持有 Storage.tx，与其他只读核验组成同一提交单元。 */
export function readAdaptiveRunTask(
  deps: RunVerificationDeps,
  runId: string,
  binding: AdaptiveRunTaskBinding,
) {
  const verification = readRunVerification(deps, runId);
  const run = deps.storage.getRun(runId)!;
  const task = deps.storage.getTask(run.taskId)!;
  const { receipts, unexecuted } = verification;
  const executionEvents = deps.storage.runEventsByType(runId, "attempt.evidence.recorded");
  const frozen = freezeAdaptivePlan(binding.frozen.plan);
  equal(frozen.digest, binding.frozen.digest, "冻结清单摘要");
  const projected = adaptiveTask(frozen, binding.caseId, binding.task);
  const c = frozen.plan.cases.find((item) => item.id === binding.caseId)!;
  if (c.split !== "formal" && c.split !== "regression")
    throw new Error("正式 Run 任务核验只允许 formal/regression");
  if (run.purpose !== "evaluation" || run.createdAt < frozen.plan.frozenAt)
    throw new Error("正式 Run 必须在清单冻结后以 evaluation 用途执行");
  equal([task.goal, task.revision], [projected.goal, run.taskRevision], "冻结目标与任务修订");
  if (task.familyId && task.familyId !== c.familyId)
    throw new Error("任务 family 与冻结 case 冲突");
  const inputDigest = adaptiveTaskInputDigest(projected);
  const unavailableInputs: string[] = [];
  const verifiedInputs: string[] = [];
  const attempts = deps.storage
    .listProcesses(runId)
    .flatMap((process) =>
      deps.storage.listAttempts(process.id).map((attempt) => ({ process, attempt })),
    );
  const ids = new Set(attempts.map(({ attempt }) => attempt.id));
  if (executionEvents.some((event) => !event.attemptId || !ids.has(event.attemptId)))
    throw new Error("冻结任务出现孤立执行证据");
  for (const { process, attempt } of attempts) {
    const matches = executionEvents.filter((event) => event.attemptId === attempt.id);
    if (!matches.length) {
      unavailableInputs.push(attempt.id);
      continue;
    }
    if (matches.length !== 1) throw new Error("冻结任务 Attempt 证据重复");
    const event = matches[0]!;
    equal(
      [event.runId, event.processId, event.streamId],
      [run.id, process.id, `attempt-${attempt.id}`],
      "冻结任务执行证据归属",
    );
    if (event.organismId !== null && event.organismId !== deps.organismId)
      throw new Error("冻结任务执行证据个体归属冲突");
    const evidence = event.payload["evidence"] as StoredExecutionEvidence | undefined;
    if (!evidence) {
      unavailableInputs.push(attempt.id);
      continue;
    }
    equal(
      [evidence.version, evidence.attemptId, evidence.snapshotId, evidence.promptDigest],
      ["execution-evidence-v1", attempt.id, run.snapshotId, digestOf(projected.goal)],
      "冻结任务执行目标/快照",
    );
    if (evidence.inputDigest === null || evidence.inputDigest === undefined)
      unavailableInputs.push(attempt.id);
    else {
      equal(evidence.inputDigest, inputDigest, "冻结任务实际输入");
      verifiedInputs.push(attempt.id);
    }
  }
  for (const receipt of receipts)
    equal(receipt.evaluatorDigest, c.evaluatorDigest, "冻结任务独立裁判资料");
  const inputsVerified = !!attempts.length && !unavailableInputs.length;
  const evaluatorVerified = verification.status === "verified" && !unexecuted.length;
  const bound = {
    version: "adaptive-run-task-audit-v1" as const,
    scope: "frozen-task-and-json-verification" as const,
    manifestDigest: frozen.digest,
    caseId: c.id,
    familyId: c.familyId,
    split: c.split,
    taskDigest: c.taskDigest,
    evaluatorDigest: c.evaluatorDigest,
    inputDigest,
    status: inputsVerified && evaluatorVerified ? ("verified" as const) : ("unavailable" as const),
    taskInputVerification: inputsVerified ? ("verified" as const) : ("unavailable" as const),
    evaluatorVerification: evaluatorVerified ? ("verified" as const) : ("unavailable" as const),
    verifiedInputs,
    unavailableInputs,
    verifiedAcceptance: inputsVerified && evaluatorVerified && verification.verifiedAcceptance,
    verification,
    registrationVerification: "not_verified" as const,
    armVerification: "not_verified" as const,
    costVerification: "not_verified" as const,
    formalEvaluation: "not_run" as const,
  };
  return { ...bound, digest: digestOf(canonicalJson(bound)) };
}

function readRunVerification(deps: RunVerificationDeps, runId: string) {
  deps.kernel.assertOrganismAccess(deps.organismId, deps.actorId);
  const run = deps.storage.getRun(runId);
  if (!run || run.organismId !== deps.organismId) throw new Error("Run 不存在或属于其他个体");
  if (!["succeeded", "failed", "cancelled"].includes(run.state))
    throw new Error("Run 尚未终态，不能核验最终验收");
  const task = deps.storage.getTask(run.taskId);
  if (!task) throw new Error("Run 任务缺失");
  const snapshot = deps.kernel.resolveSnapshot(run.snapshotId);
  const content = (versionId: string) => {
    deps.kernel.assertVersionAccess(versionId, deps.actorId);
    const version = deps.storage.getArtifactVersion(versionId)!;
    const raw = deps.blobs.read(version.contentRef);
    if (digestOf(raw) !== version.contentDigest) throw new Error("Run 版本 blob 摘要漂移");
    return { version, raw };
  };
  for (const version of snapshot.versions.values()) content(version.id);
  const graphVersion = snapshot.versions.get("task-graph")!;
  const graphRaw = content(graphVersion.id).raw;
  equal(digestOf(graphRaw), run.graphDigest, "固定执行图");
  const graph = normalizeDag(parseGraph(graphRaw));
  const evaluator = content(
    run.evaluatorVersionId ?? snapshot.versions.get("acceptance-evaluator")!.id,
  ).version;
  equal(task.acceptance.verifier, evaluator.artifactId, "固定裁判产物");
  const verificationNodes = graph.nodes.filter((node) => node.type === "verify");
  const events = deps.storage.runEventsByType(runId, "verify.completed");
  const receipts: Array<{
    eventId: string;
    evidence: StoredVerificationEvidence;
    record: JsonVerificationRecord;
    attemptId: string;
    inputDigest: string | null;
    evaluatorDigest: string;
  }> = [];
  const seen = new Set<string>();
  const unavailable: string[] = [];
  const allChecks: JsonVerificationRecord["checks"] = [];
  const executionEvents = deps.storage.runEventsByType(runId, "attempt.evidence.recorded");
  for (const event of events) {
    const nodeId = event.payload["nodeId"];
    const node = verificationNodes.find((node) => node.id === nodeId);
    if (
      !node ||
      seen.has(node.id) ||
      event.streamId !== `run-${runId}` ||
      event.organismId !== deps.organismId
    )
      throw new Error("未知、重复或归属错误的验收事件");
    seen.add(node.id);
    const evidence = event.payload["evidence"] as StoredVerificationEvidence | undefined;
    if (
      !evidence ||
      evidence.version !== "verification-evidence-v1" ||
      evidence.status !== "available"
    ) {
      unavailable.push(node.id);
      continue;
    }
    const { record } = readJsonVerification(evidence, deps.blobs);
    equal(
      [record.runId, record.taskId, record.snapshotId, record.nodeId, record.inputFrom],
      [run.id, task.id, run.snapshotId, node.id, node.inputFrom],
      "Run/任务/快照/节点绑定",
    );
    equal(
      record.evaluator,
      {
        versionId: evaluator.id,
        contentRef: evaluator.contentRef,
        contentDigest: evaluator.contentDigest,
      },
      "生效裁判版本",
    );
    equal(
      [record.passed, record.checks],
      [event.payload["passed"], event.payload["checks"]],
      "验收事件与原始正文",
    );
    if (
      record.recordedAt < run.createdAt ||
      record.recordedAt > event.occurredAt ||
      event.occurredAt > run.updatedAt
    )
      throw new Error("验收时间不属于该 Run");
    equal(
      record.documents.expected !== null,
      !!task.acceptance.expectedOutput,
      "期望输出的使用合同",
    );
    const processes = deps.storage
      .listProcesses(runId)
      .filter((process) => process.nodeId === node.inputFrom);
    if (processes.length !== 1) throw new Error("验收输入执行节点不存在或歧义");
    const attempts = deps.storage.listAttempts(processes[0]!.id);
    const attempt = attempts.at(-1);
    if (!attempt || attempt.state !== "succeeded") throw new Error("验收输入未绑定成功 Attempt");
    const matches = executionEvents.filter((item) => item.attemptId === attempt.id);
    if (matches.length !== 1) throw new Error("Attempt 原始证据缺失或歧义");
    equal(
      [matches[0]!.streamId, matches[0]!.processId, matches[0]!.runId],
      [`attempt-${attempt.id}`, processes[0]!.id, runId],
      "执行证据事件归属",
    );
    if (matches[0]!.organismId !== null && matches[0]!.organismId !== deps.organismId)
      throw new Error("执行证据事件个体归属冲突");
    const execution = matches[0]!.payload["evidence"] as StoredExecutionEvidence;
    equal(
      [
        execution?.version,
        execution?.attemptId,
        execution?.snapshotId,
        execution?.promptDigest,
        execution?.outputDigest,
      ],
      [
        "execution-evidence-v1",
        attempt.id,
        run.snapshotId,
        digestOf(task.goal),
        record.documents.output.digest,
      ],
      "实际执行输出/任务与验收正文",
    );
    receipts.push({
      eventId: event.eventId,
      evidence,
      record,
      attemptId: attempt.id,
      inputDigest: execution.inputDigest,
      evaluatorDigest: digestOf(
        canonicalJson({
          verifier: task.acceptance.verifier,
          outputSchemaDigest: record.documents.schema.digest,
          expectedOutputDigest: record.documents.expected?.digest ?? null,
        }),
      ),
    });
    allChecks.push(...record.checks);
  }
  const unexecuted = verificationNodes.filter((node) => !seen.has(node.id)).map((node) => node.id);
  if (
    run.state === "succeeded" &&
    (unexecuted.length || receipts.some((receipt) => !receipt.record.passed))
  )
    throw new Error("成功 Run 与完整验收判定不一致");
  if (receipts.length && !unavailable.length) {
    const experience = deps.storage.getExperienceByRun(runId);
    if (!experience) throw new Error("终态 Run 缺少经验结案");
    equal(
      [experience.outcome.result, experience.outcome.checks],
      [run.state, allChecks],
      "最终结案与验收检查",
    );
    equal(
      experience.outcome.outputDigest,
      receipts.find((receipt) => receipt.record.passed)?.record.documents.output.digest ?? null,
      "结案输出摘要",
    );
  }
  const result = {
    version: "run-verification-audit-v1" as const,
    scope: "json-verification-only" as const,
    runId: run.id,
    taskId: task.id,
    snapshotId: run.snapshotId,
    purpose: run.purpose,
    runtimeState: run.state,
    status:
      receipts.length && !unavailable.length ? ("verified" as const) : ("unavailable" as const),
    runtimeAccepted: run.state === "succeeded",
    verifiedAcceptance: run.state === "succeeded" && !!receipts.length && !unavailable.length,
    receipts,
    unavailable,
    unexecuted,
    taskInputVerification: "not_verified" as const,
    formalEvaluation: "not_run" as const,
  };
  const verification = { ...result, digest: digestOf(canonicalJson(result)) };
  return verification;
}
