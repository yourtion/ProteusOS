import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkedRuntimeAdapter, loadRuntimeAdapter } from "../../src/app/runtime-adapter.ts";
import { loadAppAdapters } from "../../src/app/adapters.ts";
import { llmDemosRequest } from "../fixtures/decision/llm-demos.ts";

const provider = () => ({
  name: "custom-decision",
  remote: false,
  capabilities: () => ({ problems: ["choice"] }),
  async decide() {
    return { kind: "abstain" };
  },
});
const manifest = (extra = {}) => ({
  version: "proteus-runtime-adapter-v1",
  id: "custom@1",
  decisions: [provider()],
  ...extra,
});
afterEach(() => vi.unstubAllEnvs());

it("拒绝非法接口、未知字段、重复名称和覆盖内置规则", () => {
  for (const value of [
    null,
    {},
    manifest({ typo: true }),
    manifest({ decisions: [] }),
    manifest({ decisions: [provider(), provider()] }),
    manifest({ decisions: [{ ...provider(), name: "decision-rule" }] }),
    manifest({ decisions: [{ ...provider(), remote: undefined }] }),
    manifest({ decisions: [{ ...provider(), capabilities: () => ({ problems: ["unknown"] }) }] }),
    manifest({ routeProposer: { name: "x" } }),
    manifest({ compileBackend: { mode: "real" } }),
    manifest({ capabilitySandbox: { name: "x", isolated: true } }),
  ])
    expect(() => checkedRuntimeAdapter(value)).toThrow();
  expect(() =>
    checkedRuntimeAdapter(
      manifest({
        decisions: [
          {
            ...provider(),
            capabilities() {
              throw new Error("SECRET");
            },
          },
        ],
      }),
    ),
  ).toThrow("capabilities 调用失败");
});

it("加载相邻模块和异步工厂，保留方法 this、状态与动态计量 getter", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-runtime-"));
  writeFileSync(
    join(root, "provider.mjs"),
    `export default {name:'custom-decision',remote:false,n:0,capabilities(){return {problems:['choice']}},async decide(req){return {kind:'value',value:String(++this.n),provenance:{provider:this.name,policyVersion:req.policy.versionId}}}};`,
  );
  const file = join(root, "my runtime.mjs");
  writeFileSync(
    file,
    `import p from './provider.mjs'; export default async()=>({version:'proteus-runtime-adapter-v1',id:'local@1',decisions:[p],routeProposer:{name:'local-learner',n:0,get lastUsage(){return {inputTokens:this.n,outputTokens:1}},async propose(){this.n++;return []}}});`,
  );
  const adapter = (await loadRuntimeAdapter(file))!;
  expect(await adapter.decisions![0]!.decide(llmDemosRequest())).toMatchObject({ value: "1" });
  expect(await adapter.decisions![0]!.decide(llmDemosRequest())).toMatchObject({ value: "2" });
  await adapter.routeProposer!.propose({ gapSamples: [], options: [], features: [] });
  expect(adapter.routeProposer!.lastUsage).toEqual({ inputTokens: 1, outputTokens: 1 });
  await expect(loadRuntimeAdapter("https://example.com/x.mjs")).rejects.toThrow("本地文件");
  writeFileSync(join(root, "bad.mjs"), `throw new Error('SECRET');`);
  await expect(loadRuntimeAdapter(join(root, "bad.mjs"))).rejects.toThrow("运行时适配器加载失败");
  await expect(loadRuntimeAdapter(join(root, "bad.mjs"))).rejects.not.toThrow("SECRET");
});

it("默认发现、环境与显式路径优先级；本地模型可注入决策与学习工厂", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-runtime-config-"));
  const local = join(root, ".proteus-local");
  mkdirSync(local);
  vi.stubEnv("PROTEUS_LOCAL_DIR", local);
  vi.stubEnv("PROTEUS_MODEL_ADAPTER", undefined);
  vi.stubEnv("PROTEUS_EXECUTORS_CONFIG", undefined);
  vi.stubEnv("PROTEUS_EXECUTOR_ADAPTER", undefined);
  vi.stubEnv("PROTEUS_RUNTIME_ADAPTER", undefined);
  expect(await loadRuntimeAdapter()).toBeUndefined();
  writeFileSync(
    join(local, "model-adapter.mjs"),
    `export default {version:'proteus-model-adapter-v1',id:'test@1',serviceId:'test',async generate(req){return {text:req.system?'{"kind":"value","value":"local-process"}':'{"proposals":[]}'}}};`,
  );
  const file = join(local, "runtime-adapter.mjs");
  writeFileSync(
    file,
    `export default ({createLlmDecisionProvider,createLlmRouteProposer})=>({version:'proteus-runtime-adapter-v1',id:'runtime@1',decisions:[createLlmDecisionProvider()],routeProposer:createLlmRouteProposer({model:'private-model'})});`,
  );
  const adapters = await loadAppAdapters();
  expect(await adapters.runtimeAdapter!.decisions![0]!.decide(llmDemosRequest())).toMatchObject({
    kind: "value",
    value: "local-process",
  });
  expect(
    await adapters.runtimeAdapter!.routeProposer!.propose({
      gapSamples: [{ goal: "g", features: { f: true }, reason: "x" }],
      options: ["x"],
      features: ["f"],
    }),
  ).toEqual([]);
  vi.stubEnv("PROTEUS_RUNTIME_ADAPTER", join(root, "missing.mjs"));
  await expect(loadRuntimeAdapter()).rejects.toThrow("加载失败");
  expect((await loadAppAdapters({ runtimeAdapter: file })).runtimeAdapter!.id).toBe("runtime@1");
  vi.stubEnv("PROTEUS_RUNTIME_ADAPTER", undefined);
  writeFileSync(join(local, "runtime-adapter.ts"), "export default {};");
  await expect(loadRuntimeAdapter()).rejects.toThrow("多个");
});
