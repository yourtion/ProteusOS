import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { LocalProcessExecutor } from "../adapters/executor-process/index.ts";
import { Kernel } from "../kernel/index.ts";
import { Runtime } from "../runtime/index.ts";
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
  blobs: BlobStore;
  logger: Logger;
  close(): void;
}

/** 组装依赖：领域模块不自行创建外部客户端（docs/architecture.md §Persistence） */
export function openInstance(root: string, logger?: Logger): AppInstance {
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
  const workerPath = fileURLToPath(
    new URL("../adapters/executor-process/stats-worker.mjs", import.meta.url),
  );
  const runtime = new Runtime({
    storage,
    kernel,
    organismId: ORGANISM_ID,
    executor: new LocalProcessExecutor(workerPath),
    blobs,
    instanceRoot: root,
    clock,
    ids,
  });
  return {
    root,
    storage,
    kernel,
    runtime,
    blobs,
    logger: logger ?? createLogger(),
    close: () => db.close(),
  };
}
