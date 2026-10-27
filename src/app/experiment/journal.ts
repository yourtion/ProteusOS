import type { Clock, IdGen, Kernel } from "../../kernel/index.ts";
import { canonicalJson, digestOf, type BlobStore } from "../../storage/blobs.ts";
import type { Storage } from "../../storage/store.ts";
import {
  adaptiveUnits,
  freezeAdaptivePlan,
  parseAdaptiveObservation,
  reportAdaptiveExperiment,
  type AdaptiveObservation,
  type FrozenAdaptivePlan,
} from "./adaptive.ts";
import type { AdaptiveJournalRecord, AdaptiveReservationRecord } from "./journal-types.ts";
import type { bindCompileDevelopment } from "./development.ts";
import { adaptiveRunIsClosed } from "./run-slots.ts";
import {
  summarizeReceiptResources,
  summarizeRuntimeItems,
  type AdaptiveRunReceipt,
} from "./run-receipt.ts";
import type { StoredExecutionEvidence } from "../../runtime/execution-evidence.ts";

interface JournalDeps {
  /** 在调用者的读/写事务内推导，无网络或额外事务。 */
  readRunReceipt?(id: string, reservationId: string): AdaptiveRunReceipt;
  kernel: Kernel;
  storage: Storage;
  blobs: BlobStore;
  clock: Clock;
  ids: IdGen;
  organismId: string;
  actorId: string;
  bindCompilation?(
    jobId: string,
    frozen: FrozenAdaptivePlan,
  ): ReturnType<typeof bindCompileDevelopment>;
}

/**
 * 串行实验的派发账本。它不发送请求，也不把宿主提供的收据升级为正式证据。
 * Host 只有在 start 成功提交后才能派发；prepared 可恢复，started 不可重发。
 */
export class AdaptiveJournal {
  private readonly deps: JournalDeps;
  constructor(deps: JournalDeps) {
    this.deps = deps;
  }

