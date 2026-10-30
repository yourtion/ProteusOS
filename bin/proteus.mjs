#!/usr/bin/env node
/**
 * proteus CLI 启动器：经 tsx 加载 TypeScript 源码（M0 无构建步骤，ADR 0004）。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/app/cli.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--import", import.meta.resolve("tsx/esm"), cliPath, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
