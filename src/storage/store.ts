import type { SQLInputValue } from "node:sqlite";
import type { ArtifactVersion, GenomeSnapshot, KernelStore } from "../kernel/index.ts";
import type { PromotionRecord } from "../kernel/index.ts";
import type { CandidateRecord, EvaluationRecord } from "../evolution/types.ts";
import type {
  AttemptRecord,
  AttemptState,
  BudgetEntryKind,
  DispatchRecord,
  EventAppend,
  EventRecord,
  ExperienceRecord,
  ProcessRecord,
  RunRecord,
  RunState,
  RuntimeStore,
  TaskAcceptance,
  TaskBudget,
  TaskRecord,
} from "../runtime/types.ts";
import type { SqliteDb } from "./sqlite.ts";
import type {
  ArtifactRow,
  AttemptRow,
  CandidateRow,
  DispatchRow,
  EvaluationRow,
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
       (id, artifact_id, lineage_id, schema_version, content_digest, content_ref, parents, dependencies, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    return changes === 1 ? "inserted" : "exists";
  }

  getArtifactVersion(id: string): ArtifactVersion | undefined {
    const row = this.db.get<VersionRow>("SELECT * FROM artifact_versions WHERE id = ?", id);
    return row ? mapVersion(row) : undefined;
  }

  findArtifactVersionByDigest(artifactId: string, digest: string): ArtifactVersion | undefined {
    const row = this.db.get<VersionRow>(
      "SELECT * FROM artifact_versions WHERE artifact_id = ? AND content_digest = ?",
      artifactId,
      digest,
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
      `INSERT INTO tasks (id, revision, requested_by, goal, inputs, budget, acceptance, requires, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      t.revision,
      t.requestedBy,
      t.goal,
      JSON.stringify(t.inputs),
      JSON.stringify(t.budget),
      JSON.stringify(t.acceptance),
      JSON.stringify(t.requires),
      t.createdAt,
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
      `INSERT INTO runs (id, task_id, task_revision, organism_id, purpose, snapshot_id, graph_digest, state, supersedes_run_id, budget, failure_reason, missing_capabilities, waiting_until, evaluator_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      r.createdAt,
      r.updatedAt,
    );
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
    return row ? mapRun(row) : undefined;
  }

  listRuns(limit: number): Array<RunRecord & { goal: string }> {
    const rows = this.db.all<RunRow & { goal: string }>(
      `SELECT runs.*, tasks.goal AS goal FROM runs JOIN tasks ON tasks.id = runs.task_id
       ORDER BY runs.created_at DESC LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({ ...mapRun(row), goal: row.goal }));
  }

  listRunsByStates(states: RunState[], limit: number): RunRecord[] {
    const placeholders = states.map(() => "?").join(", ");
    return this.db
      .all<RunRow>(
        `SELECT * FROM runs WHERE state IN (${placeholders}) ORDER BY created_at LIMIT ?`,
        ...states,
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
    this.db.run(
      "INSERT INTO experiences (id, run_id, outcome, created_at) VALUES (?, ?, ?, ?)",
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

  countActiveRuns(organismId: string): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs WHERE organism_id = ? AND state IN ('pending', 'running', 'waiting')",
      organismId,
    )!;
    return row.n;
  }

  inFlightBudget(organismId: string): { attempts: number; seconds: number } {
    const row = this.db.get<{ attempts: number; seconds: number }>(
      `SELECT COALESCE(SUM(attempts), 0) AS attempts, COALESCE(SUM(seconds), 0) AS seconds
       FROM budget_ledger
       WHERE kind = 'reserve'
         AND run_id IN (
           SELECT id FROM runs WHERE organism_id = ? AND state IN ('pending', 'running', 'waiting')
         )`,
      organismId,
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
      `INSERT INTO evaluations (id, candidate_id, protocol_digest, baseline_snapshot_id, runs, verdict, metrics, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id,
      e.candidateId,
      e.protocolDigest,
      e.baselineSnapshotId,
      JSON.stringify(e.runs),
      e.verdict,
      JSON.stringify(e.metrics),
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
  return {
    id: row.id,
    candidateId: row.candidate_id,
    protocolDigest: row.protocol_digest,
    baselineSnapshotId: row.baseline_snapshot_id,
    runs: JSON.parse(row.runs) as EvaluationRecord["runs"],
    verdict: row.verdict as EvaluationRecord["verdict"],
    metrics: JSON.parse(row.metrics) as EvaluationRecord["metrics"],
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
