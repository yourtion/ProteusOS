import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";
import type { ModelFreeConstraint } from "./model-free.ts";

export interface PublicExecutionEvent {
  kind: "message" | "tool" | "context" | "plan";
  text: string;
  data?: {
    toolCallId?: string;
    status?: string;
    toolKind?: string;
    input?: string;
    output?: string;
    used?: number;
    size?: number;
    truncated?: boolean;
  };
}

export interface ExecutionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  priceRef: string | null;
}

/** Public progress only. Counts describe observed work, never a fabricated completion percentage. */
export interface ExecutionProgress {
  phase: "connecting" | "working" | "tool" | "permission" | "completed" | "failed";
  elapsedMs: number;
  messageChars: number;
  toolCalls: number;
  lastActivityAt: number;
  detail: string | null;
}

export interface ExecutionTokenTotals {
  uncachedInputTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ExecutionAccounting {
  version: "execution-accounting-v1";
  tokenStatus: "complete" | "partial" | "unavailable";
  source: "claude-sdk-model-usage" | "acp-prompt-usage" | null;
  totals: ExecutionTokenTotals | null;
  observedModelResponses: number | null;
  /** The SDK may perform invisible transport retries; response IDs are not transport attempts. */
  transportAttempts: null;
  models: string[];
  reportedCost: { amount: number; currency: string; source: string; verified: false } | null;
  issues: string[];
  /** Allowlisted numeric metadata only. No message content or private reasoning. */
  receipts: Array<Record<string, unknown>>;
}

export interface ExecutionTraceEvent {
  kind: string;
  at: number;
  data: Record<string, string | number | boolean | null>;
}

export interface ExecutionEvidence {
  version: "execution-evidence-v1";
  adapter: string;
  trace: {
    status: "complete" | "partial" | "unavailable" | "failed";
    coverage: "lifecycle" | "agent-events" | "none";
    events: ExecutionTraceEvent[];
    droppedEvents: number;
    detail: string | null;
  };
  usage: ExecutionUsage | null;
  accounting?: ExecutionAccounting;
  modelConstraint?: ModelFreeConstraint;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface StoredExecutionEvidence {
  version: "execution-evidence-v1";
  attemptId: string;
  executor: string;
  adapter: string | null;
  snapshotId: string;
  promptDigest: string;
  inputDigest: string | null;
  outputDigest: string | null;
  stdoutDigest: string;
  stderrDigest: string;
  traceStatus: ExecutionEvidence["trace"]["status"];
  traceCoverage: ExecutionEvidence["trace"]["coverage"];
  traceRef: string | null;
  traceDigest: string | null;
  droppedEvents: number;
  detail: string | null;
  usage: ExecutionUsage | null;
  accounting?: ExecutionAccounting;
  accountingRef?: string;
  accountingDigest?: string;
  modelConstraint?: ModelFreeConstraint;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** 只保留公开事件的有界投影；finish 后返回的快照不接受迟到修改。 */
export class ExecutionTrace {
  private events: ExecutionTraceEvent[] = [];
  private dropped = 0;
  private clipped = false;
  private pendingMessage = "";

  private readonly limit: number;

  constructor(limit = 256) {
    this.limit = limit;
  }

  record(kind: string, data: ExecutionTraceEvent["data"] = {}): void {
    this.flushMessage();
    this.recordEvent(kind, data);
  }

  /** Streaming text is split into full 2000-character segments, not clipped per token. */
  appendMessage(text: string): void {
    this.pendingMessage += text;
    while (this.pendingMessage.length >= 2000) {
      this.recordEvent("message", { text: this.pendingMessage.slice(0, 2000) });
      this.pendingMessage = this.pendingMessage.slice(2000);
    }
  }

  flushMessage(): void {
    if (!this.pendingMessage) return;
    this.recordEvent("message", { text: this.pendingMessage });
    this.pendingMessage = "";
  }

  /** Even an exhausted buffer must retain the terminal fact; any eviction remains explicit. */
  recordTerminal(kind: string, data: ExecutionTraceEvent["data"]): void {
    this.flushMessage();
    if (this.events.length >= this.limit && this.limit > 0) {
      this.events.pop();
      this.dropped++;
    }
    this.recordEvent(kind, data);
  }

  private recordEvent(kind: string, data: ExecutionTraceEvent["data"]): void {
    if (this.events.length >= this.limit) {
      this.dropped++;
      return;
    }
    const bounded = Object.fromEntries(
      Object.entries(data).map(([key, value]) => {
        if (typeof value === "string" && value.length > 2000) {
          this.clipped = true;
          return [key, value.slice(0, 2000)];
        }
        return [key, value];
      }),
    );
    this.events.push({ kind, at: Date.now(), data: bounded });
  }

  finish(
    adapter: string,
    coverage: ExecutionEvidence["trace"]["coverage"],
    complete: boolean,
    options: {
      usage?: ExecutionUsage | null;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
      detail?: string | null;
      modelConstraint?: ModelFreeConstraint;
    } = {},
  ): ExecutionEvidence {
    this.flushMessage();
    const partial =
      !complete ||
      this.dropped > 0 ||
      this.clipped ||
      options.stdoutTruncated ||
      options.stderrTruncated;
    return {
      version: "execution-evidence-v1",
      adapter,
      trace: {
        status: partial ? "partial" : "complete",
        coverage,
        events: structuredClone(this.events),
        droppedEvents: this.dropped,
        detail: options.detail ?? (this.clipped ? "event_text_truncated" : null),
      },
      usage: options.usage ?? null,
      ...(options.modelConstraint ? { modelConstraint: options.modelConstraint } : {}),
      stdoutTruncated: options.stdoutTruncated ?? false,
      stderrTruncated: options.stderrTruncated ?? false,
    };
  }
}

export function readExecutionAccounting(
  evidence: StoredExecutionEvidence,
  blobs: Pick<BlobStore, "read">,
): ExecutionAccounting | null {
  if (!evidence.accounting) return null;
  if (!evidence.accountingRef || !evidence.accountingDigest)
    throw new Error("accounting_receipt_unavailable");
  const raw = blobs.read(evidence.accountingRef);
  if (
    digestOf(raw) !== evidence.accountingDigest ||
    canonicalJson(JSON.parse(raw)) !== canonicalJson(evidence.accounting)
  )
    throw new Error("accounting_receipt_digest_mismatch");
  return JSON.parse(raw) as ExecutionAccounting;
}

export const EXECUTION_OUTPUT_LIMIT = 64 * 1024;

export function readExecutionTrace(
  evidence: StoredExecutionEvidence | undefined,
  blobs: Pick<BlobStore, "read">,
): ExecutionEvidence["trace"] | null {
  if (!evidence?.traceRef) return null;
  const content = blobs.read(evidence.traceRef);
  if (!evidence.traceDigest || digestOf(content) !== evidence.traceDigest)
    throw new Error("execution_trace_digest_mismatch");
  return JSON.parse(content) as ExecutionEvidence["trace"];
}

export function boundedOutput(
  previous: string,
  chunk: string,
): { text: string; truncated: boolean } {
  const text = previous + chunk;
  return {
    text: text.slice(-EXECUTION_OUTPUT_LIMIT),
    truncated: text.length > EXECUTION_OUTPUT_LIMIT,
  };
}

/** 对派发前的输入副本取指纹；符号链接仅记录链接目标，不越过目录读取。 */
export function executionInputDigest(root: string): string {
  const files: Array<{ path: string; digest?: string; link?: string; kind?: "directory" }> = [];
  const visit = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) files.push({ path, link: readlinkSync(full) });
      else if (stat.isDirectory()) {
        files.push({ path, kind: "directory" });
        visit(full, path);
      } else if (stat.isFile())
        files.push({ path, digest: digestOf(readFileSync(full).toString("base64")) });
    }
  };
  visit(root, "");
  return digestOf(canonicalJson(files));
}
