import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../helpers.ts";
it("CLI 支持 TS 文件和环境变量，显式路径优先；坏模块阻止 Web 启动", () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-executor-startup-"));
  const file = join(root, "adapter.ts"),
    marker = join(root, "loaded");
  writeFileSync(
    file,
    `import {appendFileSync} from 'node:fs'; export default async () => { const name: string = 'custom'; appendFileSync(${JSON.stringify(marker)}, 'x'); return {version:'proteus-executor-adapter-v1',name,create(){throw new Error('must not execute during startup');}}; };`,
  );
  const run = (args: string[], envFile: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "src/app/cli.ts", ...args, "--home", join(root, "home")],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PROTEUS_EXECUTOR_ADAPTER: envFile },
        timeout: 10000,
      },
    );
  expect(run(["init", "--executor-adapter", file], "missing.mjs").status).toBe(0);
  expect(run(["runs", "--json"], file).status).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("xx");
  const bad = run(["web"], "missing.mjs");
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("执行器适配器加载失败");
});
