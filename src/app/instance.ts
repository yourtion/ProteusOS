import type { CompileBackend } from "../evolution/compile-types.ts";
import { AdaptiveJournal } from "./experiment/journal.ts";
import { AdaptiveRunSlots } from "./experiment/run-slots.ts";
import { guardObservedRun } from "./experiment/observed.ts";
import { guardDiagnosticRun } from "./experiment/diagnostic.ts";
import { bindCompileDevelopment } from "./experiment/development.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";
import type { DecisionProvider } from "../decision/index.ts";
import { RuleDecisionProvider } from "../adapters/decision-rule/index.ts";
import { AcpExecutor } from "../adapters/executor-acp/index.ts";
import { LocalProcessExecutor } from "../adapters/executor-process/index.ts";
import { PiExecutor } from "../adapters/executor-pi/index.ts";
import { llmProposerFromEnv } from "../adapters/consolidation-llm/index.ts";
import type { RouteProposer } from "../evolution/consolidation.ts";
import { Federation } from "../federation/index.ts";
import { PublicationTrust } from "../federation/trust.ts";
import { Evolution } from "../evolution/index.ts";
import { Kernel } from "../kernel/index.ts";
import { Runtime, type RuntimeDeps } from "../runtime/index.ts";
import type { ExecutorProvider } from "../runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET, type OrganismBudget } from "../runtime/types.ts";
import { MicrosandboxBackend, type SandboxBackend } from "../runtime/sandbox.ts";
import { BlobStore } from "../storage/blobs.ts";
import { MIGRATIONS } from "../storage/migrations.ts";
import { SqliteDb } from "../storage/sqlite.ts";
import { Storage } from "../storage/store.ts";
import { createLogger, type Logger } from "./logger.ts";
import { ORGANISM_ID, PRINCIPAL_ID } from "./seed.ts";

export function resolveInstanceRoot(flag?: string): string {
  if (flag) return flag;
  if (process.env.PROTEUS_HOME) return process.env.PROTEUS_HOME;
  return join(homedir(), ".proteus");
}

export interface AppInstance {
  root: string;
  storage: Storage;
  kernel: Kernel;
  runtime: Runtime;
  evolution: Evolution;
  adaptive: AdaptiveJournal;
  adaptiveRuns: AdaptiveRunSlots;
  federation: Federation;
  sharingTrust: PublicationTrust;
  blobs: BlobStore;
  logger: Logger;
  close(): void;
}

/**
 * 解析 npm 包的 bin 入口：import.meta.resolve 拿到的是库主入口（不会自启动
 * stdio 服务），必须用 package.json 的 bin 字段定位真正的可执行脚本。
 */
export function resolvePackageBin(packageName: string, binName: string): string {
  const mainPath = fileURLToPath(import.meta.resolve(packageName));
  let dir = dirname(mainPath);
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`未找到 ${packageName} 的包根`);
    dir = parent;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const rel = pkg.bin?.[binName];
  if (!rel) throw new Error(`${packageName} 未提供 bin "${binName}"`);
  return resolve(dir, rel);
}

/**
 * 执行器注册表（M1）：图节点 executor 名 → 实现。
 * local-process（M0 worker）；claude-code-acp / codex-acp 经同一 AcpExecutor
 * 驱动官方 agent 适配器；pi 经官方 SDK 直连。
 * PROTEUS_FAKE_ACP_AGENT=<script> 时额外注册 fake-acp（测试/演练用，
 * 与真实适配器同一 ACP 合同）。
 */
