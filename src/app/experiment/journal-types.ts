import type { AdaptiveUnit } from "./adaptive.ts";

export interface AdaptiveJournalRecord {
  id: string;
  organismId: string;
  manifestDigest: string;
  manifestRef: string;
  developmentDigest: string;
  developmentRef: string;
  /** 缺项表示旧版/普通宿主收据；不会自动升级为已核验来源。 */
  compilationEvidence?: { jobId: string; bundleDigest: string; auditDigest: string };
  state: "ready" | "running" | "completed" | "failed" | "cancelled";
  createdBy: string;
  createdAt: number;
  /** 包括开发单元的最早时间；恢复和空闲等待都不延长全轮期限。 */
  startedAt: number;
  deadlineAt: number;
  error: string | null;
}

export interface AdaptiveReservationRecord {
  id: string;
  experimentId: string;
  ordinal: number;
  unit: AdaptiveUnit;
  state: "prepared" | "started" | "completed" | "unknown";
  preparedAt: number;
  startedAt: number | null;
  deadlineAt: number | null;
  observationRef: string | null;
  observationDigest: string | null;
}
