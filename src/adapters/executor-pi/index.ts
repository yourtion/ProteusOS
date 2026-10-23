import type { ExecutionRequest, ExecutionResult, ExecutorProvider } from "../../runtime/types.ts";
import {
  ExecutionTrace,
  type ExecutionEvidence,
  type ExecutionUsage,
} from "../../runtime/execution-evidence.ts";

/**
 * pi 执行器（M1）：经官方 SDK @earendil-works/pi-coding-agent 进程内直连。
 * pi 无原生 ACP，其 SDK 即受控编程接口——验证 ExecutorProvider 的可替换性
 * （ADR 0001：协议走 Adapter，内部合同不变）。
 * session.prompt 完成不等于任务成功；判定由 verify 节点独立负责。
 */

export interface PiRunOptions {
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
}

export type PiRunner = (options: PiRunOptions) => Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  evidence?: ExecutionEvidence;
}>;

export class PiExecutor implements ExecutorProvider {
  readonly name: string;
  readonly recoveryPolicy = "manual";
  private readonly runner: PiRunner;

  constructor(name = "pi", runner: PiRunner = defaultPiRunner) {
    this.name = name;
    this.runner = runner;
  }

  async start(req: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const result = await this.runner({
      workspaceDir: req.workspaceDir,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
    });
    return {
      ok: result.ok,
      exitCode: result.ok ? 0 : 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
      outputRef: null,
      evidence: result.evidence,
    };
  }
}

/** 默认 runner：惰性加载 pi SDK，会话 cwd 固定为任务工作区 */
export const defaultPiRunner: PiRunner = async (options) => {
  const mod = await import("@earendil-works/pi-coding-agent");
  // 工作区是运行时创建的一次性隔离目录：按操作者决定显式授信，
  // 否则 pi 的 defaultProjectTrust=ask 在无人值守下禁用写工具
  const settingsManager = mod.SettingsManager.create(options.workspaceDir, undefined, {
    projectTrusted: true,
  });
  const { session } = await mod.createAgentSession({
    cwd: options.workspaceDir,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    settingsManager,
  });
  const trace = new ExecutionTrace();
  trace.record("session.started");
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      trace.record(event.type, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.type === "tool_execution_end" ? event.isError : false,
      });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") trace.record("message", { text: block.text });
      }
    }
  });
  const usage = (): ExecutionUsage | null => {
    try {
      const stats = session.getSessionStats();
      // SDK 的 cost 缺少本项目所需的币种/价格依据，不能当可核对金额。
      return {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        costAmount: null,
        costCurrency: null,
        priceRef: null,
      };
    } catch {
      return null;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.prompt(options.prompt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`pi 执行超时（${options.timeoutMs}ms）`)),
          options.timeoutMs,
        );
      }),
    ]);
    trace.record("session.completed", { ok: true });
    return {
      ok: true,
      stdout: "pi: prompt 完成（判定由 verify 节点负责）",
      stderr: "",
      evidence: trace.finish("executor-pi-v1", "agent-events", true, { usage: usage() }),
    };
  } catch (err) {
    trace.record("session.completed", { ok: false });
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      evidence: trace.finish("executor-pi-v1", "agent-events", false, {
        usage: usage(),
        detail: "session_error",
      }),
    };
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    session.dispose();
  }
};
