import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { RuleDecisionProvider } from "../adapters/decision-rule/index.ts";
import { AcpExecutor } from "../adapters/executor-acp/index.ts";
import { LocalProcessExecutor } from "../adapters/executor-process/index.ts";
import { PiExecutor } from "../adapters/executor-pi/index.ts";
import { Evolution } from "../evolution/index.ts";
import { Kernel } from "../kernel/index.ts";
import { Runtime } from "../runtime/index.ts";
import type { ExecutorProvider } from "../runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET, type OrganismBudget } from "../runtime/types.ts";
import { BlobStore } from "../storage/blobs.ts";
import { MIGRATIONS } from "../storage/migrations.ts";
import { SqliteDb } from "../storage/sqlite.ts";
import { Storage } from "../storage/store.ts";
import { createLogger, type Logger } from "./logger.ts";
import { ORGANISM_ID } from "./seed.ts";

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
 */
export function buildExecutors(): Map<string, ExecutorProvider> {
  const workerPath = fileURLToPath(
    new URL("../adapters/executor-process/stats-worker.mjs", import.meta.url),
  );
  const executors = new Map<string, ExecutorProvider>();
  executors.set("local-process", new LocalProcessExecutor(workerPath));
  executors.set("pi", new PiExecutor("pi"));
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
        new AcpExecutor({ name, agentEntry: resolvePackageBin(spec.packageName, spec.bin) }),
      );
    } catch {
      // 适配器未安装时该执行器不注册；图中引用会得到明确的 unknown_executor
    }
  }
  return executors;
}

/** 组装依赖：领域模块不自行创建外部客户端（docs/architecture.md §Persistence） */
export function openInstance(
  root: string,
  options: {
    logger?: Logger;
    organismBudget?: OrganismBudget;
    executors?: Map<string, ExecutorProvider>;
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
  const runtime = new Runtime({
    storage,
    kernel,
    organismId: ORGANISM_ID,
    executors: options.executors ?? buildExecutors(),
    decision: new RuleDecisionProvider(),
    blobs,
    instanceRoot: root,
    clock,
    ids,
    organismBudget: options.organismBudget ?? DEFAULT_ORGANISM_BUDGET,
  });
  const evolution = new Evolution({
    kernel,
    storage,
    blobs,
    runtime,
    organismId: ORGANISM_ID,
    instanceRoot: root,
    clock,
    ids,
  });
  return {
    root,
    storage,
    kernel,
    runtime,
    evolution,
    blobs,
    logger: options.logger ?? createLogger(),
    close: () => db.close(),
  };
}
