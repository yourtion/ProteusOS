import type { ExecutorChoice } from "../../src/app/workbench/execution-options";
import type { Activity, Interaction, Work } from "../../src/app/workbench/contracts";
export type Conversation = {
  truncated: boolean;
  turns: { id: string; goal: string; summary: string | null; state?: string; createdAt: number }[];
};
export type Run = { state: string; failureReason: string | null; deadlineAt: number };
export type Row = Omit<Work, "baseline" | "inputDir" | "result"> & { run: Run };
export type Detail = Work & {
  run: Run;
  activity: Activity[];
  interactions: Interaction[];
  experience: unknown;
  conversation: Conversation;
};
export type Settings = {
  home: string;
  defaultExecutor: string;
  limits: { files: number; bytes: number };
  executors: ExecutorChoice[];
  organism: unknown;
  candidates: unknown[];
  promotions: unknown[];
};
