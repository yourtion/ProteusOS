#!/usr/bin/env node
/**
 * proteus CLI 启动器：经 tsx 加载 TypeScript 源码（M0 无构建步骤，ADR 0004）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/app/cli.ts", import.meta.url));
const child = spawn(
  process.execPath,
  ["--import", import.meta.resolve("tsx/esm"), cliPath, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
// Keep the launcher alive and forward signals to the actual CLI/Web owner.
// Killing a spawnSync wrapper used to leave the old server and instance lock alive.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
