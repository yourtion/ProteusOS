import type { PublicationRecord, ImportRecord } from "../federation/types.ts";
import type {
  PublicationKey,
  RegistryCredential,
  SignedShareEnvelope,
} from "../federation/trust.ts";
import type { SQLInputValue } from "node:sqlite";
import type {
  ArtifactVersion,
  GenomeSnapshot,
  KernelStore,
  AccessAction,
  ExternalVersionRef,
} from "../kernel/index.ts";
import type { PromotionRecord } from "../kernel/index.ts";
import type {
  LearningCallRecord,
  CandidateRecord,
  ConsolidationJobRecord,
  ConsolidationJobState,
  EvaluationRecord,
  ExperienceDatasetPurpose,
  ExperienceDatasetRecord,
  ValidationSetRecord,
} from "../evolution/types.ts";
import type {
  AttemptRecord,
  AttemptState,
  BudgetEntryKind,
  DispatchRecord,
  EventAppend,
  EventRecord,
  ExperienceRecord,
  ProcessRecord,
  RunPurpose,
  RunRecord,
  RunState,
  RuntimeStore,
  TaskAcceptance,
  TaskBudget,
  TaskRecord,
} from "../runtime/types.ts";
import type { DecisionCallRecord } from "../decision/call.ts";
import type { SqliteDb } from "./sqlite.ts";
import type {
  ArtifactRow,
  AttemptRow,
  CandidateRow,
  DecisionCallLimitRow,
  DecisionCallRow,
  DispatchRow,
  EvaluationRow,
  ConsolidationJobRow,
  ExperienceDatasetRow,
  ValidationSetRow,
  EventRow,
  ExperienceRow,
  OrganismRow,
  PrincipalRow,
  ProcessRow,
  PromotionRow,
  RunRow,
  SnapshotRow,
  TaskRow,
  VersionRow,
} from "./rows.ts";

/**
 * SQLite 实现：KernelStore 与 RuntimeStore 的唯一实现。
 * 所有写方法必须在 Storage.tx 内调用（单 writer + 事务由调用方组合）。
 */
