import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../helpers.ts";

it("CLI 从 TS 文件或环境加载异步工厂，显式路径优先，坏模块阻止 CLI/Web 启动", () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-startup-"));
  const file = join(root, "my model.ts");
  const marker = join(root, "loaded");
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs';
    export default async function () { const id: string = 'custom@1';
      appendFileSync(${JSON.stringify(marker)}, 'loaded\n');
      return { version: 'proteus-model-adapter-v1', id, serviceId: 'local', async generate() { throw new Error('must not call'); } };
    }`.replace("'loaded\n'", "'loaded\\n'"),
  );
  const run = (args: string[], envFile: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "src/app/cli.ts", ...args, "--home", join(root, "instance")],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, PROTEUS_MODEL_ADAPTER: envFile } },
    );
  expect(run(["init", "--model-adapter", relative(REPO_ROOT, file)], "missing.mjs").status).toBe(0);
  expect(run(["runs", "--json"], file).status).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("loaded\nloaded\n");
  for (const command of ["init", "web"]) {
    const result = run([command], "missing.mjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("模型适配器加载失败");
    expect(result.stdout).not.toContain("Proteus 工作台");
  }
});
