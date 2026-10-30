import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it("从仓库之外启动 CLI，默认发现 ~/.proteus-local 并加载相邻模块", () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-local-startup-"));
  const local = join(root, ".proteus-local");
  mkdirSync(local);
  const marker = join(root, "loaded");
  writeFileSync(
    join(local, "traex.mjs"),
    `export default {version:'proteus-executor-adapter-v1',name:'traex',create(){throw new Error('must not execute');}};`,
  );
  writeFileSync(
    join(local, "executors.config.mjs"),
    `import {appendFileSync} from 'node:fs'; import traex from './traex.mjs'; appendFileSync(${JSON.stringify(marker)},'executor\n'); export default {version:'proteus-executors-v1',enabled:['traex'],default:'traex',adapters:[traex]};`.replace(
      "'executor\n'",
      "'executor\\n'",
    ),
  );
  writeFileSync(
    join(local, "model-adapter.mjs"),
    `import {appendFileSync} from 'node:fs'; export default async()=>{appendFileSync(${JSON.stringify(marker)},'model\n');return {version:'proteus-model-adapter-v1',id:'local@1',serviceId:'private',async generate(){throw new Error('must not call');}};};`.replace(
      "'model\n'",
      "'model\\n'",
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../bin/proteus.mjs", import.meta.url)),
      "init",
      "--home",
      join(root, "instance"),
      "--json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        HOME: root,
        PROTEUS_LOCAL_DIR: undefined,
        PROTEUS_MODEL_ADAPTER: undefined,
        PROTEUS_EXECUTORS_CONFIG: undefined,
        PROTEUS_EXECUTOR_ADAPTER: undefined,
      },
    },
  );
  expect(result.stderr).not.toContain("加载失败");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveProperty("snapshotId");
  expect(readFileSync(marker, "utf8")).toBe("model\nexecutor\n");
});