export class Storage implements KernelStore, RuntimeStore {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }

  // ---- KernelStore：身份 ----

  insertPrincipal(p: { id: string; kind: string; createdAt: number }): void {
    this.db.run(
      "INSERT OR IGNORE INTO principals (id, kind, created_at) VALUES (?, ?, ?)",
      p.id,
      p.kind,
      p.createdAt,
    );
  }

  getPrincipal(id: string) {
    const row = this.db.get<PrincipalRow>("SELECT * FROM principals WHERE id = ?", id);
    return row
      ? { id: row.id, kind: row.kind as "user" | "organism" | "team", createdAt: row.created_at }
      : undefined;
  }

  insertOrganism(o: {
    id: string;
    ownerId: string;
    scope: string;
    activeGenomeId: string | null;
    revision: number;
    createdAt: number;
  }): void {
    this.db.run(
      "INSERT OR IGNORE INTO organisms (id, owner_id, scope, active_genome_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      o.id,
      o.ownerId,
      o.scope,
      o.activeGenomeId,
      o.revision,
      o.createdAt,
    );
  }

  getOrganism(id: string) {
    const row = this.db.get<OrganismRow>("SELECT * FROM organisms WHERE id = ?", id);
    return row
      ? {
          id: row.id,
          ownerId: row.owner_id,
          scope: row.scope,
          activeGenomeId: row.active_genome_id,
          revision: row.revision,
          createdAt: row.created_at,
        }
      : undefined;
  }

  insertLineage(l: { id: string; ownerId: string; scope: string; createdAt: number }): void {
    this.db.run(
      "INSERT OR IGNORE INTO lineages (id, owner_id, scope, created_at) VALUES (?, ?, ?, ?)",
      l.id,
      l.ownerId,
      l.scope,
      l.createdAt,
    );
  }

  getLineage(id: string) {
    const row = this.db.get<{ id: string; owner_id: string; scope: string; created_at: number }>(
      "SELECT * FROM lineages WHERE id = ?",
      id,
    );
    return row
      ? { id: row.id, ownerId: row.owner_id, scope: row.scope, createdAt: row.created_at }
      : undefined;
  }

  hasAccessGrant(scope: string, principalId: string, action: AccessAction): boolean {
    return !!this.db.get(
      "SELECT 1 FROM access_grants WHERE scope = ? AND principal_id = ? AND action = ?",
      scope,
      principalId,
      action,
    );
  }

  deleteAccessGrant(scope: string, principalId: string, action: AccessAction): boolean {
    return (
      this.db.run(
        "DELETE FROM access_grants WHERE scope = ? AND principal_id = ? AND action = ?",
        scope,
        principalId,
        action,
      ) > 0
    );
  }

  insertAccessGrant(
    scope: string,
    principalId: string,
    action: AccessAction,
    grantedBy: string,
    createdAt: number,
  ): void {
    this.db.run(
      "INSERT OR IGNORE INTO access_grants VALUES (?, ?, ?, ?, ?)",
      scope,
      principalId,
      action,
      grantedBy,
      createdAt,
    );
  }

  getExternalVersionRef(id: string): ExternalVersionRef | undefined {
    const r = this.db.get<{
      id: string;
      content_digest: string;
      lineage_id: string;
      publication_digest: string;
    }>("SELECT * FROM external_version_refs WHERE id = ?", id);
    return r
      ? {
          id: r.id,
          contentDigest: r.content_digest,
          lineageId: r.lineage_id,
          publicationDigest: r.publication_digest,
        }
      : undefined;
  }

  isImportedVersion(id: string): boolean {
    return !!this.db.get(
      "SELECT 1 FROM shared_imports i, json_each(i.versions) v WHERE v.value = ?",
      id,
    );
  }

  insertExternalVersionRef(ref: ExternalVersionRef): void {
    const existing = this.getArtifactVersion(ref.id) ?? this.getExternalVersionRef(ref.id);
    if (
      existing &&
      (existing.contentDigest !== ref.contentDigest || existing.lineageId !== ref.lineageId)
    )
      throw new Error("外部版本标识与已知版本冲突");
    this.db.run(
      "INSERT OR IGNORE INTO external_version_refs VALUES (?, ?, ?, ?)",
      ref.id,
      ref.contentDigest,
      ref.lineageId,
      ref.publicationDigest,
    );
  }

  findSnapshotByBindings(bindings: Record<string, string>): GenomeSnapshot | undefined {
    const keys = Object.keys(bindings).sort();
    return this.db
      .all<SnapshotRow>("SELECT * FROM genome_snapshots")
      .map(mapSnapshot)
      .find(
        (s) =>
          Object.keys(s.bindings).length === keys.length &&
          keys.every((k) => s.bindings[k] === bindings[k]),
      );
  }

  listOrganisms(actor: string) {
    return this.db
      .all<OrganismRow>(
        "SELECT * FROM organisms WHERE owner_id = ? OR id IN (SELECT substr(scope,10) FROM access_grants WHERE principal_id = ? AND scope LIKE 'organism:%') ORDER BY created_at, id",
        actor,
        actor,
      )
      .map((row) => this.getOrganism(row.id)!);
  }

  // ---- KernelStore：版本与快照 ----

  insertArtifact(a: {
    id: string;
    kind: string;
    lineageId: string;
    ownerId: string;
    createdAt: number;
  }): void {
    this.db.run(
      "INSERT OR IGNORE INTO artifacts (id, kind, lineage_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
      a.id,
      a.kind,
      a.lineageId,
      a.ownerId,
      a.createdAt,
    );
  }

  getArtifact(id: string) {
    const row = this.db.get<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", id);
    return row
      ? {
          id: row.id,
          kind: row.kind,
          lineageId: row.lineage_id,
          ownerId: row.owner_id,
          createdAt: row.created_at,
        }
      : undefined;
  }

  insertArtifactVersion(v: ArtifactVersion): "inserted" | "exists" {
    const changes = this.db.run(
      `INSERT OR IGNORE INTO artifact_versions
       (id, artifact_id, lineage_id, schema_version, content_digest, content_ref, parents, dependencies, created_by, created_at, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.id,
      v.artifactId,
      v.lineageId,
      v.schemaVersion,
      v.contentDigest,
      v.contentRef,
      JSON.stringify(v.parents),
      JSON.stringify(v.dependencies),
      v.createdBy,
      v.createdAt,
      v.scope ?? `principal:${this.getArtifact(v.artifactId)?.ownerId ?? v.createdBy}`,
    );
    return changes === 1 ? "inserted" : "exists";
  }

  getArtifactVersion(id: string): ArtifactVersion | undefined {
    const row = this.db.get<VersionRow>("SELECT * FROM artifact_versions WHERE id = ?", id);
    return row ? mapVersion(row) : undefined;
  }

  findArtifactVersionByDigest(
    artifactId: string,
    digest: string,
    scope?: string,
  ): ArtifactVersion | undefined {
    const row = this.db.get<VersionRow>(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? AND content_digest = ? ${scope ? "AND scope = ?" : ""}`,
      artifactId,
      digest,
      ...(scope ? [scope] : []),
    );
    return row ? mapVersion(row) : undefined;
  }

  insertSnapshot(s: GenomeSnapshot): "inserted" | "exists" {
    const changes = this.db.run(
      "INSERT OR IGNORE INTO genome_snapshots (id, digest, bindings, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      s.id,
      s.digest,
      JSON.stringify(s.bindings),
      s.createdBy,
      s.createdAt,
    );
    return changes === 1 ? "inserted" : "exists";
  }

  findSnapshotByDigest(digest: string): GenomeSnapshot | undefined {
    const row = this.db.get<SnapshotRow>("SELECT * FROM genome_snapshots WHERE digest = ?", digest);
    return row ? mapSnapshot(row) : undefined;
  }

  getSnapshot(id: string): GenomeSnapshot | undefined {
    const row = this.db.get<SnapshotRow>("SELECT * FROM genome_snapshots WHERE id = ?", id);
    return row ? mapSnapshot(row) : undefined;
  }

  setActiveGenome(
    organismId: string,
    snapshotId: string,
    expectedRevision: number,
  ): { ok: true; revision: number } | { ok: false; reason: "conflict" } {
    const changes = this.db.run(
      "UPDATE organisms SET active_genome_id = ?, revision = revision + 1 WHERE id = ? AND revision = ?",
      snapshotId,
      organismId,
      expectedRevision,
    );
    if (changes === 1) return { ok: true, revision: expectedRevision + 1 };
    const organism = this.getOrganism(organismId);
    if (!organism) throw new Error(`organism ${organismId} 不存在`);
    return { ok: false, reason: "conflict" };
  }

  // ---- RuntimeStore：task / run ----

  insertTask(t: TaskRecord): void {
    this.db.run(
      `INSERT INTO tasks (id, revision, requested_by, goal, inputs, budget, acceptance, requires, created_at, family_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      t.revision,
      t.requestedBy,
      t.goal,
      JSON.stringify(t.inputs),
      JSON.stringify(t.budget),
      JSON.stringify(t.acceptance),
      JSON.stringify(t.requires),
      t.createdAt,
      t.familyId ?? null,
    );
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    return row
      ? {
          id: row.id,
          revision: row.revision,
          requestedBy: row.requested_by,
          goal: row.goal,
          familyId: row.family_id,
          inputs: JSON.parse(row.inputs) as string[],
          budget: JSON.parse(row.budget) as TaskBudget,
          acceptance: JSON.parse(row.acceptance) as TaskAcceptance,
          requires: JSON.parse(row.requires) as string[],
          createdAt: row.created_at,
        }
      : undefined;
  }

  insertRun(r: RunRecord): void {
    this.db.run(
      `INSERT INTO runs (id, task_id, task_revision, organism_id, purpose, snapshot_id, graph_digest, state, supersedes_run_id, budget, failure_reason, missing_capabilities, waiting_until, evaluator_version_id, deadline_at, experiment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.taskId,
      r.taskRevision,
      r.organismId,
      r.purpose,
      r.snapshotId,
      r.graphDigest,
      r.state,
      r.supersedesRunId,
      JSON.stringify(r.budget),
      r.failureReason,
      r.missingCapabilities ? JSON.stringify(r.missingCapabilities) : null,
      r.waitingUntil,
      r.evaluatorVersionId,
      r.deadlineAt,
      r.experimentId,
      r.createdAt,
      r.updatedAt,
    );
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
    return row ? mapRun(row) : undefined;
  }

  listRuns(limit: number, organismId?: string): Array<RunRecord & { goal: string }> {
    const rows = this.db.all<RunRow & { goal: string }>(
      `SELECT runs.*, tasks.goal AS goal FROM runs JOIN tasks ON tasks.id = runs.task_id
       ${organismId ? "WHERE runs.organism_id = ?" : ""} ORDER BY runs.created_at DESC LIMIT ?`,
      ...(organismId ? [organismId, limit] : [limit]),
    );
    return rows.map((row) => ({ ...mapRun(row), goal: row.goal }));
  }

  listRunsByStates(states: RunState[], limit: number, organismId?: string): RunRecord[] {
    const placeholders = states.map(() => "?").join(", ");
    return this.db
      .all<RunRow>(
        `SELECT * FROM runs WHERE state IN (${placeholders}) ${organismId ? "AND organism_id = ?" : ""} ORDER BY created_at LIMIT ?`,
        ...states,
        ...(organismId ? [organismId] : []),
        limit,
      )
      .map(mapRun);
  }

  updateRunState(
    id: string,
    state: RunState,
    patch: { failureReason?: string | null; updatedAt: number },
  ): void {
    this.db.run(
      "UPDATE runs SET state = ?, failure_reason = COALESCE(?, failure_reason), updated_at = ? WHERE id = ?",
      state,
      patch.failureReason ?? null,
      patch.updatedAt,
      id,
    );
  }

  // ---- RuntimeStore：process / attempt ----

  insertProcess(p: ProcessRecord): void {
    this.db.run(
      "INSERT INTO processes (id, run_id, node_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      p.id,
      p.runId,
      p.nodeId,
      p.role,
      p.createdAt,
    );
  }

  listProcesses(runId: string): ProcessRecord[] {
    return this.db
      .all<ProcessRow>("SELECT * FROM processes WHERE run_id = ? ORDER BY created_at", runId)
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        nodeId: row.node_id,
        role: row.role,
        createdAt: row.created_at,
      }));
  }

  findProcessByNode(runId: string, nodeId: string): ProcessRecord | undefined {
    const row = this.db.get<ProcessRow>(
      "SELECT * FROM processes WHERE run_id = ? AND node_id = ? ORDER BY created_at LIMIT 1",
      runId,
      nodeId,
    );
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          nodeId: row.node_id,
          role: row.role,
          createdAt: row.created_at,
        }
      : undefined;
  }

  insertAttempt(a: AttemptRecord): void {
    this.db.run(
      `INSERT INTO attempts (id, process_id, ordinal, dispatch_id, state, handle, started_at, ended_at, exit_code, output_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.processId,
      a.ordinal,
      a.dispatchId,
      a.state,
      a.handle,
      a.startedAt,
      a.endedAt,
      a.exitCode,
      a.outputRef,
    );
  }

  updateAttempt(
    id: string,
    patch: Partial<Pick<AttemptRecord, "state" | "handle" | "endedAt" | "exitCode" | "outputRef">>,
  ): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, column] of [
      ["state", "state"],
      ["handle", "handle"],
      ["endedAt", "ended_at"],
      ["exitCode", "exit_code"],
      ["outputRef", "output_ref"],
    ] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(patch[key]);
      }
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE attempts SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  listAttempts(processId: string): AttemptRecord[] {
    return this.db
      .all<AttemptRow>("SELECT * FROM attempts WHERE process_id = ? ORDER BY ordinal", processId)
      .map(mapAttempt);
  }

  // ---- RuntimeStore：experience / budget / events / outbox ----

  insertExperience(e: ExperienceRecord): void {
    // 一个 Run 一条经验（run_id 唯一）；operator 回退后重新结案时覆盖投影，
    // 原始过程仍完整保留在事件流中
    this.db.run(
      `INSERT INTO experiences (id, run_id, outcome, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET outcome = excluded.outcome, created_at = excluded.created_at`,
      e.id,
      e.runId,
      JSON.stringify(e.outcome),
      e.createdAt,
    );
  }

  getExperienceByRun(runId: string): ExperienceRecord | undefined {
    const row = this.db.get<ExperienceRow>("SELECT * FROM experiences WHERE run_id = ?", runId);
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          outcome: JSON.parse(row.outcome),
          createdAt: row.created_at,
        }
      : undefined;
  }

  appendBudget(
    id: string,
    runId: string,
    organismId: string,
    kind: BudgetEntryKind,
    attempts: number,
    seconds: number,
    at: number,
  ): void {
    this.db.run(
      "INSERT INTO budget_ledger (id, run_id, organism_id, kind, attempts, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      runId,
      organismId,
      kind,
      attempts,
      seconds,
      at,
    );
  }

  countActiveRuns(organismId: string, scope?: RunPurpose): number {
    const purposeFilter = scope ? " AND purpose = ?" : "";
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM runs WHERE organism_id = ? AND state IN ('pending', 'running', 'waiting')${purposeFilter}`,
      ...(scope ? [organismId, scope] : [organismId]),
    )!;
    return row.n;
  }

  inFlightBudget(organismId: string, scope?: RunPurpose): { attempts: number; seconds: number } {
    const purposeFilter = scope ? " AND purpose = ?" : "";
    const row = this.db.get<{ attempts: number; seconds: number }>(
      `SELECT COALESCE(SUM(attempts), 0) AS attempts, COALESCE(SUM(seconds), 0) AS seconds
       FROM budget_ledger
       WHERE kind = 'reserve'
         AND run_id IN (
           SELECT id FROM runs WHERE organism_id = ? AND state IN ('pending', 'running', 'waiting')${purposeFilter}
         )`,
      ...(scope ? [organismId, scope] : [organismId]),
    )!;
    return { attempts: row.attempts, seconds: row.seconds };
  }

  appendEvent(e: EventAppend): { eventId: string; seq: number } {
    const seqRow = this.db.get<{ n: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE stream_id = ?",
      e.streamId,
    )!;
    const eventId = `${e.streamId}/${seqRow.n}`;
    this.db.run(
      `INSERT INTO events (event_id, stream_id, seq, type, schema_version, correlation_id, causation_id, organism_id, run_id, process_id, attempt_id, payload, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      e.streamId,
      seqRow.n,
      e.type,
      e.correlationId ?? null,
      e.causationId ?? null,
      e.organismId ?? null,
      e.runId ?? null,
      e.processId ?? null,
      e.attemptId ?? null,
      JSON.stringify(e.payload),
      e.occurredAt,
      e.occurredAt,
    );
    return { eventId, seq: seqRow.n };
  }

  listEvents(filter: { runId?: string; streamId?: string }, limit: number): EventRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.runId) {
      conditions.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.streamId) {
      conditions.push("stream_id = ?");
      params.push(filter.streamId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    return this.db
      .all<EventRow>(
        `SELECT * FROM events ${where} ORDER BY recorded_at, stream_id, seq LIMIT ?`,
        ...params,
      )
      .map(mapEvent);
  }

  hasCancelIntent(runId: string): boolean {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.cancel_requested'",
      runId,
    )!;
    return row.n > 0;
  }

  insertDispatch(d: DispatchRecord): void {
    this.db.run(
      `INSERT INTO outbox (dispatch_id, run_id, process_id, attempt_id, kind, payload, state, handle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.dispatchId,
      d.runId,
      d.processId,
      d.attemptId,
      d.kind,
      JSON.stringify(d.payload),
      d.state,
      d.handle,
      d.createdAt,
    );
  }

  getDispatch(dispatchId: string): DispatchRecord | undefined {
    const row = this.db.get<DispatchRow>("SELECT * FROM outbox WHERE dispatch_id = ?", dispatchId);
    return row ? mapDispatch(row) : undefined;
  }

  markDispatched(dispatchId: string, handle: string, at: number): void {
    this.db.run(
      "UPDATE outbox SET state = 'dispatched', handle = ?, dispatched_at = ? WHERE dispatch_id = ?",
      handle,
      at,
      dispatchId,
    );
  }

  completeDispatch(dispatchId: string, at: number): void {
    this.db.run(
      "UPDATE outbox SET state = 'completed', completed_at = ? WHERE dispatch_id = ?",
      at,
      dispatchId,
    );
  }

  listDispatches(state?: DispatchRecord["state"]): DispatchRecord[] {
    return state
      ? this.db.all<DispatchRow>("SELECT * FROM outbox WHERE state = ?", state).map(mapDispatch)
      : this.db.all<DispatchRow>("SELECT * FROM outbox").map(mapDispatch);
  }

  // ---- 本体决策实验：决策调用账本与额度（ADR 0007 §4.2/§4.3）----

  insertDecisionCall(call: DecisionCallRecord): void {
    this.db.run(
      `INSERT INTO decision_calls (id, experiment_id, run_id, node_id, snapshot_id, kind, state, sent, provider, policy_version_id, view_version_id, request_ref, request_digest, response_ref, response_digest, provenance, usage, error_class, started_at, ended_at, duration_ms, late_arrival, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      call.id,
      call.experimentId,
      call.runId,
      call.nodeId,
      call.snapshotId,
      call.kind,
      call.state,
      call.sent ? 1 : 0,
      call.provider,
      call.policyVersionId,
      call.viewVersionId,
      call.requestRef,
      call.requestDigest,
      call.responseRef,
      call.responseDigest,
      JSON.stringify(call.provenance),
      call.usage === null ? null : JSON.stringify(call.usage),
      call.errorClass,
      call.startedAt,
      call.endedAt,
      call.durationMs,
      call.lateArrival ? 1 : 0,
      call.createdAt,
      call.updatedAt,
    );
  }

  getDecisionCall(id: string): DecisionCallRecord | undefined {
    const row = this.db.get<DecisionCallRow>("SELECT * FROM decision_calls WHERE id = ?", id);
    return row ? mapDecisionCall(row) : undefined;
  }

  findDecisionCall(runId: string, nodeId: string): DecisionCallRecord | undefined {
    const row = this.db.get<DecisionCallRow>(
      "SELECT * FROM decision_calls WHERE run_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1",
      runId,
      nodeId,
    );
    return row ? mapDecisionCall(row) : undefined;
  }

  listDecisionCalls(runId: string): DecisionCallRecord[] {
    return this.db
      .all<DecisionCallRow>(
        "SELECT * FROM decision_calls WHERE run_id = ? ORDER BY created_at",
        runId,
      )
      .map(mapDecisionCall);
  }

  updateDecisionCall(
    id: string,
    patch: Partial<
      Pick<
        DecisionCallRecord,
        | "state"
        | "sent"
        | "responseRef"
        | "responseDigest"
        | "usage"
        | "errorClass"
        | "startedAt"
        | "endedAt"
        | "durationMs"
        | "lateArrival"
      >
    >,
    opts: { updatedAt: number },
  ): void {
    const columns: Array<[string, unknown]> = [
      ["state", patch.state],
      ["sent", patch.sent === undefined ? undefined : patch.sent ? 1 : 0],
      ["response_ref", patch.responseRef],
      ["response_digest", patch.responseDigest],
      [
        "usage",
        patch.usage === undefined
          ? undefined
          : patch.usage === null
            ? null
            : JSON.stringify(patch.usage),
      ],
      ["error_class", patch.errorClass],
      ["started_at", patch.startedAt],
      ["ended_at", patch.endedAt],
      ["duration_ms", patch.durationMs],
      ["late_arrival", patch.lateArrival === undefined ? undefined : patch.lateArrival ? 1 : 0],
      ["updated_at", opts.updatedAt],
    ];
    const sets = columns.filter(([, v]) => v !== undefined);
    if (sets.length === 0) return;
    this.db.run(
      `UPDATE decision_calls SET ${sets.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`,
      ...sets.map(([, v]) => v as SQLInputValue),
      id,
    );
  }

  countDecisionQuotaCalls(scope: { organismId: string; experimentId?: string | null }): number {
    // 消耗/预留 = 已发送（sent=1）或仍处 prepared 的 model 调用；
    // prepared 未发送即取消（cancelled + sent=0）不计数
    if (scope.experimentId) {
      const row = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM decision_calls dc JOIN runs r ON r.id = dc.run_id
         WHERE dc.kind = 'model' AND dc.experiment_id = ? AND r.organism_id = ? AND (dc.sent = 1 OR dc.state = 'prepared')`,
        scope.experimentId,
        scope.organismId,
      )!;
      return row.n;
    }
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM decision_calls dc
         JOIN runs r ON r.id = dc.run_id
         WHERE dc.kind = 'model' AND r.organism_id = ? AND (dc.sent = 1 OR dc.state = 'prepared')`,
      scope.organismId,
    )!;
    return row.n;
  }

  setDecisionCallLimit(
    scope: { organismId: string; experimentId?: string | null },
    maxCalls: number,
    at: number,
  ): void {
    this.db.run(
      "INSERT INTO decision_call_limits (scope, max_calls, created_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET max_calls = excluded.max_calls",
      decisionLimitScope(scope),
      maxCalls,
      at,
    );
  }

  getDecisionCallLimit(scope: {
    organismId: string;
    experimentId?: string | null;
  }): number | undefined {
    const row = this.db.get<DecisionCallLimitRow>(
      "SELECT * FROM decision_call_limits WHERE scope = ?",
      decisionLimitScope(scope),
    );
    return row?.max_calls;
  }

  // ---- Evolution：candidate / evaluation / promotion（M2）----

  insertCandidate(c: CandidateRecord): void {
    this.db.run(
      `INSERT INTO candidates (id, organism_id, base_snapshot_id, base_revision, proposed_snapshot_id, hypothesis, proposed_by, source_refs, dataset_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id,
      c.organismId,
      c.baseSnapshotId,
      c.baseRevision,
      c.proposedSnapshotId,
      c.hypothesis,
      c.proposedBy,
      JSON.stringify(c.sourceRefs),
      c.datasetRef,
      c.createdAt,
    );
  }

  getCandidate(id: string): CandidateRecord | undefined {
    const row = this.db.get<CandidateRow>("SELECT * FROM candidates WHERE id = ?", id);
    return row ? mapCandidate(row) : undefined;
  }

  findCandidateByProposedSnapshot(organismId: string, proposedSnapshotId: string) {
    const row = this.db.get<CandidateRow>(
      "SELECT * FROM candidates WHERE organism_id = ? AND proposed_snapshot_id = ? ORDER BY created_at LIMIT 1",
      organismId,
      proposedSnapshotId,
    );
    return row ? mapCandidate(row) : undefined;
  }

  listCandidates(organismId: string, limit: number): CandidateRecord[] {
    return this.db
      .all<CandidateRow>(
        "SELECT * FROM candidates WHERE organism_id = ? ORDER BY created_at DESC LIMIT ?",
        organismId,
        limit,
      )
      .map(mapCandidate);
  }

  insertEvaluation(e: EvaluationRecord): void {
    this.db.run(
      `INSERT INTO evaluations (id, candidate_id, protocol_digest, baseline_snapshot_id, runs, verdict, metrics, dataset_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id,
      e.candidateId,
      e.protocolDigest,
      e.baselineSnapshotId,
      JSON.stringify(e.runs),
      e.verdict,
      JSON.stringify({
        metrics: e.metrics,
        policy: e.policy ?? null,
        policyEvidence: e.policyEvidence ?? null,
        datasetSplitRefs: e.datasetSplitRefs ?? null,
      }),
      e.datasetRef ?? null,
      e.createdAt,
    );
  }

  getEvaluation(id: string): EvaluationRecord | undefined {
    const row = this.db.get<EvaluationRow>("SELECT * FROM evaluations WHERE id = ?", id);
    return row ? mapEvaluation(row) : undefined;
  }

  listEvaluationsByCandidate(candidateId: string, limit: number): EvaluationRecord[] {
    return this.db
      .all<EvaluationRow>(
        "SELECT * FROM evaluations WHERE candidate_id = ? ORDER BY created_at DESC LIMIT ?",
        candidateId,
        limit,
      )
      .map(mapEvaluation);
  }

  // ---- M3：冻结经验集 ----

  insertExperienceDataset(d: ExperienceDatasetRecord): void {
    this.db.run(
      `INSERT INTO experience_datasets (id, digest, purpose, cutoff_at, member_experience_ids, member_digest, filter_version, permission_scope, created_by, created_at, organism_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id,
      d.digest,
      d.purpose,
      d.cutoffAt,
      JSON.stringify(d.memberExperienceIds),
      d.memberDigest,
      d.filterVersion,
      d.permissionScope,
      d.createdBy,
      d.createdAt,
      d.organismId,
    );
    for (const experienceId of d.memberExperienceIds) {
      this.db.run("INSERT INTO experience_dataset_members VALUES (?, ?)", d.id, experienceId);
    }
  }

  getExperienceDataset(id: string): ExperienceDatasetRecord | undefined {
    const row = this.db.get<ExperienceDatasetRow>(
      "SELECT * FROM experience_datasets WHERE id = ?",
      id,
    );
    return row ? mapExperienceDataset(row) : undefined;
  }

  findExperienceDatasetByDigest(digest: string): ExperienceDatasetRecord | undefined {
    const row = this.db.get<ExperienceDatasetRow>(
      "SELECT * FROM experience_datasets WHERE digest = ?",
      digest,
    );
    return row ? mapExperienceDataset(row) : undefined;
  }

  listExperienceDatasets(
    purpose?: ExperienceDatasetPurpose,
    limit = 20,
    organismId?: string,
  ): ExperienceDatasetRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (purpose) {
      conditions.push("purpose = ?");
      params.push(purpose);
    }
    if (organismId) {
      conditions.push("organism_id = ?");
      params.push(organismId);
    }
    return this.db
      .all<ExperienceDatasetRow>(
        `SELECT * FROM experience_datasets ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
        ...params,
        limit,
      )
      .map(mapExperienceDataset);
  }

  taskBelongsToOrganism(taskId: string, organismId: string): boolean {
    return !!this.db.get(
      "SELECT 1 FROM runs WHERE task_id = ? AND organism_id = ?",
      taskId,
      organismId,
    );
  }

  listExperiences(
    limit: number,
    organismId?: string,
  ): Array<{ id: string; runId: string; createdAt: number }> {
    return this.db
      .all<ExperienceRow>(
        `SELECT e.* FROM experiences e JOIN runs r ON r.id = e.run_id ${organismId ? "WHERE r.organism_id = ?" : ""} ORDER BY e.created_at, e.id LIMIT ?`,
        ...(organismId ? [organismId, limit] : [limit]),
      )
      .map((row) => ({ id: row.id, runId: row.run_id, createdAt: row.created_at }));
  }

  experienceDatasetPurposes(experienceId: string): ExperienceDatasetPurpose[] {
    return this.db
      .all<{ purpose: ExperienceDatasetPurpose }>(
        "SELECT DISTINCT d.purpose FROM experience_datasets d JOIN experience_dataset_members m ON m.dataset_id = d.id WHERE m.experience_id = ?",
        experienceId,
      )
      .map((row) => row.purpose);
  }

  learningCallLimit(organismId: string): number {
    return (
      this.db.get<{ max_calls: number }>(
        "SELECT max_calls FROM learning_call_limits WHERE organism_id = ?",
        organismId,
      )?.max_calls ?? 100
    );
  }

  setLearningCallLimit(organismId: string, maxCalls: number): void {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0)
      throw new Error("Invalid learning call limit");
    this.db.run(
      "INSERT INTO learning_call_limits VALUES (?, ?) ON CONFLICT(organism_id) DO UPDATE SET max_calls = excluded.max_calls",
      organismId,
      maxCalls,
    );
  }

  learningCalls(organismId: string): LearningCallRecord[] {
    return this.db
      .all<{
        id: string;
        organism_id: string;
        job_id: string | null;
        state: LearningCallRecord["state"];
        usage: string | null;
        error: string | null;
        created_at: number;
        ended_at: number | null;
      }>("SELECT * FROM learning_calls WHERE organism_id = ? ORDER BY created_at, id", organismId)
      .map((r) => ({
        id: r.id,
        organismId: r.organism_id,
        jobId: r.job_id,
        state: r.state,
        usage: r.usage ? JSON.parse(r.usage) : null,
        error: r.error,
        createdAt: r.created_at,
        endedAt: r.ended_at,
      }));
  }

  insertLearningCall(call: LearningCallRecord): void {
    this.db.run(
      "INSERT INTO learning_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      call.id,
      call.organismId,
      call.jobId,
      call.state,
      call.usage ? JSON.stringify(call.usage) : null,
      call.error,
      call.createdAt,
      call.endedAt,
    );
  }

  finishLearningCall(
    id: string,
    state: LearningCallRecord["state"],
    usage: LearningCallRecord["usage"],
    error: string | null,
    endedAt: number,
  ): void {
    this.db.run(
      "UPDATE learning_calls SET state = ?, usage = ?, error = ?, ended_at = ? WHERE id = ? AND state = 'reserved'",
      state,
      usage ? JSON.stringify(usage) : null,
      error,
      endedAt,
      id,
    );
  }

  // ---- M3+：Consolidation 作业队列 ----

  insertConsolidationJob(j: ConsolidationJobRecord): void {
    this.db.run(
      `INSERT INTO consolidation_jobs (id, dataset_id, mode, params_digest, params, state, result, error, requested_by, created_at, updated_at, organism_id, validation_set_id, cancel_requested)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      j.id,
      j.datasetId,
      j.mode,
      j.paramsDigest,
      JSON.stringify(j.params),
      j.state,
      j.result ? JSON.stringify(j.result) : null,
      j.error,
      j.requestedBy,
      j.createdAt,
      j.updatedAt,
      j.organismId,
      j.validationSetId,
      Number(j.cancelRequested),
    );
  }

  getConsolidationJob(id: string): ConsolidationJobRecord | undefined {
    const row = this.db.get<ConsolidationJobRow>(
      "SELECT * FROM consolidation_jobs WHERE id = ?",
      id,
    );
    return row ? mapConsolidationJob(row) : undefined;
  }

  listConsolidationJobs(
    filter: { state?: ConsolidationJobState; datasetId?: string; organismId?: string },
    limit: number,
  ): ConsolidationJobRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.organismId) {
      conditions.push("organism_id = ?");
      params.push(filter.organismId);
    }
    if (filter.state) {
      conditions.push("state = ?");
      params.push(filter.state);
    }
    if (filter.datasetId) {
      conditions.push("dataset_id = ?");
      params.push(filter.datasetId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    return this.db
      .all<ConsolidationJobRow>(
        `SELECT * FROM consolidation_jobs ${where} ORDER BY created_at LIMIT ?`,
        ...params,
      )
      .map(mapConsolidationJob);
  }

  updateConsolidationJob(
    id: string,
    patch: Partial<
      Pick<ConsolidationJobRecord, "state" | "result" | "error" | "cancelRequested">
    > & {
      updatedAt: number;
    },
  ): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, column] of [
      ["state", "state"],
      ["cancelRequested", "cancel_requested"],
      ["result", "result"],
      ["error", "error"],
    ] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        const value = patch[key];
        params.push(
          typeof value === "boolean"
            ? Number(value)
            : typeof value === "object" && value !== null
              ? JSON.stringify(value)
              : value,
        );
      }
    }
    sets.push("updated_at = ?");
    params.push(patch.updatedAt, id);
    this.db.run(`UPDATE consolidation_jobs SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  // ---- 验证集移交注册表 ----

  insertValidationSet(v: ValidationSetRecord): void {
    this.db.run(
      `INSERT INTO validation_sets (id, family_ids, source_ref, prepared_by, dev_families_digest, state, usage_count, first_used_at, retired_at, created_at, organism_id, dev_family_ids, plan_digest, plan_ref, candidate_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.id,
      JSON.stringify(v.familyIds),
      v.sourceRef,
      v.preparedBy,
      v.devFamiliesDigest,
      v.state,
      v.usageCount,
      v.firstUsedAt,
      v.retiredAt,
      v.createdAt,
      v.organismId,
      JSON.stringify(v.devFamilyIds),
      v.planDigest,
      v.planRef,
      v.candidateId,
    );
  }

  getValidationSet(id: string): ValidationSetRecord | undefined {
    const row = this.db.get<ValidationSetRow>("SELECT * FROM validation_sets WHERE id = ?", id);
    return row ? mapValidationSet(row) : undefined;
  }

  listValidationSets(limit: number): ValidationSetRecord[] {
    return this.db
      .all<ValidationSetRow>(
        "SELECT * FROM validation_sets ORDER BY created_at DESC LIMIT ?",
        limit,
      )
      .map(mapValidationSet);
  }

  updateValidationSet(
    id: string,
    patch: Partial<
      Pick<
        ValidationSetRecord,
        "state" | "usageCount" | "firstUsedAt" | "retiredAt" | "candidateId"
      >
    > & { updatedAt: number },
  ): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, column] of [
      ["state", "state"],
      ["candidateId", "candidate_id"],
      ["usageCount", "usage_count"],
      ["firstUsedAt", "first_used_at"],
      ["retiredAt", "retired_at"],
    ] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(patch[key]);
      }
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE validation_sets SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  insertPublication(p: PublicationRecord): void {
    this.db.run(
      "INSERT INTO publications VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      p.id,
      p.teamId,
      p.scope,
      p.bundleDigest,
      p.bundleRef,
      JSON.stringify(p.versionIds),
      p.createdBy,
      p.createdAt,
    );
  }

  insertPublicationKey(key: PublicationKey): void {
    this.db.run(
      "INSERT INTO publication_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      key.organismId,
      key.keyId,
      key.teamId,
      key.publisher,
      key.publicKey,
      key.state,
      key.localSigner ? 1 : 0,
      key.createdBy,
      key.createdAt,
    );
  }

  getPublicationKey(organismId: string, keyId: string): PublicationKey | undefined {
    const row = this.db.get<{
      organism_id: string;
      key_id: string;
      team_id: string;
      publisher: string;
      public_key: string;
      state: PublicationKey["state"];
      local_signer: number;
      created_by: string;
      created_at: number;
    }>("SELECT * FROM publication_keys WHERE organism_id = ? AND key_id = ?", organismId, keyId);
    return row
      ? {
          organismId: row.organism_id,
          keyId: row.key_id,
          teamId: row.team_id,
          publisher: row.publisher,
          publicKey: row.public_key,
          state: row.state,
          localSigner: !!row.local_signer,
          createdBy: row.created_by,
          createdAt: row.created_at,
        }
      : undefined;
  }

  revokePublicationKey(organismId: string, keyId: string): void {
    this.db.run(
      "UPDATE publication_keys SET state = 'revoked' WHERE organism_id = ? AND key_id = ?",
      organismId,
      keyId,
    );
  }

  recordImportSignature(importId: string, keyId: string, signedRef: string): void {
    const existing = this.db.get<{ key_id: string; signed_ref: string }>(
      "SELECT * FROM import_signatures WHERE import_id = ?",
      importId,
    );
    if (existing && (existing.key_id !== keyId || existing.signed_ref !== signedRef))
      throw new Error("导入记录已绑定不同签名，不能替换来源证明");
    this.db.run(
      "INSERT OR IGNORE INTO import_signatures VALUES (?, ?, ?)",
      importId,
      keyId,
      signedRef,
    );
  }

  isSharedImportTrusted(importId: string, organismId: string): boolean {
    const imported = this.getSharedImport(importId);
    if (!imported || imported.organismId !== organismId) return false;
    const signature = this.db.get<{ key_id: string }>(
      "SELECT * FROM import_signatures WHERE import_id = ?",
      importId,
    );
    return !signature || this.getPublicationKey(organismId, signature.key_id)?.state === "active";
  }

  getImportSignatureRef(importId: string): string | undefined {
    return this.db.get<{ signed_ref: string }>(
      "SELECT signed_ref FROM import_signatures WHERE import_id = ?",
      importId,
    )?.signed_ref;
  }

  insertRegistryCredential(credential: RegistryCredential): void {
    this.db.run(
      "INSERT INTO registry_credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      credential.id,
      credential.organismId,
      credential.tokenDigest,
      credential.teamId,
      credential.principalId,
      JSON.stringify(credential.actions),
      credential.state,
      credential.createdBy,
      credential.createdAt,
    );
  }

  getRegistryCredential(organismId: string, id: string): RegistryCredential | undefined {
    const r = this.db.get<{
      id: string;
      organism_id: string;
      token_digest: string;
      team_id: string;
      principal_id: string;
      actions: string;
      state: RegistryCredential["state"];
      created_by: string;
      created_at: number;
    }>("SELECT * FROM registry_credentials WHERE organism_id = ? AND id = ?", organismId, id);
    return r
      ? {
          id: r.id,
          organismId: r.organism_id,
          tokenDigest: r.token_digest,
          teamId: r.team_id,
          principalId: r.principal_id,
          actions: JSON.parse(r.actions),
          state: r.state,
          createdBy: r.created_by,
          createdAt: r.created_at,
        }
      : undefined;
  }

  findRegistryCredential(organismId: string, tokenDigest: string): RegistryCredential | undefined {
    const row = this.db.get<{ id: string }>(
      "SELECT id FROM registry_credentials WHERE organism_id = ? AND token_digest = ?",
      organismId,
      tokenDigest,
    );
    return row ? this.getRegistryCredential(organismId, row.id) : undefined;
  }

  revokeRegistryCredential(id: string): void {
    this.db.run("UPDATE registry_credentials SET state = 'revoked' WHERE id = ?", id);
  }

  getRegistryPackageRef(organismId: string, digest: string): string | undefined {
    return this.db.get<{ signed_ref: string }>(
      "SELECT signed_ref FROM registry_packages WHERE organism_id = ? AND digest = ?",
      organismId,
      digest,
    )?.signed_ref;
  }

  insertRegistryPackage(organismId: string, pkg: SignedShareEnvelope, ref: string): void {
    this.db.run(
      "INSERT INTO registry_packages VALUES (?, ?, ?, ?, ?, ?)",
      organismId,
      pkg.envelope.digest,
      ref,
      pkg.envelope.bundle.teamId,
      pkg.envelope.bundle.scope,
      pkg.signer.keyId,
    );
  }

  getPublication(id: string): PublicationRecord | undefined {
    const r = this.db.get<{
      id: string;
      team_id: string;
      scope: string;
      bundle_digest: string;
      bundle_ref: string;
      version_ids: string;
      created_by: string;
      created_at: number;
    }>("SELECT * FROM publications WHERE id = ?", id);
    return r
      ? {
          id: r.id,
          teamId: r.team_id,
          scope: r.scope,
          bundleDigest: r.bundle_digest,
          bundleRef: r.bundle_ref,
          versionIds: JSON.parse(r.version_ids),
          createdBy: r.created_by,
          createdAt: r.created_at,
        }
      : undefined;
  }

  insertSharedImport(r: ImportRecord): void {
    this.db.run(
      "INSERT INTO shared_imports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.id,
      r.organismId,
      r.bundleDigest,
      r.publicationId,
      JSON.stringify(r.versions),
      JSON.stringify(r.rootVersionIds),
      r.state,
      r.createdBy,
      r.createdAt,
      r.bundleRef,
    );
  }

  getSharedImport(id: string): ImportRecord | undefined {
    const r = this.db.get<{
      id: string;
      organism_id: string;
      bundle_digest: string;
      bundle_ref: string | null;
      publication_id: string;
      versions: string;
      root_version_ids: string;
      state: ImportRecord["state"];
      created_by: string;
      created_at: number;
    }>("SELECT * FROM shared_imports WHERE id = ?", id);
    return r
      ? {
          id: r.id,
          organismId: r.organism_id,
          bundleDigest: r.bundle_digest,
          bundleRef: r.bundle_ref,
          publicationId: r.publication_id,
          versions: JSON.parse(r.versions),
          rootVersionIds: JSON.parse(r.root_version_ids),
          state: r.state,
          createdBy: r.created_by,
          createdAt: r.created_at,
        }
      : undefined;
  }

  findSharedImport(organismId: string, bundleDigest: string): ImportRecord | undefined {
    const r = this.db.get<{ id: string }>(
      "SELECT id FROM shared_imports WHERE organism_id = ? AND bundle_digest = ?",
      organismId,
      bundleDigest,
    );
    return r ? this.getSharedImport(r.id) : undefined;
  }

  rejectSharedImport(id: string): void {
    this.db.run("UPDATE shared_imports SET state = 'rejected' WHERE id = ?", id);
  }

  hasAdoptedImport(importId: string, organismId: string): boolean {
    return !!this.db.get(
      "SELECT 1 FROM promotions p JOIN evaluations e ON e.id = p.evaluation_ref JOIN candidates c ON c.id = e.candidate_id WHERE p.organism_id = ? AND json_extract(c.source_refs, '$.importId') = ?",
      organismId,
      importId,
    );
  }

  insertPromotion(p: PromotionRecord): void {
    this.db.run(
      `INSERT INTO promotions (id, operation_id, kind, organism_id, from_snapshot_id, to_snapshot_id, expected_revision, result_revision, evaluation_ref, authorization_ref, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.operationId,
      p.kind,
      p.organismId,
      p.fromSnapshotId,
      p.toSnapshotId,
      p.expectedRevision,
      p.resultRevision,
      p.evaluationRef,
      p.authorizationRef,
      p.actor,
      p.note,
      p.createdAt,
    );
  }

  getPromotionByOperationId(operationId: string): PromotionRecord | undefined {
    const row = this.db.get<PromotionRow>(
      "SELECT * FROM promotions WHERE operation_id = ?",
      operationId,
    );
    return row ? mapPromotion(row) : undefined;
  }

  getPromotion(id: string): PromotionRecord | undefined {
    const row = this.db.get<PromotionRow>("SELECT * FROM promotions WHERE id = ?", id);
    return row ? mapPromotion(row) : undefined;
  }

  listPromotions(organismId: string, limit: number): PromotionRecord[] {
    return this.db
      .all<PromotionRow>(
        "SELECT * FROM promotions WHERE organism_id = ? ORDER BY created_at DESC LIMIT ?",
        organismId,
        limit,
      )
      .map(mapPromotion);
  }

  /** rollback 只允许选择该 Organism 晋升历史中出现过的快照。 */
  hasHistoricalPromotionSnapshot(organismId: string, snapshotId: string): boolean {
    return Boolean(
      this.db.get<{ found: number }>(
        `SELECT 1 AS found FROM promotions
         WHERE organism_id = ? AND (from_snapshot_id = ? OR to_snapshot_id = ?)
         LIMIT 1`,
        organismId,
        snapshotId,
        snapshotId,
      ),
    );
  }
}

// ---- 行映射 ----

function mapVersion(row: VersionRow): ArtifactVersion {
  return {
    scope: row.scope,
    id: row.id,
    artifactId: row.artifact_id,
    lineageId: row.lineage_id,
    schemaVersion: row.schema_version,
    contentDigest: row.content_digest,
    contentRef: row.content_ref,
    parents: JSON.parse(row.parents) as string[],
    dependencies: JSON.parse(row.dependencies) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapSnapshot(row: SnapshotRow): GenomeSnapshot {
  return {
    id: row.id,
    digest: row.digest,
    bindings: JSON.parse(row.bindings) as Record<string, string>,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    organismId: row.organism_id,
    purpose: row.purpose as RunRecord["purpose"],
    snapshotId: row.snapshot_id,
    graphDigest: row.graph_digest,
    state: row.state as RunState,
    supersedesRunId: row.supersedes_run_id,
    budget: JSON.parse(row.budget) as TaskBudget,
    failureReason: row.failure_reason,
    missingCapabilities: row.missing_capabilities
      ? (JSON.parse(row.missing_capabilities) as string[])
      : null,
    waitingUntil: row.waiting_until,
    evaluatorVersionId: row.evaluator_version_id,
    deadlineAt: row.deadline_at ?? row.created_at,
    experimentId: row.experiment_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    processId: row.process_id,
    ordinal: row.ordinal,
    dispatchId: row.dispatch_id,
    state: row.state as AttemptState,
    handle: row.handle,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    outputRef: row.output_ref,
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    eventId: row.event_id,
    streamId: row.stream_id,
    seq: row.seq,
    type: row.type,
    schemaVersion: row.schema_version,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    organismId: row.organism_id,
    runId: row.run_id,
    processId: row.process_id,
    attemptId: row.attempt_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function mapDispatch(row: DispatchRow): DispatchRecord {
  return {
    dispatchId: row.dispatch_id,
    runId: row.run_id,
    processId: row.process_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    state: row.state as DispatchRecord["state"],
    handle: row.handle,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
  };
}

function mapDecisionCall(row: DecisionCallRow): DecisionCallRecord {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    runId: row.run_id,
    nodeId: row.node_id,
    snapshotId: row.snapshot_id,
    kind: row.kind as DecisionCallRecord["kind"],
    state: row.state as DecisionCallRecord["state"],
    sent: row.sent === 1,
    provider: row.provider,
    policyVersionId: row.policy_version_id,
    viewVersionId: row.view_version_id,
    requestRef: row.request_ref,
    requestDigest: row.request_digest,
    responseRef: row.response_ref,
    responseDigest: row.response_digest,
    provenance: JSON.parse(row.provenance) as DecisionCallRecord["provenance"],
    usage: row.usage ? (JSON.parse(row.usage) as DecisionCallRecord["usage"]) : null,
    errorClass: row.error_class,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    lateArrival: row.late_arrival === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decisionLimitScope(scope: { organismId: string; experimentId?: string | null }): string {
  return scope.experimentId
    ? `experiment:${scope.organismId}:${scope.experimentId}`
    : `organism:${scope.organismId}`;
}

function mapCandidate(row: CandidateRow): CandidateRecord {
  return {
    id: row.id,
    organismId: row.organism_id,
    baseSnapshotId: row.base_snapshot_id,
    baseRevision: row.base_revision,
    proposedSnapshotId: row.proposed_snapshot_id,
    hypothesis: row.hypothesis,
    proposedBy: row.proposed_by,
    sourceRefs: JSON.parse(row.source_refs) as Record<string, string>,
    datasetRef: row.dataset_ref,
    createdAt: row.created_at,
  };
}

function mapEvaluation(row: EvaluationRow): EvaluationRecord {
  // metrics 列承载 { metrics, policy, datasetSplitRefs }（v7 起包装；
  // 兼容旧记录的裸 metrics JSON）
  let parsed: {
    metrics?: EvaluationRecord["metrics"];
    policy?: EvaluationRecord["policy"] | null;
    policyEvidence?: EvaluationRecord["policyEvidence"] | null;
    datasetSplitRefs?: string[] | null;
  };
  const raw = JSON.parse(row.metrics) as Record<string, unknown>;
  if (raw && typeof raw === "object" && "metrics" in raw) {
    parsed = raw as typeof parsed;
  } else {
    parsed = { metrics: raw as unknown as EvaluationRecord["metrics"] };
  }
  return {
    id: row.id,
    candidateId: row.candidate_id,
    protocolDigest: row.protocol_digest,
    baselineSnapshotId: row.baseline_snapshot_id,
    runs: JSON.parse(row.runs) as EvaluationRecord["runs"],
    verdict: row.verdict as EvaluationRecord["verdict"],
    metrics: parsed.metrics!,
    policy: parsed.policy ?? undefined,
    policyEvidence: parsed.policyEvidence ?? undefined,
    datasetSplitRefs: parsed.datasetSplitRefs ?? undefined,
    datasetRef: row.dataset_ref,
    createdAt: row.created_at,
  };
}

function mapPromotion(row: PromotionRow): PromotionRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    kind: row.kind as PromotionRecord["kind"],
    organismId: row.organism_id,
    fromSnapshotId: row.from_snapshot_id,
    toSnapshotId: row.to_snapshot_id,
    expectedRevision: row.expected_revision,
    resultRevision: row.result_revision,
    evaluationRef: row.evaluation_ref,
    authorizationRef: row.authorization_ref,
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapExperienceDataset(row: ExperienceDatasetRow): ExperienceDatasetRecord {
  return {
    organismId: row.organism_id,
    id: row.id,
    digest: row.digest,
    purpose: row.purpose as ExperienceDatasetRecord["purpose"],
    cutoffAt: row.cutoff_at,
    memberExperienceIds: JSON.parse(row.member_experience_ids) as string[],
    memberDigest: row.member_digest,
    filterVersion: row.filter_version,
    permissionScope: row.permission_scope,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapConsolidationJob(row: ConsolidationJobRow): ConsolidationJobRecord {
  return {
    organismId: row.organism_id,
    validationSetId: row.validation_set_id,
    cancelRequested: Boolean(row.cancel_requested),
    id: row.id,
    datasetId: row.dataset_id,
    mode: row.mode as ConsolidationJobRecord["mode"],
    paramsDigest: row.params_digest,
    params: JSON.parse(row.params) as ConsolidationJobRecord["params"],
    state: row.state as ConsolidationJobRecord["state"],
    result: row.result ? (JSON.parse(row.result) as ConsolidationJobRecord["result"]) : null,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapValidationSet(row: ValidationSetRow): ValidationSetRecord {
  return {
    organismId: row.organism_id,
    devFamilyIds: JSON.parse(row.dev_family_ids) as string[],
    planDigest: row.plan_digest,
    planRef: row.plan_ref,
    candidateId: row.candidate_id,
    id: row.id,
    familyIds: JSON.parse(row.family_ids) as string[],
    sourceRef: row.source_ref,
    preparedBy: row.prepared_by,
    devFamiliesDigest: row.dev_families_digest,
    state: row.state as ValidationSetRecord["state"],
    usageCount: row.usage_count,
    firstUsedAt: row.first_used_at,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  };
}
