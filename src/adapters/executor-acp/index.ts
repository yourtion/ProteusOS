import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type NewSessionRequest,
} from "@agentclientprotocol/sdk";
import type { ExecutionRequest, ExecutionResult, ExecutorProvider } from "../../runtime/types.ts";
import { boundedOutput } from "../../runtime/execution-evidence.ts";
import { AcpAccounting, accountingUsage } from "./accounting.ts";
import { AcpObservation } from "./observation.ts";

/**
 * ACP 执行器（M1）：以 ACP client 身份 spawn agent 侧适配器
 * （claude-agent-acp / codex-acp / 测试用 fake agent），
 * initialize → session/new(cwd=工作区) → session/prompt(任务指令) → 收集 update。
 *
 * end_turn 只表示本轮结束，不映射为任务成功；成功与否由 verify 节点
 * 的独立裁判判定（docs/runtime.md §6）。trace 落盘到工作区 .proteus/。
 */

export type AcpPermissionPolicy = (
  params: RequestPermissionRequest,
) => RequestPermissionResponse | Promise<RequestPermissionResponse>;

/** 默认策略：选第一个 allow 类选项；没有则 cancelled（保守拒绝，等待人工策略） */
export function allowFirstOptionPolicy(
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const allow = params.options.find((o) => /allow/i.test(o.name) || /allow/i.test(o.optionId));
  if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
  return { outcome: { outcome: "cancelled" } };
}

