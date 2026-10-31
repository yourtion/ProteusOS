import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DecisionProvider } from "../decision/index.ts";
import type { RouteProposer } from "../evolution/consolidation.ts";
import type { CompileBackend } from "../evolution/compile-types.ts";
import type { SandboxBackend } from "../runtime/sandbox.ts";
import type { ModelAdapter } from "../model/index.ts";
import { LlmDecisionProvider } from "../adapters/decision-llm/index.ts";
import { LlmRouteProposer } from "../adapters/consolidation-llm/index.ts";
import { discoverLocalModule, expandUserPath } from "./local-config.ts";

/** User-owned implementations of existing runtime/evolution interfaces. */
export interface RuntimeAdapter {
  version: "proteus-runtime-adapter-v1";
  id: string;
  decisions?: readonly DecisionProvider[];
  routeProposer?: RouteProposer;
  compileBackend?: CompileBackend;
  capabilitySandbox?: SandboxBackend;
}
export interface RuntimeAdapterContext {
  modelAdapter?: ModelAdapter;
  createLlmDecisionProvider(options?: { adapter?: ModelAdapter }): LlmDecisionProvider;
  createLlmRouteProposer(options?: { adapter?: ModelAdapter; model?: string }): LlmRouteProposer;
}
export type RuntimeAdapterFactory = (
  context: RuntimeAdapterContext,
) => RuntimeAdapter | Promise<RuntimeAdapter>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function name(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}
function checkDecision(value: unknown): asserts value is DecisionProvider {
  if (
    !object(value) ||
    !name(value.name) ||
    typeof value.remote !== "boolean" ||
    typeof value.decide !== "function" ||
    typeof value.capabilities !== "function" ||
    (value.prepareRequest !== undefined && typeof value.prepareRequest !== "function") ||
    (value.callProvenance !== undefined && typeof value.callProvenance !== "function")
  )
    throw new Error("决策适配器需要 name、remote、capabilities 和 decide");
  let capabilities: unknown;
  try {
    capabilities = value.capabilities();
  } catch {
    throw new Error("决策适配器 capabilities 调用失败");
  }
  if (
    !object(capabilities) ||
    !Array.isArray(capabilities.problems) ||
    !capabilities.problems.length ||
    capabilities.problems.some((p) => !["choice", "gate", "rank"].includes(p)) ||
    new Set(capabilities.problems).size !== capabilities.problems.length
  )
    throw new Error("决策适配器 capabilities.problems 非法");
}

/** Validate before opening storage. Keep providers intact so this/state and usage getters survive. */
export function checkedRuntimeAdapter(value: unknown): RuntimeAdapter {
  if (
    !object(value) ||
    value.version !== "proteus-runtime-adapter-v1" ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9@._/-]{0,127}$/.test(value.id)
  )
    throw new Error("运行时适配器需要 version 和不含凭据的 id");
  const fields = [
    "version",
    "id",
    "decisions",
    "routeProposer",
    "compileBackend",
    "capabilitySandbox",
  ];
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("运行时适配器包含未知配置字段");
  if (value.decisions !== undefined && !Array.isArray(value.decisions))
    throw new Error("运行时适配器 decisions 必须是数组");
  const decisions = (value.decisions ?? []) as unknown[];
  const names = new Set<string>();
  for (const provider of decisions) {
    checkDecision(provider);
    if (provider.name === "decision-rule" || names.has(provider.name))
      throw new Error("决策名称重复或与内置 decision-rule 冲突");
    names.add(provider.name);
  }
  if (
    value.routeProposer !== undefined &&
    (!object(value.routeProposer) ||
      !name(value.routeProposer.name) ||
      typeof value.routeProposer.propose !== "function")
  )
    throw new Error("学习提议适配器需要 name 和 propose");
  if (value.compileBackend !== undefined) {
    const backend = value.compileBackend;
    if (
      !object(backend) ||
      !["fixture", "real"].includes(backend.mode as string) ||
      typeof backend.version !== "string" ||
      !backend.version.trim() ||
      typeof backend.bounds !== "function"
    )
      throw new Error("编译适配器需要 mode、version、provider 和 bounds");
    checkDecision(backend.provider);
  }
  if (
    value.capabilitySandbox !== undefined &&
    (!object(value.capabilitySandbox) ||
      !name(value.capabilitySandbox.name) ||
      typeof value.capabilitySandbox.isolated !== "boolean" ||
      typeof value.capabilitySandbox.available !== "function" ||
      typeof value.capabilitySandbox.run !== "function")
  )
    throw new Error("能力沙箱适配器需要 name、isolated、available 和 run");
  if (
    !decisions.length &&
    value.routeProposer === undefined &&
    value.compileBackend === undefined &&
    value.capabilitySandbox === undefined
  )
    throw new Error("运行时适配器至少需要提供一种实现");
  return Object.freeze({
    version: "proteus-runtime-adapter-v1",
    id: value.id,
    decisions: Object.freeze([...decisions]) as readonly DecisionProvider[],
    routeProposer: value.routeProposer as RouteProposer | undefined,
    compileBackend: value.compileBackend as CompileBackend | undefined,
    capabilitySandbox: value.capabilitySandbox as SandboxBackend | undefined,
  });
}

export async function loadRuntimeAdapter(
  file = process.env.PROTEUS_RUNTIME_ADAPTER,
  modelAdapter?: ModelAdapter,
): Promise<RuntimeAdapter | undefined> {
  file ??= await discoverLocalModule("runtime-adapter");
  if (file === undefined) return undefined;
  if (!file.trim() || /^[a-z][a-z\d+.-]*:/i.test(file))
    throw new Error("--runtime-adapter 必须是本地文件路径");
  const path = resolve(expandUserPath(file));
  if (![".js", ".mjs", ".ts", ".mts"].includes(extname(path)))
    throw new Error("运行时适配器文件必须为 .js、.mjs、.ts 或 .mts");
  const model = (adapter?: ModelAdapter) => {
    const selected = adapter ?? modelAdapter;
    if (!selected) throw new Error("需要模型适配器");
    return selected;
  };
  const context: RuntimeAdapterContext = {
    modelAdapter,
    createLlmDecisionProvider: (options = {}) =>
      new LlmDecisionProvider({ adapter: model(options.adapter) }),
    createLlmRouteProposer: (options = {}) =>
      new LlmRouteProposer({ adapter: model(options.adapter), model: options.model }),
  };
  let value: unknown;
  try {
    if (!(await stat(path)).isFile()) throw new Error("not_a_file");
    const module = await import(pathToFileURL(path).href);
    value = typeof module.default === "function" ? await module.default(context) : module.default;
  } catch {
    throw new Error(`运行时适配器加载失败：${path}；请检查文件、依赖与初始化配置`);
  }
  return checkedRuntimeAdapter(value);
}
