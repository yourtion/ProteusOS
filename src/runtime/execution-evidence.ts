import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";

export interface ExecutionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  priceRef: string | null;
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
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** 只保留公开事件的有界投影；finish 后返回的快照不接受迟到修改。 */
export class ExecutionTrace {
  private events: ExecutionTraceEvent[] = [];
  private dropped = 0;
  private clipped = false;

  private readonly limit: number;

  constructor(limit = 256) {
    this.limit = limit;
  }

  record(kind: string, data: ExecutionTraceEvent["data"] = {}): void {
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
    } = {},
  ): ExecutionEvidence {
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
      stdoutTruncated: options.stdoutTruncated ?? false,
      stderrTruncated: options.stderrTruncated ?? false,
    };
  }
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