export function buildExecutors(): Map<string, ExecutorProvider> {
  const workerPath = fileURLToPath(
    new URL("../adapters/executor-process/stats-worker.mjs", import.meta.url),
  );
  const executors = new Map<string, ExecutorProvider>();
  executors.set("local-process", new LocalProcessExecutor(workerPath));
  executors.set("pi", new PiExecutor("pi"));
  const fakeAgent = process.env.PROTEUS_FAKE_ACP_AGENT;
  if (fakeAgent) {
    executors.set("fake-acp", new AcpExecutor({ name: "fake-acp", agentEntry: fakeAgent }));
  }
  for (const [name, spec] of [
    [
      "claude-code-acp",
      { packageName: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
    ],
    ["codex-acp", { packageName: "@agentclientprotocol/codex-acp", bin: "codex-acp" }],
  ] as const) {
    try {
      executors.set(
        name,
        new AcpExecutor({
          name,
          agentEntry: resolvePackageBin(spec.packageName, spec.bin),
          captureClaudeUsage: name === "claude-code-acp",
        }),
      );
    } catch {
      // 适配器未安装时该执行器不注册；图中引用会得到明确的 unknown_executor
    }
  }
  return executors;
}

/** 默认决策注册表：规则路由（M0 语义）。实验实例按名称注入 LLM/oracle Provider */
export function buildDecisions(
  extra?: ReadonlyMap<string, DecisionProvider>,
): Map<string, DecisionProvider> {
  const decisions = new Map<string, DecisionProvider>([
    ["decision-rule", new RuleDecisionProvider()],
  ]);
  for (const [name, provider] of extra ?? []) {
    decisions.set(name, provider);
  }
  return decisions;
}

/** 组装依赖：领域模块不自行创建外部客户端（docs/architecture.md §Persistence） */
export function openInstance(
  root: string,
  options: {
    organismId?: string;
    actorId?: string;
    routeProposer?: RouteProposer;
    compileBackend?: CompileBackend;
    learningCallTimeoutMs?: number;
    logger?: Logger;
    organismBudget?: OrganismBudget;
    executors?: Map<string, ExecutorProvider>;
    onExecutionProgress?: RuntimeDeps["onExecutionProgress"];
    /** 追加按名称查找的 DecisionProvider（实验显式装配 LLM；默认仍只有规则） */
    decisions?: ReadonlyMap<string, DecisionProvider>;
    /** 单次决策调用超时上限（默认 15s，实验协议 §4.2） */
    decisionCallTimeoutMs?: number;
    /** 能力执行沙箱后端；缺省按 PROTEUS_SANDBOX（microsandbox→真隔离；未设→进程级） */
    capabilitySandbox?: SandboxBackend;
  } = {},
): AppInstance {
  for (const dir of [root, join(root, "blobs"), join(root, "workspaces"), join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new SqliteDb(join(root, "metadata.sqlite"));
  db.migrate(MIGRATIONS);

  const blobs = new BlobStore(join(root, "blobs"), join(root, "tmp"));
  const storage = new Storage(db);
  const clock = { now: () => Date.now() };
  const ids = { next: () => uuidv7() };
  const kernel = new Kernel(storage, clock, ids);
  const organismId = options.organismId ?? ORGANISM_ID;
  const actorId = options.actorId ?? PRINCIPAL_ID;
  if (kernel.getOrganism(organismId)) kernel.assertOrganismAccess(organismId, actorId);
  const capabilitySandbox =
    options.capabilitySandbox ??
    (process.env.PROTEUS_SANDBOX === "microsandbox" ? new MicrosandboxBackend() : undefined);
  let adaptiveRuns: AdaptiveRunSlots;
  const runtime = new Runtime({
    runGuard: (run, phase) => {
      adaptiveRuns.guard(run, phase);
      guardObservedRun({ storage, kernel, blobs }, run, phase);
      guardDiagnosticRun({ storage, kernel, blobs }, run, phase);
    },
    storage,
    kernel,
    organismId,
    executors: options.executors ?? buildExecutors(),
    onExecutionProgress: options.onExecutionProgress,
    decisions: buildDecisions(options.decisions),
    blobs,
    instanceRoot: root,
    clock,
    ids,
    organismBudget: options.organismBudget ?? DEFAULT_ORGANISM_BUDGET,
    actorId,
    decisionCallTimeoutMs: options.decisionCallTimeoutMs,
    capabilitySandbox,
  });
  const evolution = new Evolution({
    actorId,
    routeProposer: options.routeProposer ?? llmProposerFromEnv() ?? undefined,
    compileBackend: options.compileBackend,
    learningCallTimeoutMs: options.learningCallTimeoutMs,
    kernel,
    storage,
    blobs,
    runtime,
    organismId,
    instanceRoot: root,
    clock,
    ids,
  });
  let sharingTrust: PublicationTrust;
  const federation = new Federation({
    kernel,
    storage,
    blobs,
    evolution,
    organismId,
    actorId,
    clock,
    ids,
    verifySignature: (input) => sharingTrust.verify(input),
  });
  sharingTrust = new PublicationTrust({
    kernel,
    storage,
    blobs,
    federation,
    root,
    organismId,
    actorId,
    clock,
    ids,
  });
  const adaptive = new AdaptiveJournal({
    readRunReceipt: (id, reservationId) => adaptiveRuns.deriveReceipt(id, reservationId),
    kernel,
    storage,
    blobs,
    clock,
    ids,
    organismId,
    actorId,
    bindCompilation: (jobId, frozen) =>
      bindCompileDevelopment(
        { kernel, runtime, evolution, storage, blobs, organismId, actorId },
        jobId,
        frozen,
      ),
  });
  adaptiveRuns = new AdaptiveRunSlots({
    kernel,
    storage,
    blobs,
    clock,
    organismId,
    actorId,
    runtime,
    journal: adaptive,
  });
  return {
    root,
    storage,
    kernel,
    runtime,
    evolution,
    adaptive,
    adaptiveRuns,
    federation,
    sharingTrust,
    blobs,
    logger: options.logger ?? createLogger(),
    close: () => db.close(),
  };
}
