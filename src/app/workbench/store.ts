import type {
  Project,
  Work,
  Activity,
  Interaction,
  ConversationRecord,
  TurnRecord,
} from "./contracts.ts";
export interface WorkbenchRecords {
  project: Project;
  work: Work;
  activity: Activity;
  interaction: Interaction;
  conversation: ConversationRecord;
  turn: TurnRecord;
  operation: { digest: string; id: string };
  "governance-operation": { digest: string; state: string; result?: unknown; error?: string };
}
type LegacyWork = Omit<Work, "conversationId" | "turnId">;
import { Storage } from "../../storage/store.ts";
export class WorkbenchStorage extends Storage {
  workbenchGet<K extends keyof WorkbenchRecords>(
    kind: K,
    id: string,
  ): WorkbenchRecords[K] | undefined {
    const row = this.db.get<{ record: string }>(
      "SELECT record FROM workbench_records WHERE kind=? AND id=?",
      kind,
      id,
    );
    return row ? (JSON.parse(row.record) as WorkbenchRecords[K]) : undefined;
  }
  workbenchList<K extends keyof WorkbenchRecords>(kind: K): WorkbenchRecords[K][] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM workbench_records WHERE kind=? ORDER BY rowid",
        kind,
      )
      .map((row) => JSON.parse(row.record) as WorkbenchRecords[K]);
  }
  workbenchPut<K extends keyof WorkbenchRecords>(
    kind: K,
    id: string,
    record: WorkbenchRecords[K],
  ): void;
  workbenchPut(kind: "work", id: string, record: LegacyWork): void;
  workbenchPut(
    kind: keyof WorkbenchRecords,
    id: string,
    record: WorkbenchRecords[keyof WorkbenchRecords] | LegacyWork,
  ): void {
    this.db.run(
      "INSERT INTO workbench_records(kind,id,record) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record",
      kind,
      id,
      JSON.stringify(record),
    );
  }
}
