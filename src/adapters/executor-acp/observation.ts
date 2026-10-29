import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { ExecutionTrace, type ExecutionProgress } from "../../runtime/execution-evidence.ts";

/** Public event projection. Catalogs, raw SDK content and private thought chunks never enter it. */
export class AcpObservation {
  readonly trace = new ExecutionTrace();
  readonly updates: Array<Record<string, unknown>> = [];
  readonly permissions: Array<Record<string, unknown>> = [];
  private pending = "";
  private messageChars = 0;
  private tools = new Map<string, string>();
  private toolCount = 0;
  private startedAt = Date.now();
  private activity = this.startedAt;
  private lastProgress = 0;
  private phase: ExecutionProgress["phase"] = "connecting";
  private seq = 0;
  private bytes = 0;
  private journalFailed = false;
  private journalDropped = 0;
  private projectionDropped = 0;
  private progressFailures = 0;
  private readonly journal: string;

  private readonly workspace: string;
  private readonly progress?: (event: ExecutionProgress) => void;
  constructor(workspace: string, progress?: (event: ExecutionProgress) => void) {
    this.workspace = workspace;
    this.progress = progress;
    this.journal = join(workspace, ".proteus/acp-events.jsonl");
    try {
      mkdirSync(join(workspace, ".proteus"), { recursive: true });
      writeFileSync(this.journal, "", { mode: 0o600 });
    } catch {
      this.journalFailed = true;
    }
  }

  record(kind: string, data: Record<string, string | number | boolean | null> = {}): void {
    this.flush();
    this.trace.record(kind, data);
    this.write({ kind, data });
  }

  heartbeat(): void {
    this.flush();
    this.report(this.phase);
  }

  report(phase: ExecutionProgress["phase"], detail: string | null = null, force = false): void {
    const now = Date.now();
    if (!force && phase === this.phase && now - this.lastProgress < 1000) return;
    this.phase = phase;
    this.lastProgress = now;
    const event: ExecutionProgress = {
      phase,
      elapsedMs: now - this.startedAt,
      lastActivityAt: this.activity,
      messageChars: this.messageChars,
      toolCalls: this.toolCount,
      detail: detail?.slice(0, 240) ?? null,
    };
    try {
      this.progress?.(event);
    } catch {
      this.progressFailures++;
    }
  }

  update(update: SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      const text = update.content.text;
      this.activity = Date.now();
      this.messageChars += text.length;
      this.trace.appendMessage(text);
      this.pending += text;
      while (this.pending.length >= 2000) {
        this.projectMessage(this.pending.slice(0, 2000));
        this.pending = this.pending.slice(2000);
      }
      this.report("working");
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const key = JSON.stringify([update.status ?? null, update.title ?? null]);
      if (this.tools.get(update.toolCallId) === key) return;
      if (!this.tools.has(update.toolCallId)) this.toolCount++;
      if (this.tools.size < 256 || this.tools.has(update.toolCallId))
        this.tools.set(update.toolCallId, key);
      this.activity = Date.now();
      const data = {
        toolCallId: update.toolCallId.slice(0, 256),
        status: update.status ?? null,
        title: update.title?.slice(0, 500) ?? null,
      };
      this.record("tool", data);
      this.addUpdate({ sessionUpdate: update.sessionUpdate, ...data });
      this.report("tool", data.title, true);
    }
    // usage_update.used is context occupancy; billing is handled by the separate accounting collector.
  }

  permission(request: RequestPermissionRequest, decision: RequestPermissionResponse): void {
    const record = {
      toolCall: { toolCallId: request.toolCall.toolCallId, name: request.toolCall.name ?? null },
      options: request.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
      decision,
    };
    if (this.permissions.length < 128) this.permissions.push(record);
    else this.projectionDropped++;
    this.record("permission", {
      toolCallId: request.toolCall.toolCallId,
      outcome: decision.outcome.outcome,
      optionId: decision.outcome.outcome === "selected" ? decision.outcome.optionId : null,
    });
    this.report("permission", request.toolCall.name ?? null, true);
  }

  finish(
    agent: string,
    stopReason: string | null,
    ok: boolean,
    timedOut: boolean,
    failed: boolean,
  ): void {
    this.flush();
    const data = { stopReason, timedOut, protocolError: failed };
    this.trace.recordTerminal("session.completed", data);
    this.write({ kind: "session.completed", data }, true);
    this.report(ok ? "completed" : "failed", stopReason, true);
    try {
      writeFileSync(
        join(this.workspace, ".proteus/acp-trace.json"),
        JSON.stringify(
          {
            version: "acp-public-trace-v2",
            agent,
            stopReason,
            updates: this.updates,
            permissions: this.permissions,
            journal: {
              failed: this.journalFailed,
              droppedEvents: this.journalDropped,
              records: this.seq,
            },
            projectionDropped: this.projectionDropped,
            progressFailures: this.progressFailures,
          },
          null,
          2,
        ),
      );
    } catch {
      /* The immutable in-memory trace is still returned to Runtime. */
    }
  }

  private flush(): void {
    if (this.pending) {
      this.projectMessage(this.pending);
      this.pending = "";
    }
  }
  private projectMessage(text: string): void {
    const value = { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
    this.addUpdate(value);
    this.write({ kind: "message", data: { text } });
  }
  private addUpdate(value: Record<string, unknown>): void {
    if (this.updates.length < 512) this.updates.push(value);
    else this.projectionDropped++;
  }
  private write(value: Record<string, unknown>, terminal = false): void {
    if (this.journalFailed) return;
    const line = JSON.stringify({ seq: this.seq + 1, at: Date.now(), ...value }) + "\n";
    if (!terminal && (this.seq >= 2048 || this.bytes + Buffer.byteLength(line) > 2 * 1024 * 1024)) {
      this.journalDropped++;
      return;
    }
    try {
      appendFileSync(this.journal, line);
      this.seq++;
      this.bytes += Buffer.byteLength(line);
    } catch {
      this.journalFailed = true;
    }
  }
}
