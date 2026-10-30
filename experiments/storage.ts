import type {
  AdaptiveJournalRecord,
  AdaptiveReservationRecord,
  AdaptiveRunSlotRecord,
} from "./protocols/journal-types.ts";
import type { CompileDevelopmentRecord } from "./protocols/development-types.ts";
import { Storage } from "../src/storage/store.ts";
export class ExperimentStorage extends Storage {
  compileDevelopmentBundle(jobId: string): CompileDevelopmentRecord | undefined {
    const row = this.db.get<{ record: string }>(
      "SELECT record FROM compile_development_bundles WHERE job_id = ?",
      jobId,
    );
    return row ? (JSON.parse(row.record) as CompileDevelopmentRecord) : undefined;
  }

  insertCompileDevelopmentBundle(record: CompileDevelopmentRecord): void {
    this.db.run(
      "INSERT INTO compile_development_bundles VALUES (?, ?, ?)",
      record.jobId,
      record.organismId,
      JSON.stringify(record),
    );
  }

  // ---- 应用实验账本：事务与冻结/恢复规则由 journal 组合 ----

  adaptiveExperiments(organismId: string): AdaptiveJournalRecord[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM adaptive_experiments WHERE organism_id = ? ORDER BY id",
        organismId,
      )
      .map((row) => JSON.parse(row.record) as AdaptiveJournalRecord);
  }

  getAdaptiveExperiment(id: string): AdaptiveJournalRecord | undefined {
    const row = this.db.get<{ record: string }>(
      "SELECT record FROM adaptive_experiments WHERE id = ?",
      id,
    );
    return row ? (JSON.parse(row.record) as AdaptiveJournalRecord) : undefined;
  }

  insertAdaptiveExperiment(record: AdaptiveJournalRecord): void {
    this.db.run(
      "INSERT INTO adaptive_experiments VALUES (?, ?, ?, ?)",
      record.id,
      record.organismId,
      record.manifestDigest,
      JSON.stringify(record),
    );
  }

  updateAdaptiveExperiment(record: AdaptiveJournalRecord): void {
    this.db.run(
      "UPDATE adaptive_experiments SET record = ? WHERE id = ?",
      JSON.stringify(record),
      record.id,
    );
  }

  adaptiveReservations(experimentId: string): AdaptiveReservationRecord[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM adaptive_reservations WHERE experiment_id = ? ORDER BY ordinal",
        experimentId,
      )
      .map((row) => JSON.parse(row.record) as AdaptiveReservationRecord);
  }

  insertAdaptiveReservation(record: AdaptiveReservationRecord): void {
    this.db.run(
      "INSERT INTO adaptive_reservations VALUES (?, ?, ?, ?)",
      record.id,
      record.experimentId,
      record.ordinal,
      JSON.stringify(record),
    );
  }

  updateAdaptiveReservation(record: AdaptiveReservationRecord): void {
    this.db.run(
      "UPDATE adaptive_reservations SET record = ? WHERE id = ?",
      JSON.stringify(record),
      record.id,
    );
  }

  adaptiveRunSlots(reservationId: string): AdaptiveRunSlotRecord[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM adaptive_run_slots WHERE reservation_id = ? ORDER BY ordinal",
        reservationId,
      )
      .map((row) => JSON.parse(row.record) as AdaptiveRunSlotRecord);
  }

  adaptiveRunSlotForRun(runId: string): AdaptiveRunSlotRecord | undefined {
    const row = this.db.get<{ record: string }>(
      "SELECT record FROM adaptive_run_slots WHERE run_id = ?",
      runId,
    );
    return row ? (JSON.parse(row.record) as AdaptiveRunSlotRecord) : undefined;
  }

  insertAdaptiveRunSlot(record: AdaptiveRunSlotRecord): void {
    this.db.run(
      "INSERT INTO adaptive_run_slots VALUES (?, ?, ?, ?)",
      record.reservationId,
      record.ordinal,
      record.runId,
      JSON.stringify(record),
    );
  }

  updateAdaptiveRunSlot(record: AdaptiveRunSlotRecord): void {
    this.db.run(
      "UPDATE adaptive_run_slots SET run_id = ?, record = ? WHERE reservation_id = ? AND ordinal = ?",
      record.runId,
      JSON.stringify(record),
      record.reservationId,
      record.ordinal,
    );
  }
}