/** 全部拒绝：无人工介入的无人值守默认（响应 cancelled，agent 应停止本轮） */
export function denyAllPolicy(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

export interface AcpExecutorOptions {
  name: string;
  /** agent 进程入口脚本（以 process.execPath 启动，避免 exec 位问题） */
  agentEntry: string;
  agentArgs?: string[];
  /** 受信宿主显式提供子进程环境；不写入 trace 或版本。缺省保持既有行为。 */
  env?: NodeJS.ProcessEnv;
  /** Provider 专属会话设置（如模型/工具/轮数），不放凭据。 */
  sessionMeta?: NewSessionRequest["_meta"];
  /** Explicit Claude SDK numeric receipts; never store raw message content. */
  captureClaudeUsage?: boolean;
  permissionPolicy?: AcpPermissionPolicy;
  clientInfo?: { name: string; title: string; version: string };
}

export class AcpExecutor implements ExecutorProvider {
  readonly name: string;
  readonly recoveryPolicy = "manual";
  private readonly agentEntry: string;
  private readonly agentArgs: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly sessionMeta: NewSessionRequest["_meta"];
  private readonly captureClaudeUsage: boolean;
  private readonly permissionPolicy: AcpPermissionPolicy;
  private readonly clientInfo: { name: string; title: string; version: string };

  constructor(options: AcpExecutorOptions) {
    this.name = options.name;
    this.agentEntry = options.agentEntry;
    this.agentArgs = options.agentArgs ?? [];
    this.env = options.env;
    this.sessionMeta = options.sessionMeta;
    this.captureClaudeUsage = options.captureClaudeUsage ?? false;
    this.permissionPolicy = options.permissionPolicy ?? allowFirstOptionPolicy;
    this.clientInfo = options.clientInfo ?? {
      name: "proteus",
      title: "ProteusOS",
      version: "0.1.0",
    };
  }

  async start(req: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const observation = new AcpObservation(req.workspaceDir, req.onProgress);
    observation.record("session.started", { attemptId: req.attemptId });
    observation.report("connecting", null, true);
    const accounting = new AcpAccounting(this.captureClaudeUsage);
    const heartbeat = setInterval(() => observation.heartbeat(), 1000);
    const child = spawn(process.execPath, [this.agentEntry, ...this.agentArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env ?? process.env,
    });

    let stderr = "";
    let stderrTruncated = false;
    let stdoutTruncated = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      const captured = boundedOutput(stderr, chunk.toString("utf8"));
      stderr = captured.text;
      stderrTruncated ||= captured.truncated;
    });

    let stdoutText = "";

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: "proteus" })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const decision = await this.permissionPolicy(ctx.params);
        observation.permission(ctx.params, decision);
        return decision;
      })
      .onNotification(methods.client.session.update, async (ctx) => {
        const update = ctx.params.update;
        observation.update(update);
        const text = textOf(update);
        const captured = boundedOutput(stdoutText, text);
        stdoutText = captured.text;
        stdoutTruncated ||= captured.truncated;
      })
      .onNotification(
        "_claude/sdkMessage",
        (params: unknown) => params,
        async (ctx) => {
          accounting.observeSdk(ctx.params);
        },
      );

    let timedOut = false;
    let cancelNotified = false;
    let liveContext: { notify(method: string, params: unknown): Promise<void> } | null = null;
    let liveSessionId: string | null = null;
    let cancelPending = false;
    // 超时处置按 docs/runtime.md §8：先请求 session/cancel 并等待尾部更新，
    // 宽限期后仍无终态才硬杀（断连只证明进程终止，不证明副作用停止）。
    // 会话尚未建立时挂起补发——cancel 不因竞态丢失。
    const sendCancel = () => {
      if (liveContext && liveSessionId) {
        cancelPending = false;
        cancelNotified = true;
        liveContext
          .notify(methods.agent.session.cancel, { sessionId: liveSessionId })
          .catch(() => undefined);
      } else {
        cancelPending = true;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      sendCancel();
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, req.timeoutMs);

    let stopReason: string | null = null;
    let failure: string | null = null;
    try {
      const response = await app.connectWith(stream, async (ctx) => {
        liveContext = ctx;
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          info: this.clientInfo,
        });
        return ctx
          .buildSession({ cwd: req.workspaceDir, mcpServers: [], _meta: this.sessionMetadata() })
          .withSession(async (session) => {
            liveSessionId = session.sessionId;
            if (cancelPending) sendCancel();
            observation.report("working", null, true);
            const done = session.prompt(req.prompt);
            done.catch(() => undefined); // 协议错误经超时/连接关闭体现，避免未处理拒绝
            const response = await done;
            stopReason = response.stopReason ?? null;
            return response;
          });
      });
      stopReason = response.stopReason ?? stopReason;
      accounting.observeResponse(response);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      child.kill("SIGKILL");
    }

    const ok = !timedOut && stopReason === "end_turn" && failure === null;
    observation.finish(this.name, stopReason, ok, timedOut, failure !== null);
    const metering = accounting.snapshot(!timedOut && failure === null);
    return {
      ok,
      exitCode: ok ? 0 : null,
      stdout: stdoutText,
      stderr: [
        timedOut
          ? cancelNotified
            ? "[acp] 执行超时：已请求 session/cancel，宽限期后终止"
            : "[acp] 执行超时被终止"
          : "",
        stopReason && stopReason !== "end_turn" ? `[acp] stopReason=${stopReason}` : "",
        failure ?? "",
        stderr,
      ]
        .filter(Boolean)
        .join("\n"),
      durationMs: Date.now() - startedAt,
      outputRef: null,
      evidence: {
        ...observation.trace.finish(
          "executor-acp-v1",
          "agent-events",
          !timedOut && failure === null,
          {
            usage: accountingUsage(metering),
            stdoutTruncated,
            stderrTruncated,
            detail: timedOut ? "timeout" : failure === null ? null : "protocol_error",
          },
        ),
        accounting: metering,
      },
    };
  }

  private sessionMetadata(): NewSessionRequest["_meta"] {
    if (!this.captureClaudeUsage) return this.sessionMeta;
    const claude = this.sessionMeta?.claudeCode as Record<string, unknown> | undefined;
    return {
      ...this.sessionMeta,
      claudeCode: { ...claude, emitRawSDKMessages: [{ type: "assistant" }, { type: "result" }] },
    };
  }
}

function textOf(update: SessionUpdate): string {
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    typeof update.content === "object" &&
    update.content !== null &&
    (update.content as { type?: string }).type === "text"
  ) {
    return (update.content as { text?: string }).text ?? "";
  }
  return "";
}
