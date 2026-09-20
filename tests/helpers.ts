import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openInstance, type AppInstance } from "../src/app/instance.ts";
import { installSeed } from "../src/app/seed.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures/stats", import.meta.url));
export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

export function tempInstanceRoot(): string {
  return mkdtempSync(join(tmpdir(), "proteos-test-"));
}

/** 建临时实例并安装 seed（每次调用都是干净实例） */
export function bootSeededInstance(root: string = tempInstanceRoot()): AppInstance {
  const inst = openInstance(root);
  installSeed({
    kernel: inst.kernel,
    storage: inst.storage,
    blobs: inst.blobs,
    clock: { now: Date.now },
  });
  return inst;
}
