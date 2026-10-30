import type { ExecutionEvidence, ExecutionProgress } from "../../runtime/execution-evidence.ts";
import type { PublicExecutionEvent } from "../../runtime/execution-evidence.ts";
import { z } from "zod";
export const ProjectInput = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().trim().min(1).max(100).optional(),
  testCommand: z.array(z.string().min(1).max(1000)).max(30).default([]),
});
export const SubmitInput = z.object({
  projectId: z.string(),
  goal: z.string().trim().min(1).max(16000),
  mode: z.enum(["read", "review", "edit"]),
  executor: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  timeoutSeconds: z.number().int().min(10).max(1800).default(300),
  parentId: z.string().optional(),
  requestId: z.string().min(8).max(100),
});
export type Submission = z.infer<typeof SubmitInput>;
export interface Project {
  id: string;
  name: string;
  path: string;
  testCommand: string[];
  createdAt: number;
}
export type { Change } from "../../workspace/types.ts";
import type { Change } from "../../workspace/types.ts";
export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
}
export interface TurnRecord {
  id: string;
  conversationId: string;
  parentTurnId?: string;
  runId: string;
  createdAt: number;
  contextMode: "summary";
}
export interface Work {
  conversationId: string;
  turnId: string;
  id: string;
  projectId: string;
  goal: string;
  mode: Submission["mode"];
  executor: Submission["executor"];
  parentId?: string;
  snapshotId: string;
  inputDir: string;
  inputDigest?: string;
  excludedInputs?: string[];
  baseline: Record<string, string>;
  testCommand: string[];
  createdAt: number;
  progress?: ExecutionProgress;
  evidence?: ExecutionEvidence;
  activityDropped?: number;
  appliedAt?: number;
  applyState?: "applying" | "applied" | "rolled-back" | "needs-recovery";
  error?: string;
  result?: {
    summary: string;
    changes: Change[];
    checks: { tested: boolean; passed: boolean; output: string };
    workspace: string;
  };
}
export interface Interaction {
  id: string;
  runId: string;
  title: string;
  options: { id: string; label: string }[];
  state: "pending" | "answered" | "expired";
  selected?: string;
}
export interface Activity {
  id: number;
  runId: string;
  kind: string;
  text: string;
  at: number;
  data?: PublicExecutionEvent["data"];
}
export const GovernanceInput = z.object({
  action: z.enum([
    "freeze",
    "learn",
    "run-learning",
    "cancel-learning",
    "evaluate",
    "promote",
    "rollback",
  ]),
  target: z.string().optional(),
  validationSetId: z.string().optional(),
  expectedRevision: z.number().int().nonnegative(),
  requestId: z.string().min(8).max(100),
});
