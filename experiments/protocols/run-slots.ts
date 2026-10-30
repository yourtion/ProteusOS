import type { ExperimentStorage } from "../storage.ts";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Clock } from "../../src/kernel/index.ts";
import { isTerminal, type Runtime, type TaskSubmission } from "../../src/runtime/index.ts";
import type { RunRecord } from "../../src/runtime/types.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { adaptiveTask, freezeAdaptivePlan, type FrozenAdaptivePlan } from "./adaptive.ts";
import { readAdaptiveArm, type ArmEvidenceInput } from "./arm-evidence.ts";
import { captureTaskProjection } from "./development.ts";
import type { AdaptiveJournal } from "./journal.ts";
import type { AdaptiveRunSlotRecord } from "./journal-types.ts";
import { adaptiveTaskInputDigest } from "./task-input.ts";
import type { RunVerificationDeps } from "./run-verification.ts";
import { deriveRunReceipt, parseJudgments } from "./run-receipt.ts";

interface SlotDeps extends RunVerificationDeps {
  storage: ExperimentStorage;
  clock: Clock;
  runtime: Runtime;
  journal: AdaptiveJournal;
}
export interface RunSlotPlanInput {
  task: ReturnType<typeof captureTaskProjection>;
  snapshots: ArmEvidenceInput["snapshots"];
  backend: ArmEvidenceInput["backend"];
  submission: TaskSubmission;
}
interface RunSlotPlan extends RunSlotPlanInput {
  judgmentsDigest?: string;
  version: "adaptive-run-plan-v1";
  experimentId: string;
  reservationId: string;
  manifestDigest: string;
  task: ReturnType<typeof captureTaskProjection>;
  sourceVersionIds: string[];
}
function equal(a: unknown, b: unknown, reason: string) {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`Run 槽位绑定不匹配：${reason}`);
}

/** 终态 Run 仍可能带未结远端调用或 Attempt，不能据此领取下一槽位。 */
export function adaptiveRunIsClosed(
  storage: RunVerificationDeps["storage"],
  runId: string,
): boolean {
  const run = storage.getRun(runId);
  return (
    !!run &&
    isTerminal(run.state) &&
    !storage
      .listDecisionCalls(runId)
      .some((call) => ["prepared", "started", "unknown"].includes(call.state)) &&
    storage
      .listProcesses(runId)
      .flatMap((process) => storage.listAttempts(process.id))
      .every((attempt) => ["succeeded", "failed", "cancelled"].includes(attempt.state))
  );
}

/** 与 Runtime 准入事务组合的派发前绑定；不发送请求，不产生正式成绩。 */
export class AdaptiveRunSlots {
  private readonly deps: SlotDeps;
  constructor(deps: SlotDeps) {
    this.deps = deps;
  }

  /** 路由标签必须在首个槽位合同绑定前固定；只进入受控 blob。 */
  registerJudgments(id: string, input: unknown) {
    const versionIds = this.deps.journal.verifySources(id);
    return this.deps.storage.tx(() => {
      this.deps.kernel.assertOrganismAccess(this.deps.organismId, this.deps.actorId);
      for (const version of versionIds)
        this.deps.kernel.assertVersionAccess(version, this.deps.actorId);
      const job = this.deps.storage.getAdaptiveExperiment(id);
      if (!job || job.organismId !== this.deps.organismId)
        throw new Error("实验不存在或属于其他个体");
      const frozen = freezeAdaptivePlan(JSON.parse(this.deps.blobs.read(job.manifestRef)));
      equal(frozen.digest, job.manifestDigest, "标签冻结清单");
      const doc = parseJudgments(frozen, input);
      const blob = this.deps.blobs.write(canonicalJson(doc));
      if (job.judgments) {
        equal(job.judgments, blob, "已冻结标签不得替换");
        return job.judgments;
      }
      if (frozen.plan.mode !== "fixture") throw new Error("真实标签独立性及预算合同尚未装配");
      if (
        !["ready", "running"].includes(job.state) ||
        this.deps.storage.adaptiveReservations(id).some((r) => r.runPlan || r.state !== "prepared")
      )
        throw new Error("路由标签必须在首个 Run 计划绑定前冻结，不能事后升级");
      this.deps.storage.updateAdaptiveExperiment({ ...job, judgments: blob });
      this.event(id, "judgments-frozen", {
        digest: blob.digest,
        actorId: this.deps.actorId,
        labelIndependence: "not_verified",
      });
      return blob;
    });
  }

