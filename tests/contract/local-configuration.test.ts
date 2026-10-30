import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { discoverLocalModule, expandUserPath } from "../../src/app/local-config.ts";
import { loadModelAdapter } from "../../src/app/model-adapter.ts";
import { executorConfiguration, loadExecutorAdapter } from "../../src/app/executor-adapter.ts";

function directory() {
  const root = mkdtempSync(join(tmpdir(), "proteus-local-config-"));
  vi.stubEnv("PROTEUS_LOCAL_DIR", root);
  for (const name of [
    "PROTEUS_MODEL_ADAPTER",
    "PROTEUS_EXECUTORS_CONFIG",
    "PROTEUS_EXECUTOR_ADAPTER",
  ])
    vi.stubEnv(name, undefined);
  return root;
}
afterEach(() => vi.unstubAllEnvs());
it("无需参数发现用户目录模型和配置，相对 import 可脱离仓库", async () => {
  const root = directory();
  writeFileSync(
    join(root, "traex.mjs"),
    `export default {version:'proteus-executor-adapter-v1',name:'traex',create(){throw new Error('no execution during startup');}}`,
  );
  writeFileSync(
    join(root, "executors.config.mjs"),
    `import traex from './traex.mjs'; export default {version:'proteus-executors-v1',enabled:['traex','pi'],default:'traex',adapters:[traex]};`,
  );
  writeFileSync(
    join(root, "model-adapter.mjs"),
    `export default async()=>({version:'proteus-model-adapter-v1',id:'local@1',serviceId:'private',async generate(){return {text:'local'};}});`,
  );
  const config = executorConfiguration(await loadExecutorAdapter());
  expect(config.enabled).toEqual(["traex", "pi"]);
  expect(config.default).toBe("traex");
  const model = (await loadModelAdapter())!;
  expect(model.id).toBe("local@1");
  expect(
    await model.generate({ model: "m", messages: [], maxOutputTokens: 1, temperature: 0 }, {}),
  ).toMatchObject({ text: "local" });
});
it("显式参数和环境优先于坏的本地配置；本地坏配置不静默回退", async () => {
  const root = directory();
  writeFileSync(join(root, "executors.config.mjs"), `throw new Error('SECRET_INITIALIZATION');`);
  const good = join(root, "override.mjs");
  writeFileSync(
    good,
    `export default {version:'proteus-executors-v1',enabled:['pi'],default:'pi'};`,
  );
  expect(executorConfiguration(await loadExecutorAdapter(good)).default).toBe("pi");
  vi.stubEnv("PROTEUS_EXECUTORS_CONFIG", good);
  expect(executorConfiguration(await loadExecutorAdapter()).default).toBe("pi");
  await expect(loadExecutorAdapter(join(root, "missing.mjs"))).rejects.toThrow("加载失败");
  vi.stubEnv("PROTEUS_EXECUTORS_CONFIG", undefined);
  await expect(loadExecutorAdapter()).rejects.toThrow("加载失败");
  await expect(loadExecutorAdapter()).rejects.not.toThrow("SECRET_INITIALIZATION");
});
it("缺少可选入口保留旧行为，同名多扩展名与目录入口报错", async () => {
  const root = directory();
  expect(await loadExecutorAdapter()).toBeUndefined();
  expect(await loadModelAdapter()).toBeUndefined();
  writeFileSync(join(root, "executors.config.ts"), "export default {};");
  writeFileSync(join(root, "executors.config.mjs"), "export default {};");
  await expect(discoverLocalModule("executors.config")).rejects.toThrow("多个");
  mkdirSync(join(root, "model-adapter.mjs"));
  await expect(loadModelAdapter()).rejects.toThrow("不是文件");
  expect(expandUserPath("~/adapters/x.mjs")).toBe(join(homedir(), "adapters/x.mjs"));
});