  private actor(): void {
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, this.deps.actorId);
  }

  private owned(id: string): AdaptiveJournalRecord {
    const job = this.deps.storage.getAdaptiveExperiment(id);
    if (!job || job.organismId !== this.deps.organismId)
      throw new Error("实验不存在或属于其他个体");
    return job;
  }

  private blob(ref: string, digest: string): unknown {
    const content = this.deps.blobs.read(ref);
    if (digestOf(content) !== digest) throw new Error("实验 blob 摘要漂移");
    return JSON.parse(content);
  }

  private inputs(job: AdaptiveJournalRecord) {
    const frozen = freezeAdaptivePlan(this.blob(job.manifestRef, job.manifestDigest));
    if (frozen.digest !== job.manifestDigest) throw new Error("manifest 摘要漂移");
    const raw = this.blob(job.developmentRef, job.developmentDigest);
    if (!Array.isArray(raw)) throw new Error("开发收据必须为数组");
    const development = raw.map(parseAdaptiveObservation);
    const units = adaptiveUnits(frozen.plan);
    const records = this.deps.storage.adaptiveReservations(job.id);
    const formal = units.filter((unit) => unit.repeat > 0);
    for (const [index, record] of records.entries()) {
      if (record.ordinal !== index || canonicalJson(record.unit) !== canonicalJson(formal[index]))
        throw new Error("执行预留与冻结单元不匹配");
      if (
        (record.state === "prepared" &&
          (record.startedAt !== null || record.deadlineAt !== null)) ||
        (record.state !== "prepared" &&
          (record.startedAt === null || record.deadlineAt === null)) ||
        (record.state === "completed" || record.state === "unknown") !==
          (record.observationRef !== null && record.observationDigest !== null)
      )
        throw new Error("执行预留状态不完整");
    }
    const observations = [
      ...development,
      ...records
        .filter((record) => record.observationRef !== null)
        .map((record) => {
          if (!record.observationDigest) throw new Error("收据缺少摘要");
          const row = parseAdaptiveObservation(
            this.blob(record.observationRef!, record.observationDigest),
          );
          if (row.unitId !== record.unit.id || row.startedAt !== record.startedAt)
            throw new Error("收据与派发绑定不匹配");
          return row;
        }),
    ];
    reportAdaptiveExperiment(frozen, observations);
    return { frozen, development, units, formal, records, observations };
  }

  private event(job: AdaptiveJournalRecord, type: string, payload: Record<string, unknown> = {}) {
    this.deps.storage.appendEvent({
      streamId: `adaptive-${job.id}`,
      organismId: job.organismId,
      type: `adaptive.${type}`,
      payload: { experimentId: job.id, ...payload },
      occurredAt: this.deps.clock.now(),
    });
  }

  register(frozen: FrozenAdaptivePlan, developmentInput: unknown[]): AdaptiveJournalRecord {
    return this.registerFrozen(frozen, developmentInput);
  }

  /** 开发来源与实验同事务提交；正式收据仍需另行核验。 */
  registerCompiled(frozen: FrozenAdaptivePlan, jobId: string): AdaptiveJournalRecord {
    this.actor();
    if (!this.deps.bindCompilation) throw new Error("未装配编译开发证据核验入口");
    const bound = this.deps.bindCompilation(jobId, frozen);
    return this.registerFrozen(
      frozen,
      bound.observations,
      {
        jobId,
        bundleDigest: bound.bundleDigest,
        auditDigest: bound.auditDigest,
      },
      bound.versionIds,
    );
  }

  private registerFrozen(
    frozen: FrozenAdaptivePlan,
    developmentInput: unknown[],
    compilationEvidence?: AdaptiveJournalRecord["compilationEvidence"],
    versionIds: string[] = [],
  ): AdaptiveJournalRecord {
    this.actor();
    const checked = freezeAdaptivePlan(frozen.plan);
    if (checked.digest !== frozen.digest) throw new Error("manifest 摘要漂移");
    if (checked.plan.budget.cost) throw new Error("账本尚无可验证的货币硬上限后端");
    const development = developmentInput.map(parseAdaptiveObservation);
    const planned = adaptiveUnits(checked.plan).filter((unit) => unit.repeat === 0);
    if (
      development.length !== planned.length ||
      development.some((row) => !planned.some((unit) => unit.id === row.unitId))
    )
      throw new Error("注册须完整固定全部开发收据，不能预填正式结果");
    development.sort(
      (a, b) =>
        planned.findIndex((unit) => unit.id === a.unitId) -
        planned.findIndex((unit) => unit.id === b.unitId),
    );
    const report = reportAdaptiveExperiment(checked, development);
    if (report.problems.length || report.open.length) throw new Error("开发收据未闭合或已超额");
    const manifestBlob = this.deps.blobs.write(canonicalJson(checked.plan));
    const developmentBlob = this.deps.blobs.write(canonicalJson(development));
    return this.deps.storage.tx(() => {
      this.actor();
      for (const versionId of versionIds)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      const existing = this.deps.storage
        .adaptiveExperiments(this.deps.organismId)
        .find((job) => job.manifestDigest === checked.digest);
      if (existing) {
        if (existing.developmentDigest !== developmentBlob.digest)
          throw new Error("同一清单不得替换开发收据");
        if (
          compilationEvidence &&
          canonicalJson(existing.compilationEvidence ?? null) !== canonicalJson(compilationEvidence)
        )
          throw new Error("同一实验不得替换或升级开发来源合同");
        return existing;
      }
      const now = this.deps.clock.now();
      if (now < checked.plan.frozenAt || development.some((row) => row.endedAt! > now))
        throw new Error("不能注册未来的冻结点或开发收据");
      const startedAt = Math.min(checked.plan.frozenAt, ...development.map((row) => row.startedAt));
      const job: AdaptiveJournalRecord = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        manifestDigest: checked.digest,
        manifestRef: manifestBlob.ref,
        developmentDigest: developmentBlob.digest,
        developmentRef: developmentBlob.ref,
        ...(compilationEvidence ? { compilationEvidence } : {}),
        state: "ready",
        createdBy: this.deps.actorId,
        createdAt: now,
        startedAt,
        deadlineAt: startedAt + checked.plan.budget.wallClockMs,
        error: null,
      };
      this.deps.storage.insertAdaptiveExperiment(job);
      this.event(job, "registered", {
        manifestDigest: job.manifestDigest,
        ...(compilationEvidence ? { compilationEvidence } : {}),
      });
      return job;
    });
  }

  job(id: string): AdaptiveJournalRecord {
    this.actor();
    return this.owned(id);
  }

  /** 应用组合入口：在外层事务之前重核来源，调用者在提交内再核对版本权限。 */
  verifySources(id: string): string[] {
    this.actor();
    return this.recheckCompilation(id);
  }

  /** 在外层事务之前只读核验，避免 SQLite 嵌套事务；封闭/恢复不依赖来源仍可访问。 */
  private recheckCompilation(id: string): string[] {
    const job = this.owned(id);
    if (!job.compilationEvidence) return [];
    if (!this.deps.bindCompilation) throw new Error("未装配编译开发证据核验入口");
    const frozen = freezeAdaptivePlan(this.blob(job.manifestRef, job.manifestDigest));
    const bound = this.deps.bindCompilation(job.compilationEvidence.jobId, frozen);
    if (
      bound.bundleDigest !== job.compilationEvidence.bundleDigest ||
      bound.auditDigest !== job.compilationEvidence.auditDigest
    )
      throw new Error("实验开发来源摘要漂移");
    const order = new Map(frozen.plan.development.map((unit, i) => [unit.id, i]));
    const observations = [...bound.observations].sort(
      (a, b) => order.get(a.unitId)! - order.get(b.unitId)!,
    );
    if (digestOf(canonicalJson(observations)) !== job.developmentDigest)
      throw new Error("实验开发收据与原始来源不匹配");
    return bound.versionIds;
  }

  /** 原预留幂等返回；每个实验至多一个在途单元，顺序由清单决定。 */
  prepare(id: string): AdaptiveReservationRecord | null {
    this.actor();
    const versionIds = ["ready", "running"].includes(this.owned(id).state)
      ? this.recheckCompilation(id)
      : [];
    return this.deps.storage.tx(() => {
      this.actor();
      for (const versionId of versionIds)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      const job = this.owned(id);
      if (job.state !== "ready" && job.state !== "running") return null;
      const { records, formal } = this.inputs(job);
      if (this.expired(job)) return null;
      const open = records.find((record) => record.state === "started");
      if (open) throw new Error("已有执行中的单元，不能并行派发");
      const prepared = records.find((record) => record.state === "prepared");
      if (prepared) return prepared;
      const unit = formal[records.length];
      if (!unit) {
        this.deps.storage.updateAdaptiveExperiment({ ...job, state: "completed" });
        this.event(job, "completed");
        return null;
      }
      const record: AdaptiveReservationRecord = {
        id: this.deps.ids.next(),
        experimentId: id,
        ordinal: records.length,
        unit,
        state: "prepared",
        preparedAt: this.deps.clock.now(),
        startedAt: null,
        deadlineAt: null,
        observationRef: null,
        observationDigest: null,
      };
      this.deps.storage.insertAdaptiveReservation(record);
      this.deps.storage.updateAdaptiveExperiment({ ...job, state: "running" });
      this.event(job, "reserved", { reservationId: record.id, unitId: unit.id });
      return record;
    });
  }

  /** 唯一派发许可；重复 start 抛错，调用方不得在提交前发送请求。 */
  start(id: string, reservationId: string): AdaptiveReservationRecord {
    this.actor();
    const versionIds = this.recheckCompilation(id);
    const result = this.deps.storage.tx(() => {
      this.actor();
      for (const versionId of versionIds)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      const job = this.owned(id);
      const { records } = this.inputs(job);
      const record = records.find((row) => row.id === reservationId);
      if (job.state !== "running" || !record || record.state !== "prepared")
        throw new Error("单元不处于可派发状态，禁止重发");
      if (this.expired(job)) return null;
      const now = this.deps.clock.now();
      const started = {
        ...record,
        state: "started" as const,
        startedAt: now,
        deadlineAt: Math.min(job.deadlineAt, now + record.unit.allowance.durationMs),
      };
      this.deps.storage.updateAdaptiveReservation(started);
      this.event(job, "started", { reservationId });
      return started;
    });
    if (!result) throw new Error("全轮截止点已到达");
    return result;
  }

  /**
   * 保存严格宿主收据。超额也保留原始收据并封闭实验，不能重试以覆盖坏结果。
   * 这里尚未核验 Runtime/DecisionCall/Attempt 的原始数据库证据。
   */
  complete(id: string, reservationId: string, input: unknown): AdaptiveReservationRecord {
    this.actor();
    const row = parseAdaptiveObservation(input);
    return this.deps.storage.tx(() => this.commitObservation(id, reservationId, row));
  }

  /** 从持久化运行证据推导并原子结案，不接受 caller 的 accepted/misrouted/usage。 */
  completeFromRuns(id: string, reservationId: string): AdaptiveReservationRecord {
    this.actor();
    const versions = this.recheckCompilation(id);
    return this.deps.storage.tx(() => {
      this.actor();
      for (const version of versions)
        this.deps.kernel.assertVersionAccess(version, this.deps.actorId);
      if (!this.deps.readRunReceipt) throw new Error("未装配原始 Run 收据核验入口");
      const evidence = this.deps.readRunReceipt(id, reservationId);
      const blob = this.deps.blobs.write(canonicalJson(evidence));
      return this.commitObservation(
        id,
        reservationId,
        parseAdaptiveObservation(evidence.observation),
        blob,
      );
    });
  }

  private commitObservation(
    id: string,
    reservationId: string,
    row: AdaptiveObservation,
    receipt?: { ref: string; digest: string },
  ): AdaptiveReservationRecord {
    const job = this.owned(id);
    const { frozen, records, observations } = this.inputs(job);
    const record = records.find((item) => item.id === reservationId);
    if (!record) throw new Error("未知执行预留");
    const content = canonicalJson(row);
    if (job.judgments && record.runPlan && !receipt)
      throw new Error("标签绑定的单元必须从原始 Run 结案，不能导入宿主成绩");
    if (record.observationDigest === digestOf(content)) {
      if (receipt && canonicalJson(record.runReceipt ?? null) !== canonicalJson(receipt))
        throw new Error("旧宿主收据不得事后升级原始证据");
      return record;
    }
    if (job.state !== "running" || record.state !== "started")
      throw new Error("单元已经封闭，不能替换结果或接纳迟到收据");
    if (record.runPlan) {
      const slots = this.deps.storage.adaptiveRunSlots(record.id);
      if (
        slots.length !== (record.unit.arm === "budget-matched" ? 3 : 1) ||
        slots.some(
          (slot) =>
            !slot.runId ||
            slot.state !== "started" ||
            !adaptiveRunIsClosed(this.deps.storage, slot.runId),
        )
      )
        throw new Error("绑定的 Run 槽位尚未全部结案，不能用宿主收据提前封闭或并行领取");
    }
    if (
      row.unitId !== record.unit.id ||
      row.startedAt !== record.startedAt ||
      row.endedAt === null ||
      row.endedAt > this.deps.clock.now()
    )
      throw new Error("收据与派发单元、时间不匹配");
    const report = reportAdaptiveExperiment(frozen, [...observations, row]);
    const blob = this.deps.blobs.write(content);
    const completed: AdaptiveReservationRecord = {
      ...record,
      ...(receipt ? { runReceipt: receipt } : {}),
      state: row.state === "unknown" ? "unknown" : "completed",
      observationRef: blob.ref,
      observationDigest: blob.digest,
    };
    this.deps.storage.updateAdaptiveReservation(completed);
    const error =
      row.state === "unknown"
        ? "执行结果 unknown，禁止补跑"
        : row.state === "cancelled"
          ? "执行单元已取消"
          : report.problems.length
            ? report.problems.join("; ")
            : this.deps.clock.now() >= job.deadlineAt
              ? "全轮截止点已到达"
              : this.deps.clock.now() >= record.deadlineAt!
                ? "执行单元截止点已到达"
                : null;
    const state = error
      ? row.state === "cancelled"
        ? "cancelled"
        : "failed"
      : report.missing.length
        ? "running"
        : "completed";
    this.deps.storage.updateAdaptiveExperiment({ ...job, state, error });
    this.event(job, "observed", { reservationId, observationDigest: blob.digest, state });
    return completed;
  }

  private expired(job: AdaptiveJournalRecord): boolean {
    const now = this.deps.clock.now();
    const unitExpired = this.deps.storage
      .adaptiveReservations(job.id)
      .some((record) => record.state === "started" && now >= record.deadlineAt!);
    if (now < job.deadlineAt && !unitExpired) return false;
    this.sealStarted(job, "unknown");
    this.deps.storage.updateAdaptiveExperiment({
      ...job,
      state: "failed",
      error: unitExpired ? "执行单元截止点已到达" : "全轮截止点已到达",
    });
    this.event(job, "expired");
    return true;
  }

  /** 已开始但无结果时封存 unknown；预留永不退款。调用者负责停止实际执行器。 */
  private sealStarted(job: AdaptiveJournalRecord, decision: "unknown" | "cancelled"): void {
    for (const record of this.deps.storage.adaptiveReservations(job.id)) {
      if (record.state !== "started") continue;
      const row: AdaptiveObservation = {
        unitId: record.unit.id,
        manifestDigest: job.manifestDigest,
        source: this.inputs(job).frozen.plan.mode,
        startedAt: record.startedAt!,
        endedAt: this.deps.clock.now(),
        state: "unknown",
        accepted: false,
        decision,
        misrouted: null,
        evidenceRefs: [
          `adaptive-reservation:${record.id}`,
          ...this.deps.storage.adaptiveRunSlots(record.id).flatMap((slot) =>
            slot.runId
              ? [
                  `run:${slot.runId}`,
                  ...this.deps.storage
                    .listDecisionCalls(slot.runId)
                    .map((call) => `decision:${call.id}`),
                  ...this.deps.storage
                    .listProcesses(slot.runId)
                    .flatMap((p) => this.deps.storage.listAttempts(p.id))
                    .map((attempt) => `attempt:${attempt.id}`),
                ]
              : [],
          ),
        ],
        usage: {
          modelCalls: null,
          inputTokens: null,
          outputTokens: null,
          costAmount: null,
          costCurrency: null,
          priceRef: null,
        },
      };
      const blob = this.deps.blobs.write(canonicalJson(row));
      this.deps.storage.updateAdaptiveReservation({
        ...record,
        state: "unknown",
        observationRef: blob.ref,
        observationDigest: blob.digest,
      });
    }
  }

  cancel(id: string): AdaptiveJournalRecord {
    this.actor();
    return this.deps.storage.tx(() => {
      const job = this.owned(id);
      if (job.state !== "ready" && job.state !== "running") return job;
      this.sealStarted(job, "cancelled");
      const cancelled = { ...job, state: "cancelled" as const, error: "操作者封闭实验" };
      this.deps.storage.updateAdaptiveExperiment(cancelled);
      this.event(job, "cancelled");
      return cancelled;
    });
  }

  /** 仅在旧 Host/执行器已停止后显式调用；不猜测远端是否已完成。 */
  recover(id: string): AdaptiveJournalRecord {
    this.actor();
    return this.deps.storage.tx(() => {
      const job = this.owned(id);
      if (job.state !== "ready" && job.state !== "running") return job;
      const { records, formal } = this.inputs(job);
      if (records.some((record) => record.state === "started")) {
        this.sealStarted(job, "unknown");
        const failed = {
          ...job,
          state: "failed" as const,
          error: "恢复发现 started，保留 unknown",
        };
        this.deps.storage.updateAdaptiveExperiment(failed);
        this.event(job, "recovered-unknown");
        return failed;
      }
      if (this.expired(job)) return this.owned(id);
      if (
        records.length === formal.length &&
        records.every((record) => record.state === "completed")
      )
        this.deps.storage.updateAdaptiveExperiment({ ...job, state: "completed" });
      this.event(job, "recovered");
      return this.owned(id);
    });
  }

  report(id: string) {
    this.actor();
    const versionIds = this.recheckCompilation(id);
    return this.deps.storage.tx(() => {
      this.actor();
      for (const versionId of versionIds)
        this.deps.kernel.assertVersionAccess(versionId, this.deps.actorId);
      return this.snapshot(id);
    });
  }

  private snapshot(id: string) {
    const job = this.owned(id);
    const { frozen, development, records, observations, units } = this.inputs(job);
    const receipts = records
      .filter((record) => record.runReceipt)
      .map((record) => {
        if (!this.deps.readRunReceipt) throw new Error("未装配原始 Run 收据核验入口");
        const raw = this.deps.blobs.read(record.runReceipt!.ref);
        if (digestOf(raw) !== record.runReceipt!.digest) throw new Error("原始 Run 收据摘要漂移");
        const actual = this.deps.readRunReceipt(id, record.id);
        if (
          canonicalJson(actual) !== raw ||
          digestOf(canonicalJson(actual.observation)) !== record.observationDigest
        )
          throw new Error("已提交收据与原始运行证据不一致");
        return actual;
      });
    const completeEvidence =
      receipts.length > 0 && receipts.length === units.filter((u) => u.repeat > 0).length;
    const unsettled: AdaptiveRunReceipt["resources"]["items"] = [];
    for (const record of records.filter((record) => record.runPlan && !record.runReceipt)) {
      for (const slot of this.deps.storage.adaptiveRunSlots(record.id)) {
        if (!slot.runId) continue;
        const run = this.deps.storage.getRun(slot.runId);
        if (!run || run.experimentId !== id || run.organismId !== this.deps.organismId)
          throw new Error("未结 Run 计量归属漂移");
        for (const call of this.deps.storage.listDecisionCalls(run.id))
          unsettled.push({
            ref: `decision:${call.id}`,
            kind: "decision",
            modelCalls: call.kind === "model" && call.sent ? 1 : 0,
            usage: call.usage,
          });
        const events = this.deps.storage.runEventsByType(run.id, "attempt.evidence.recorded");
        for (const attempt of this.deps.storage
          .listProcesses(run.id)
          .flatMap((process) => this.deps.storage.listAttempts(process.id))) {
          const matches = events.filter((event) => event.attemptId === attempt.id);
          if (matches.length > 1) throw new Error("未结 Attempt 计量证据重复");
          const evidence = matches[0]?.payload["evidence"] as StoredExecutionEvidence | undefined;
          unsettled.push({
            ref: `attempt:${attempt.id}`,
            kind: "execution",
            modelCalls: null,
            usage: evidence?.usage ?? null,
          });
        }
      }
    }
    const reservedUnits = units.filter(
      (unit) =>
        development.some((row) => row.unitId === unit.id) ||
        records.some((r) => r.unit.id === unit.id),
    );
    const reserved = Object.fromEntries(
      (["modelCalls", "inputTokens", "outputTokens", "durationMs"] as const).map((key) => [
        key,
        reservedUnits.reduce((sum, unit) => sum + unit.allowance[key], 0),
      ]),
    );
    return {
      job,
      reservations: records,
      observations,
      reserved,
      ...(receipts.length || job.judgments
        ? {
            evidence: {
              version: "adaptive-evidence-report-v1",
              receipts,
              runtimeResources: summarizeRuntimeItems([
                ...receipts.flatMap((r) => r.resources.items),
                ...unsettled,
              ]),
              settledResources: summarizeReceiptResources(receipts),
              unsettledResources: {
                ...summarizeRuntimeItems(unsettled),
                verification: "ledger-subtotals-only",
              },
              developmentResources: reportAdaptiveExperiment(frozen, development).resources,
              labelIndependence: "not_verified",
              formalEvaluation: "not_run",
            },
          }
        : {}),
      report: {
        ...reportAdaptiveExperiment(frozen, observations),
        // 在原始账本/裁判绑定桥接完成前，宿主导入不能支持真实收益或采用。
        benefit: frozen.plan.mode === "fixture" ? "not_evaluated" : "inconclusive",
        realModel: frozen.plan.mode === "fixture" ? "not_run" : "unknown",
        evidenceVerification:
          completeEvidence && job.compilationEvidence
            ? "persisted-development-and-runtime-records"
            : completeEvidence
              ? "persisted-runtime-records"
              : receipts.length
                ? "partial-persisted-runtime-records"
                : "unverified-host-receipts",
        developmentVerification: job.compilationEvidence
          ? "persisted-development-records"
          : "unverified-host-receipts",
        formalEvaluation: "not_run",
      },
    };
  }
}