  private context(id: string, reservationId: string) {
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, this.deps.actorId);
    const job = this.deps.storage.getAdaptiveExperiment(id);
    if (!job || job.organismId !== this.deps.organismId)
      throw new Error("实验不存在或属于其他个体");
    const reservation = this.deps.storage
      .adaptiveReservations(id)
      .find((r) => r.id === reservationId);
    if (!reservation) throw new Error("执行预留不存在");
    const raw = this.deps.blobs.read(job.manifestRef);
    const frozen = freezeAdaptivePlan(JSON.parse(raw));
    equal(frozen.digest, job.manifestDigest, "冻结清单");
    return { job, reservation, frozen };
  }

  private plan(id: string, reservationId: string) {
    const context = this.context(id, reservationId);
    if (!context.reservation.runPlan) throw new Error("预留没有派发前 Run 绑定合同");
    const raw = this.deps.blobs.read(context.reservation.runPlan.ref);
    equal(digestOf(raw), context.reservation.runPlan.digest, "Run 计划正文");
    const plan = JSON.parse(raw) as RunSlotPlan;
    equal(plan.judgmentsDigest ?? null, context.job.judgments?.digest ?? null, "派发前标签引用");
    equal(
      [plan.version, plan.experimentId, plan.reservationId, plan.manifestDigest],
      ["adaptive-run-plan-v1", id, reservationId, context.job.manifestDigest],
      "Run 计划身份",
    );
    const slots = this.deps.storage.adaptiveRunSlots(reservationId);
    const count = context.reservation.unit.arm === "budget-matched" ? 3 : 1;
    if (
      slots.length !== count ||
      slots.some((s, i) => s.ordinal !== i || s.reservationId !== reservationId)
    )
      throw new Error("Run 槽位缺失或顺序漂移");
    return { ...context, plan, slots };
  }

  private armInput(
    frozen: FrozenAdaptivePlan,
    unitId: string,
    plan: RunSlotPlan,
    runIds: Array<string | null>,
  ): ArmEvidenceInput {
    return {
      frozen,
      unitId,
      task: plan.task,
      snapshots: plan.snapshots,
      backend: plan.backend,
      runIds,
    };
  }

  private files(plan: RunSlotPlan, frozen: FrozenAdaptivePlan, caseId: string) {
    equal(
      captureTaskProjection(plan.submission),
      {
        ...plan.task,
        inputs: [...plan.task.inputs].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
      },
      "冻结输入/目标",
    );
    const acceptance = plan.submission.acceptance;
    const actual = digestOf(
      canonicalJson({
        verifier: acceptance.verifier,
        outputSchemaDigest: digestOf(readFileSync(acceptance.outputSchema, "utf8")),
        expectedOutputDigest: acceptance.expectedOutput
          ? digestOf(readFileSync(acceptance.expectedOutput, "utf8"))
          : null,
      }),
    );
    equal(actual, frozen.plan.cases.find((c) => c.id === caseId)!.evaluatorDigest, "独立裁判资料");
  }

  /** prepared 阶段原子固定所有槽位；旧 started/已结案收据不能事后升级。 */
  bind(id: string, reservationId: string, input: RunSlotPlanInput) {
    const sourceVersionIds = this.deps.journal.verifySources(id).sort();
    return this.deps.storage.tx(() => {
      const { job, reservation, frozen } = this.context(id, reservationId);
      for (const versionId of sourceVersionIds)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      if (frozen.plan.mode !== "fixture")
        throw new Error("真实 Run 槽位尚无受信模型/执行预算上界，禁止装配");
      for (const path of [
        ...input.submission.inputs,
        input.submission.acceptance.outputSchema,
        input.submission.acceptance.expectedOutput,
      ].filter((p): p is string => !!p))
        if (!isAbsolute(path)) throw new Error("槽位输入和裁判路径必须为绝对路径");
      if (
        input.submission.budget.maxAttempts !== 1 ||
        !Number.isInteger(input.submission.budget.maxWallClockSeconds) ||
        input.submission.budget.maxWallClockSeconds < 1
      )
        throw new Error("首轮每 Run 仅允许一次 Attempt 和正整数墙钟额度");
      const task = adaptiveTask(frozen, reservation.unit.caseId, input.task);
      adaptiveTaskInputDigest(task);
      const plan: RunSlotPlan = {
        ...(job.judgments ? { judgmentsDigest: job.judgments.digest } : {}),
        version: "adaptive-run-plan-v1",
        experimentId: id,
        reservationId,
        manifestDigest: frozen.digest,
        task,
        sourceVersionIds,
        snapshots: structuredClone(input.snapshots),
        backend: structuredClone(input.backend),
        submission: structuredClone(input.submission),
      };
      this.files(plan, frozen, reservation.unit.caseId);
      const count = reservation.unit.arm === "budget-matched" ? 3 : 1;
      readAdaptiveArm(
        this.deps,
        this.armInput(frozen, reservation.unit.id, plan, Array<string | null>(count).fill(null)),
      );
      if (job.judgments) {
        const raw = this.deps.blobs.read(job.judgments.ref);
        equal(digestOf(raw), job.judgments.digest, "标签正文");
        const labels = parseJudgments(frozen, JSON.parse(raw));
        const graph = this.deps.kernel
          .resolveSnapshot(plan.snapshots.base)
          .versions.get("task-graph")!;
        const nodes = JSON.parse(this.deps.blobs.read(graph.contentRef)) as {
          nodes: Array<{ type: string; options?: string[] }>;
        };
        const options = nodes.nodes.find((n) => n.type === "decision")!.options!;
        if (
          labels.cases.some((c) => c.expectedChoice !== null && !options.includes(c.expectedChoice))
        )
          throw new Error("冻结路由标签不属于固定 choice 选项");
      }
      const blob = this.deps.blobs.write(canonicalJson(plan));
      if (reservation.runPlan) {
        equal(reservation.runPlan, blob, "已冻结 Run 计划不得替换");
        return this.plan(id, reservationId).slots;
      }
      if (
        job.state !== "running" ||
        reservation.state !== "prepared" ||
        this.deps.clock.now() >= job.deadlineAt
      )
        throw new Error("Run 槽位只能在未过期 prepared 阶段绑定");
      this.deps.storage.updateAdaptiveReservation({ ...reservation, runPlan: blob });
      const slots = Array.from({ length: count }, (_, ordinal): AdaptiveRunSlotRecord => ({
        reservationId,
        ordinal,
        runId: null,
        state: "reserved",
        admittedAt: null,
        startedAt: null,
        admissionEventId: null,
        startEventId: null,
      }));
      for (const slot of slots) this.deps.storage.insertAdaptiveRunSlot(slot);
      this.event(id, "bound", { reservationId, planDigest: blob.digest, count });
      return slots;
    });
  }

  private event(
    id: string,
    type: string,
    payload: Record<string, unknown>,
    runId?: string,
    at = this.deps.clock.now(),
  ) {
    return this.deps.storage.appendEvent({
      streamId: `adaptive-${id}`,
      type: `adaptive.run-slot.${type}`,
      organismId: this.deps.organismId,
      ...(runId ? { runId } : {}),
      payload,
      occurredAt: at,
    }).eventId;
  }

  /** 只准入。Run/Task/预算与槽位同事务；再次调用返回原 Run，不执行它。 */
  admit(id: string, reservationId: string, ordinal: number) {
    const versionIds = this.deps.journal.verifySources(id);
    const context = this.deps.storage.tx(() => {
      const context = this.plan(id, reservationId);
      for (const versionId of versionIds)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      if (!context.slots[ordinal]) throw new Error("未知 Run 槽位序号");
      return context;
    });
    const existing = context.slots[ordinal]!;
    if (existing.runId) return this.deps.runtime.getRunSummary(existing.runId);
    const now = this.deps.clock.now();
    const seconds = Math.min(
      context.plan.submission.budget.maxWallClockSeconds,
      Math.floor(((context.reservation.deadlineAt ?? now) - now) / 1000),
    );
    if (seconds < 1) throw new Error("Run 槽位剩余期限不足，不能准入");
    const snapshotId =
      context.reservation.unit.arm === "compiled"
        ? context.plan.snapshots.compiled
        : context.plan.snapshots.base;
    const evaluatorVersionId = this.deps.kernel
      .resolveSnapshot(snapshotId)
      .versions.get("acceptance-evaluator")!.id;
    return this.deps.runtime.admitTask(
      { ...context.plan.submission, budget: { maxAttempts: 1, maxWallClockSeconds: seconds } },
      {
        purpose: "evaluation",
        snapshotId,
        evaluatorVersionId,
        experimentId: id,
        deadlineAt: context.reservation.deadlineAt!,
      },
      (runId) => {
        const fresh = this.plan(id, reservationId);
        const slot = fresh.slots[ordinal]!;
        if (slot.runId || slot.state !== "reserved") throw new Error("槽位已经准入，不能替换 Run");
        if (ordinal > 0) {
          const previous = fresh.slots[ordinal - 1]!;
          const run = previous.runId ? this.deps.storage.getRun(previous.runId) : undefined;
          if (
            !run ||
            previous.state !== "started" ||
            !adaptiveRunIsClosed(this.deps.storage, run.id)
          )
            throw new Error("前一槽位尚未明确结案，禁止并发或越序准入");
        }
        const admittedAt = this.deps.storage.getRun(runId)!.createdAt;
        const admissionEventId = this.event(
          id,
          "admitted",
          { reservationId, ordinal, planDigest: fresh.reservation.runPlan!.digest },
          runId,
          admittedAt,
        );
        this.deps.storage.updateAdaptiveRunSlot({
          ...slot,
          runId,
          state: "admitted",
          admittedAt,
          admissionEventId,
        });
      },
    );
  }

  /** Runtime 在自己的准入/启动/派发短事务内调用；没有绑定的旧实验保持原行为。 */
  guard(run: RunRecord, phase: "admit" | "start" | "dispatch") {
    if (!run.experimentId || !this.deps.storage.getAdaptiveExperiment(run.experimentId)) return;
    const slot = this.deps.storage.adaptiveRunSlotForRun(run.id);
    if (!slot) throw new Error("已注册实验的 Run 必须在准入事务中绑定槽位");
    const { job, reservation, frozen, plan } = this.plan(run.experimentId, slot.reservationId);
    if (
      job.state !== "running" ||
      reservation.state !== "started" ||
      this.deps.clock.now() >= reservation.deadlineAt!
    )
      throw new Error("实验或预留已封闭/过期，禁止派发");
    for (const versionId of plan.sourceVersionIds)
      this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
    readAdaptiveArm(
      this.deps,
      this.armInput(
        frozen,
        reservation.unit.id,
        plan,
        Array<string | null>(reservation.unit.arm === "budget-matched" ? 3 : 1).fill(null),
      ),
    );
    const snapshot =
      reservation.unit.arm === "compiled" ? plan.snapshots.compiled : plan.snapshots.base;
    const task = this.deps.storage.getTask(run.taskId)!;
    equal(
      [
        run.purpose,
        run.snapshotId,
        run.evaluatorVersionId,
        run.taskRevision,
        run.supersedesRunId,
        run.budget.maxAttempts,
      ],
      [
        "evaluation",
        snapshot,
        this.deps.kernel.resolveSnapshot(snapshot).versions.get("acceptance-evaluator")!.id,
        1,
        null,
        1,
      ],
      "准入 Run 合同",
    );
    equal(
      [task.requestedBy, task.requires, task.familyId ?? null],
      [
        plan.submission.requestedBy,
        plan.submission.requires ?? [],
        plan.submission.familyId ?? null,
      ],
      "任务准入元数据",
    );
    if (run.createdAt < reservation.startedAt! || run.deadlineAt > reservation.deadlineAt!)
      throw new Error("Run 不属于原预留时间窗口");
    this.files(
      {
        ...plan,
        submission: {
          ...plan.submission,
          goal: task.goal,
          inputs: task.inputs,
          acceptance: task.acceptance,
        },
      },
      frozen,
      reservation.unit.caseId,
    );
    if (phase === "start") {
      if (slot.state !== "admitted")
        throw new Error("Run 启动许可已经消耗，禁止重复启动或恢复重发");
      const startedAt = this.deps.clock.now();
      const startEventId = this.event(
        job.id,
        "started",
        {
          reservationId: reservation.id,
          ordinal: slot.ordinal,
          planDigest: reservation.runPlan!.digest,
        },
        run.id,
        startedAt,
      );
      this.deps.storage.updateAdaptiveRunSlot({
        ...slot,
        state: "started",
        startedAt,
        startEventId,
      });
    } else if (slot.state !== (phase === "admit" ? "admitted" : "started"))
      throw new Error("Run 槽位没有相应派发许可");
  }

  /** 只读核对准入事件和单次启动顺序，再用持久化槽位复算策略臂。 */
  audit(id: string, reservationId: string) {
    const versions = this.deps.journal.verifySources(id);
    return this.deps.storage.tx(() => {
      for (const versionId of versions)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      return this.readAudit(id, reservationId);
    });
  }

  /** @internal 调用者持有 Storage.tx，用于原始收据和报告的原子核验。 */
  readAudit(id: string, reservationId: string) {
    const { reservation, frozen, plan, slots } = this.plan(id, reservationId);
    for (const versionId of plan.sourceVersionIds)
      this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
    let previousSeq = -1;
    let previousEnd: number | null = null;
    let blocked = false;
    for (const slot of slots) {
      if (!slot.runId) {
        equal(
          [slot.state, slot.admittedAt, slot.startedAt, slot.admissionEventId, slot.startEventId],
          ["reserved", null, null, null, null],
          "未准入槽位",
        );
        blocked = true;
        continue;
      }
      if (blocked) throw new Error("槽位不能跳过尚未结案的前序绑定");
      const run = this.deps.storage.getRun(slot.runId);
      if (!run || run.experimentId !== id || run.organismId !== this.deps.organismId)
        throw new Error("槽位 Run 归属漂移");
      if (
        slot.state !== "started" &&
        (run.state === "running" ||
          this.deps.storage.listDecisionCalls(run.id).length ||
          this.deps.storage
            .listProcesses(run.id)
            .some((p) => this.deps.storage.listAttempts(p.id).length))
      )
        throw new Error("没有单次启动许可的槽位不能产生调用或执行");
      equal(
        [
          run.purpose,
          run.snapshotId,
          run.evaluatorVersionId,
          run.taskRevision,
          run.budget.maxAttempts,
        ],
        [
          "evaluation",
          reservation.unit.arm === "compiled" ? plan.snapshots.compiled : plan.snapshots.base,
          this.deps.kernel
            .resolveSnapshot(plan.snapshots.base)
            .versions.get("acceptance-evaluator")!.id,
          1,
          1,
        ],
        "槽位 Run 准入合同",
      );
      if (run.createdAt < reservation.startedAt! || run.deadlineAt > reservation.deadlineAt!)
        throw new Error("槽位 Run 时间窗口漂移");
      equal(slot.admittedAt, run.createdAt, "原子准入时间");
      const event = (eventId: string | null, type: string) => {
        const event = eventId ? this.deps.storage.eventById(eventId) : undefined;
        if (
          !event ||
          event.type !== `adaptive.run-slot.${type}` ||
          event.streamId !== `adaptive-${id}` ||
          event.runId !== run.id ||
          event.organismId !== this.deps.organismId ||
          event.seq <= previousSeq
        )
          throw new Error("槽位事件归属或顺序漂移");
        equal(
          event.payload,
          { reservationId, ordinal: slot.ordinal, planDigest: reservation.runPlan!.digest },
          "槽位事件合同",
        );
        previousSeq = event.seq;
        return event;
      };
      const admission = event(slot.admissionEventId, "admitted");
      equal(admission.occurredAt, slot.admittedAt, "准入事件时间");
      if (previousEnd !== null && run.createdAt < previousEnd) throw new Error("槽位并发或越序");
      if (slot.state === "started")
        equal(event(slot.startEventId, "started").occurredAt, slot.startedAt, "单次启动时间");
      else if (slot.state !== "admitted" || slot.startedAt !== null || slot.startEventId !== null)
        throw new Error("槽位启动状态漂移");
      previousEnd = run.updatedAt;
      if (slot.state !== "started" || !adaptiveRunIsClosed(this.deps.storage, run.id))
        blocked = true;
    }
    const pending = slots.some(
      (s) => s.runId && !isTerminal(this.deps.storage.getRun(s.runId)!.state),
    );
    const arm = pending
      ? null
      : readAdaptiveArm(
          this.deps,
          this.armInput(
            frozen,
            reservation.unit.id,
            plan,
            slots.map((s) => s.runId),
          ),
        );
    const result = {
      version: "adaptive-run-slots-audit-v1" as const,
      experimentId: id,
      reservationId,
      manifestDigest: frozen.digest,
      planDigest: reservation.runPlan!.digest,
      slots,
      registrationVerification: "persisted-admission-bindings" as const,
      orderVerification: "persisted-single-start-order" as const,
      status: pending ? ("incomplete" as const) : arm!.status,
      arm,
      evidenceVerification: "unverified-host-receipts" as const,
      formalEvaluation: "not_run" as const,
    };
    return { ...result, digest: digestOf(canonicalJson(result)) };
  }

  /** @internal 无副作用的证据推导；与 Journal 结果提交/报告共用读事务。 */
  deriveReceipt(id: string, reservationId: string) {
    const { job, reservation, frozen, plan, slots } = this.plan(id, reservationId);
    if (!job.judgments || plan.judgmentsDigest !== job.judgments.digest)
      throw new Error("缺少派发前冻结的独立路由标签绑定");
    const raw = this.deps.blobs.read(job.judgments.ref);
    equal(digestOf(raw), job.judgments.digest, "标签正文");
    const labels = parseJudgments(frozen, JSON.parse(raw));
    if (
      slots.some(
        (s) =>
          !s.runId || s.state !== "started" || !adaptiveRunIsClosed(this.deps.storage, s.runId),
      )
    )
      throw new Error("原始收据的槽位尚未明确结案");
    const proof = this.readAudit(id, reservationId);
    // 许可选项来自固定执行图，标签不允许制造额外可执行选项。
    const graph = this.deps.kernel.resolveSnapshot(plan.snapshots.base).versions.get("task-graph")!;
    const nodes = JSON.parse(this.deps.blobs.read(graph.contentRef)) as {
      nodes: Array<{ type: string; options?: string[] }>;
    };
    const label = labels.cases.find((c) => c.caseId === reservation.unit.caseId)!;
    if (
      label.expectedChoice !== null &&
      !nodes.nodes.find((n) => n.type === "decision")?.options?.includes(label.expectedChoice)
    )
      throw new Error("冻结路由标签不属于固定 choice 选项");
    const endedAt = Math.max(...slots.map((s) => this.deps.storage.getRun(s.runId!)!.updatedAt));
    return deriveRunReceipt(proof, labels, job.judgments.digest, reservation.startedAt!, endedAt);
  }

  /** 串行执行一单元；只有本调用取得 start 后才有权在失败时封存它。 */
  async runNext(
    id: string,
    load: (caseId: string) => RunSlotPlanInput | Promise<RunSlotPlanInput>,
  ) {
    const prepared = this.deps.journal.prepare(id);
    if (!prepared) return null;
    if (!this.deps.storage.getAdaptiveExperiment(id)?.judgments)
      throw new Error("自动运行前须冻结独立路由标签");
    let claimed = false;
    try {
      if (!prepared.runPlan) this.bind(id, prepared.id, await load(prepared.unit.caseId));
      this.deps.journal.start(id, prepared.id);
      claimed = true;
      const slots = this.deps.storage.adaptiveRunSlots(prepared.id);
      for (const slot of slots) {
        const admitted = this.admit(id, prepared.id, slot.ordinal);
        await this.deps.runtime.executeRun(admitted.runId);
        if (!adaptiveRunIsClosed(this.deps.storage, admitted.runId))
          throw new Error("执行留下未结调用或 Attempt，停止本轮且不补跑");
      }
      return this.deps.journal.completeFromRuns(id, prepared.id);
    } catch (error) {
      if (claimed) {
        // 先封闭账本阻止新派发，再停止已准入但未终态的 Runtime；绝不恢复发送。
        this.deps.journal.recover(id);
        for (const slot of this.deps.storage.adaptiveRunSlots(prepared.id))
          if (slot.runId && !isTerminal(this.deps.storage.getRun(slot.runId)!.state))
            await this.deps.runtime.cancel(slot.runId);
      }
      throw error;
    }
  }

  /** 运行至清单结束或首个不可恢复错误；不自动重试任何已开始单元。 */
  async runAll(id: string, load: (caseId: string) => RunSlotPlanInput | Promise<RunSlotPlanInput>) {
    while (await this.runNext(id, load)) {
      /* prepare 只会领取下一个冻结单元。 */
    }
    return this.deps.journal.report(id);
  }
}
