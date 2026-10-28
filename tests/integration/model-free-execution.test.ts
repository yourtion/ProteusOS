import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ModelFreeNodeSandbox,
  ModelFreeProcessExecutor,
  modelFreeUsage,
} from "../../src/runtime/model-free.ts";
import { bootSeededInstance, fixturePath, REPO_ROOT } from "../helpers.ts";
import { openInstance } from "../../src/app/instance.ts";

it.skipIf(Number(process.versions.node.split(".")[0]) < 26)(
  "受约束 worker 不能联网、启动子进程/Worker、读取外部资料或继承凭据",
  () => {
    const root = mkdtempSync(join(tmpdir(), "proteus-permission-"));
    const outside = mkdtempSync(join(tmpdir(), "proteus-private-"));
    writeFileSync(join(outside, "private"), "private");
    const entry = join(root, "entry.mjs");
    writeFileSync(
      entry,
      `
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
const denied = {};
for (const [name, fn] of Object.entries({
  network: () => fetch('http://127.0.0.1:12345'),
  child: () => spawnSync(process.execPath, ['-e','process.exit()']),
  worker: () => new Worker('process.exit()', {eval:true}),
  filesystem: () => fs.readFileSync(${JSON.stringify(join(outside, "private"))}),
})) { try { await fn(); denied[name]=false; } catch(e) { denied[name]=e.code === 'ERR_ACCESS_DENIED' || e.cause?.code === 'ERR_ACCESS_DENIED'; } }
fs.writeFileSync('output.json', JSON.stringify({denied, env:Object.keys(process.env).filter(k => k !== '__CF_USER_TEXT_ENCODING')}));
`,
    );
    try {
      const backend = new ModelFreeNodeSandbox();
      const result = backend.run({
        command: ["node", "entry.mjs"],
        hostWorkspace: root,
        profile: { network: "none", timeoutMs: 5000, cpus: 1, memoryMb: 128 },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "output.json"), "utf8"))).toEqual({
        denied: { network: true, child: true, worker: true, filesystem: true },
        env: [],
      });
      expect(result.modelConstraint).toMatchObject({
        network: "denied",
        environment: "not-inherited",
      });
      expect(() =>
        backend.run({
          command: ["sh", "entry.mjs"],
          hostWorkspace: root,
          profile: { network: "none", timeoutMs: 1000, cpus: 1, memoryMb: 128 },
        }),
      ).toThrow(/only supports/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

it.skipIf(Number(process.versions.node.split(".")[0]) < 26)(
  "真实本地执行持久化零模型证明，清理重开后可核验，缺失或篡改 trace 不可计零",
  async () => {
    const executor = new ModelFreeProcessExecutor(
      join(REPO_ROOT, "src/adapters/executor-process/stats-worker.mjs"),
    );
    const app = bootSeededInstance(undefined, new Map([[executor.name, executor]]));
    let id: string;
    try {
      const result = await app.runtime.submitTask({
        requestedBy: "principal-local",
        goal: "统计文本",
        inputs: [fixturePath("input-a")],
        budget: { maxAttempts: 1, maxWallClockSeconds: 10 },
        acceptance: {
          verifier: "stats-acceptance",
          outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        },
      });
      expect(result.state).toBe("succeeded");
      id = result.runId;
      expect(modelFreeUsage(result.attempts[0]!.evidence, app.blobs)).toMatchObject({
        modelCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, costAmount: null },
      });
    } finally {
      app.close();
    }
    rmSync(join(app.root, "workspaces"), { recursive: true });
    const reopened = openInstance(app.root);
    try {
      const e = reopened.runtime.getRunSummary(id!).attempts[0]!.evidence!;
      expect(modelFreeUsage(e, reopened.blobs)?.modelCalls).toBe(0);
      expect(modelFreeUsage({ ...e, modelConstraint: undefined }, reopened.blobs)).toBeNull();
      expect(() =>
        modelFreeUsage(
          { ...e, modelConstraint: { ...e.modelConstraint!, entryDigest: "a".repeat(64) } },
          reopened.blobs,
        ),
      ).toThrow(/not_persisted/);
      expect(() => modelFreeUsage({ ...e, usage: null }, reopened.blobs)).toThrow(/usage_mismatch/);
      expect(() => modelFreeUsage({ ...e, traceRef: null }, reopened.blobs)).toThrow(
        /not_persisted/,
      );
    } finally {
      reopened.close();
    }
  },
);
