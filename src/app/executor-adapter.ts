import { accessSync, constants } from "node:fs";
import { delimiter, join, isAbsolute } from "node:path";
import { PiExecutor } from "../adapters/executor-pi/index.ts";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AcpExecutor,
  denyAllPolicy,
  type AcpExecutorOptions,
  type AcpPermissionPolicy,
} from "../adapters/executor-acp/index.ts";
import type { ExecutorProvider } from "../runtime/types.ts";

export interface ExecutorAdapterContext {
  signal: AbortSignal;
  /** 自动绑定注册名与宿主审批策略；CLI 默认拒绝权限请求，Web 使用交互审批。 */
  createAcpExecutor(
    options: Omit<AcpExecutorOptions, "name" | "permissionPolicy">,
  ): ExecutorProvider;
}
export interface ExecutorAdapter {
  version: "proteus-executor-adapter-v1";
  name: string;
  /** 每次执行单独创建，可在这里刷新鉴权；不可自动重试执行。 */
  create(context: ExecutorAdapterContext): ExecutorProvider | Promise<ExecutorProvider>;
}
export interface ExecutorsConfiguration {
  version: "proteus-executors-v1";
  enabled: string[];
  default: string;
  adapters?: ExecutorAdapter[];
}
export type ExecutorSetup = ExecutorAdapter | ExecutorsConfiguration;
export function executorConfiguration(
  input?: ExecutorSetup,
): ExecutorsConfiguration & { adapters: ExecutorAdapter[] } {
  if (!input || input.version === "proteus-executor-adapter-v1") {
    const adapters = input ? [checkedExecutorAdapter(input)] : [];
    return {
      version: "proteus-executors-v1",
      enabled: ["codex", "claude", "pi", "opencode", ...adapters.map((a) => a.name)],
      default: "codex",
      adapters,
    };
  }
  if (
    input.version !== "proteus-executors-v1" ||
    !Array.isArray(input.enabled) ||
    !Array.isArray(input.adapters ?? [])
  )
    throw new Error("执行器配置需要 version、enabled、default");
  const adapters = (input.adapters ?? []).map(checkedExecutorAdapter);
  const known = new Set(["codex", "claude", "pi", "opencode", ...adapters.map((a) => a.name)]);
  if (
    new Set(adapters.map((a) => a.name)).size !== adapters.length ||
    new Set(input.enabled).size !== input.enabled.length ||
    input.enabled.some((name) => !known.has(name)) ||
    !input.enabled.includes(input.default)
  )
    throw new Error("执行器配置包含重复/未知名称或默认执行器未启用");
  return {
    version: "proteus-executors-v1",
    enabled: [...input.enabled],
    default: input.default,
    adapters,
  };
}
export function executableAvailable(command: string): boolean {
  return (
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command))
  ).some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
export function builtinExecutor(
  name: string,
  permissionPolicy: AcpPermissionPolicy = denyAllPolicy,
): ExecutorProvider {
  if (name === "opencode")
    return new AcpExecutor({
      name,
      command: process.env.PROTEUS_OPENCODE_COMMAND ?? "opencode",
      agentArgs: ["acp"],
      permissionPolicy,
    });
  if (name === "pi") {
    const pi = new PiExecutor();
    return {
      name,
      recoveryPolicy: "manual",
      async start(req) {
        const decision = await permissionPolicy({
          sessionId: req.attemptId,
          toolCall: {
            toolCallId: req.attemptId,
            title: "允许 Pi 使用文件与命令工具执行本次任务",
            status: "pending",
          },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "允许本次执行" },
            { optionId: "reject_once", kind: "reject_once", name: "拒绝" },
          ],
        });
        if (decision.outcome.outcome !== "selected" || decision.outcome.optionId !== "allow_once")
          return {
            ok: false,
            exitCode: null,
            stdout: "",
            stderr: "Pi 执行未获授权",
            durationMs: 0,
            outputRef: null,
          };
        req.signal?.throwIfAborted();
        return pi.start(req);
      },
    };
  }
  throw new Error(`unknown_executor: ${name}`);
}
export async function loadExecutorAdapter(
  file = process.env.PROTEUS_EXECUTORS_CONFIG ?? process.env.PROTEUS_EXECUTOR_ADAPTER,
): Promise<ExecutorSetup | undefined> {
  if (file === undefined) return undefined;
  if (!file.trim() || /^[a-z][a-z\d+.-]*:/i.test(file))
    throw new Error("--executor-adapter 必须是本地文件路径");
  const path = resolve(file);
  if (![".js", ".mjs", ".ts", ".mts"].includes(extname(path)))
    throw new Error("执行器适配器文件必须为 .js、.mjs、.ts 或 .mts");
  let value: unknown;
  try {
    if (!(await stat(path)).isFile()) throw new Error("not_a_file");
    const module = await import(pathToFileURL(path).href);
    value = typeof module.default === "function" ? await module.default() : module.default;
  } catch {
    throw new Error(`执行器适配器加载失败：${path}；请检查文件、依赖与初始化配置`);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === "proteus-executors-v1"
  )
    return executorConfiguration(value as ExecutorsConfiguration);
  return checkedExecutorAdapter(value);
}
export function checkedExecutorAdapter(value: unknown): ExecutorAdapter {
  const a = value as ExecutorAdapter | null;
  if (
    !a ||
    a.version !== "proteus-executor-adapter-v1" ||
    typeof a.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(a.name) ||
    typeof a.create !== "function"
  )
    throw new Error("执行器适配器需要 version、name 和 create 方法");
  if (
    [
      "local-process",
      "web-coder",
      "codex",
      "claude",
      "codex-acp",
      "claude-code-acp",
      "pi",
      "opencode",
      "fake-acp",
    ].includes(a.name)
  )
    throw new Error("执行器名称与内置执行器冲突");
  return Object.freeze({ version: a.version, name: a.name, create: a.create.bind(a) });
}
export function executorFromAdapter(
  input: ExecutorAdapter,
  permissionPolicy: AcpPermissionPolicy = denyAllPolicy,
): ExecutorProvider {
  const adapter = checkedExecutorAdapter(input);
  return {
    name: adapter.name,
    recoveryPolicy: "manual",
    async start(request) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(request.timeoutMs),
        ...(request.signal ? [request.signal] : []),
      ]);
      signal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        const provider = await Promise.race([
          Promise.resolve().then(() =>
            adapter.create({
              signal,
              createAcpExecutor: (options) =>
                new AcpExecutor({ ...options, name: adapter.name, permissionPolicy }),
            }),
          ),
          cancelled,
        ]);
        signal.throwIfAborted();
        if (
          !provider ||
          provider.name !== adapter.name ||
          typeof provider.start !== "function" ||
          !["manual", "retry-safe"].includes(provider.recoveryPolicy)
        )
          throw new Error("invalid_executor_provider");
        // 初始化也占用同一 deadline；不在超时后派发迟到的执行器。
        return await provider.start({ ...request, signal });
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
