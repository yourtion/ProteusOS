import type { AdaptiveObservation, AdaptivePlan } from "./adaptive.ts";

export interface CompileDevelopmentRecord {
  jobId: string;
  organismId: string;
  digest: string;
  ref: string;
  createdAt: number;
  createdBy: string;
}

export interface CompileDevelopmentBundle {
  version: "compile-development-v1";
  jobId: string;
  auditDigest: string;
  mode: "fixture" | "real" | null;
  sourceModeVerification: "unavailable";
  source: "synthetic" | "permitted";
  candidateId: string | null;
  policies: { baseDigest: string; candidateDigest: string | null };
  fixed: Omit<AdaptivePlan["fixed"], "toolsDigest" | "environmentDigest">;
  cases: AdaptivePlan["cases"];
  tasks: Array<{
    caseId: string;
    sourceFingerprint: string;
    task: { goal: string; inputs: Array<{ name: string; content: string }> };
  }>;
  development: AdaptivePlan["development"];
  observations: Array<Omit<AdaptiveObservation, "manifestDigest">>;
  /** 缺少执行器模型调用上界时不能把当前 fixture 额度用于真实轮。 */
  unknownBoundUnits: string[];
}
