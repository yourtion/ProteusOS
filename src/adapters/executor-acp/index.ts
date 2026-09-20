import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { ExecutionRequest, ExecutionResult, ExecutorProvider } from "../../runtime/types.ts";

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
  permissionPolicy?: AcpPermissionPolicy;
  clientInfo?: { name: string; title: string; version: string };
}

export class AcpExecutor implements ExecutorProvider {
  readonly name: string;
  private readonly agentEntry: string;
  private readonly agentArgs: string[];
  private readonly permissionPolicy: AcpPermissionPolicy;
  private readonly clientInfo: { name: string; title: string; version: string };

  constructor(options: AcpExecutorOptions) {
    this.name = options.name;
    this.agentEntry = options.agentEntry;
    this.agentArgs = options.agentArgs ?? [];
    this.permissionPolicy = options.permissionPolicy ?? allowFirstOptionPolicy;
    this.clientInfo = options.clientInfo ?? {
      name: "proteus",
      title: "ProteusOS",
      version: "0.1.0",
    };
  }

  async start(req: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [this.agentEntry, ...this.agentArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
    });

    const updates: SessionUpdate[] = [];
    const permissions: Array<{ toolCall: unknown; options: unknown; decision: unknown }> = [];
    let stdoutText = "";

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: "proteus" })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const decision = await this.permissionPolicy(ctx.params);
        permissions.push({ toolCall: ctx.params.toolCall, options: ctx.params.options, decision });
        return decision;
      })
      .onNotification(methods.client.session.update, async (ctx) => {
        updates.push(ctx.params.update);
        stdoutText = `${stdoutText}${textOf(ctx.params.update)}`.slice(-8000);
      });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, req.timeoutMs);

    let stopReason: string | null = null;
    let failure: string | null = null;
    try {
      const response = await app.connectWith(stream, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          info: this.clientInfo,
        });
        return ctx.buildSession(req.workspaceDir).withSession(async (session) => {
          const done = session.prompt(req.prompt);
          done.catch(() => undefined); // 协议错误经超时/连接关闭体现，避免未处理拒绝
          const response = await done;
          stopReason = response.stopReason ?? null;
          return response;
        });
      });
      stopReason = response.stopReason ?? stopReason;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }

    // trace 尽力落盘：update 流 + 权限决定（产出可定位 trace，roadmap M1）
    try {
      mkdirSync(join(req.workspaceDir, ".proteus"), { recursive: true });
      writeFileSync(
        join(req.workspaceDir, ".proteus", "acp-trace.json"),
        JSON.stringify({ agent: this.name, stopReason, updates, permissions }, null, 2),
        "utf8",
      );
    } catch {
      // trace 不影响执行结果
    }

    const ok = !timedOut && stopReason === "end_turn";
    return {
      ok,
      exitCode: ok ? 0 : null,
      stdout: stdoutText,
      stderr: [
        timedOut ? "[acp] 执行超时被终止" : "",
        stopReason && stopReason !== "end_turn" ? `[acp] stopReason=${stopReason}` : "",
        failure ?? "",
        stderr,
      ]
        .filter(Boolean)
        .join("\n"),
      durationMs: Date.now() - startedAt,
      outputRef: null,
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
