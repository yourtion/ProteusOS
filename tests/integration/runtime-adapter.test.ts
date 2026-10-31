import type { SandboxExecution } from "../../src/runtime/sandbox.ts";
import { expect, it } from "vitest";
import { openInstance } from "../../src/app/instance.ts";
import { Workbench } from "../../src/app/workbench/service.ts";
import { installSeed } from "../../src/app/seed.ts";
import type { DecisionProvider } from "../../src/decision/index.ts";
import type { RuntimeAdapter } from "../../src/app/runtime-adapter.ts";
import { fixturePath, installCustomGenome, tempInstanceRoot } from "../helpers.ts";
import { compileHarness } from "../fixtures/compilation/harness.ts";

it("CLI 实例与 Web Host 的决策注册实际驱动执行图，非法选择不会派发执行器", async () => {
  for (const web of [false, true]) {
    let calls = 0;
    let choice = "local-process";
    const decision: DecisionProvider = {
      name: "custom-decision",
      remote: false,
      capabilities: () => ({ problems: ["choice"] }),
      async decide(req) {
        calls++;
        return {
          kind: "value",
          value: choice,
          provenance: { provider: this.name, policyVersion: req.policy.versionId },
        };
      },
    };
    const runtimeAdapter: RuntimeAdapter = {
      version: "proteus-runtime-adapter-v1",
      id: "test@1",
      decisions: [decision],
    };
    const host = web ? new Workbench({ home: tempInstanceRoot(), runtimeAdapter }) : undefined;
    const app = host?.instance ?? openInstance(tempInstanceRoot(), { runtimeAdapter });
    try {
      installSeed({ ...app, clock: { now: Date.now } });
      installCustomGenome(app, {
        graph: {
          schemaVersion: 2,
          kind: "dag-v1",
          nodes: [
            {
              id: "route",
              type: "decision",
              provider: "custom-decision",
              problem: "choice",
              options: ["local-process"],
              context: { nodeType: "execute" },
            },
            { id: "stats", type: "execute", executorFrom: "route", dependsOn: ["route"] },
            {
              id: "check",
              type: "verify",
              verifier: "stats-acceptance",
              inputFrom: "stats",
              dependsOn: ["stats"],
            },
          ],
        },
      });
      const task = {
        requestedBy: "principal-local",
        goal: "custom route",
        budget: { maxAttempts: 1, maxWallClockSeconds: 15 },
        inputs: [fixturePath("input-a")],
        acceptance: {
          outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
          verifier: "stats-acceptance",
        },
      };
      const done = await app.runtime.submitTask(task);
      expect(done.state).toBe("succeeded");
      expect(done.decisions[0]).toMatchObject({
        provider: "custom-decision",
        value: "local-process",
      });
      expect(done.attempts).toHaveLength(1);
      choice = "unknown";
      const invalid = await app.runtime.submitTask(task);
      expect(invalid.failureReason).toBe("decision_invalid_output");
      expect(invalid.attempts).toHaveLength(0);
      expect(calls).toBe(2);
    } finally {
      if (host) await host.close();
      else app.close();
    }
  }
});

it("运行时模块的编译后端实际执行有界学习；无上界时拒绝调用", async () => {
  const h = await compileHarness();
  h.app.close();
  const app = openInstance(h.root, {
    runtimeAdapter: {
      version: "proteus-runtime-adapter-v1",
      id: "compile@1",
      compileBackend: h.port,
    },
  });
  try {
    const bounds = h.port.bounds;
    h.port.bounds = () => null;
    const { job } = app.evolution.compiler.submit(h.input);
    expect(await app.evolution.compiler.run(job.id)).toMatchObject({ state: "failed" });
    expect(h.backend.requests).toHaveLength(0);
    h.port.bounds = bounds;
    const next = app.evolution.compiler.submit({
      ...h.input,
      budget: { ...h.input.budget, wallClockMs: 29999 },
    }).job;
    expect(await app.evolution.compiler.run(next.id)).toMatchObject({ state: "completed" });
    expect(h.backend.requests).toHaveLength(4);
  } finally {
    app.close();
  }
});

it("能力沙箱从运行时模块注入；不可用时拒绝，恢复后实际经该后端执行", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const { ensureCapabilityGenome } = await import("../../src/evolution/assets.ts");
  const { BareProcessBackend } = await import("../../src/runtime/sandbox.ts");
  const { upgradeJudgeToActive } = await import("../helpers.ts");
  const cfs = fileURLToPath(new URL("../fixtures/changed-file-summary", import.meta.url));
  class LocalTestSandbox extends BareProcessBackend {
    ready = false;
    calls = 0;
    override available() {
      return { ok: this.ready, reason: "fixture unavailable" };
    }
    override run(exec: SandboxExecution) {
      this.calls++;
      return super.run(exec);
    }
  }
  const sandbox = new LocalTestSandbox();
  const app = openInstance(tempInstanceRoot(), {
    runtimeAdapter: {
      version: "proteus-runtime-adapter-v1",
      id: "sandbox@1",
      capabilitySandbox: sandbox,
    },
  });
  try {
    installSeed({ ...app, clock: { now: Date.now } });
    upgradeJudgeToActive(app);
    const genome = ensureCapabilityGenome(
      { ...app, clock: { now: Date.now } },
      {
        baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
        capabilities: [
          {
            name: "changed-file-summary",
            module: {
              kind: "capability-module-v1",
              name: "changed-file-summary",
              entry: "index.mjs",
              files: [
                {
                  path: "index.mjs",
                  content: readFileSync(join(cfs, "implementation.mjs"), "utf8"),
                },
              ],
            },
          },
        ],
        createdBy: "principal-local",
      },
    );
    const task = {
      requestedBy: "principal-local",
      goal: "分类变更",
      inputs: [join(cfs, "inputs", "changed-files.json")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 20 },
      requires: ["changed-file-summary"],
      acceptance: { outputSchema: join(cfs, "schema.json"), verifier: "stats-acceptance" },
    };
    expect(
      await app.runtime.submitTask(task, { purpose: "evaluation", snapshotId: genome.snapshot.id }),
    ).toMatchObject({ state: "failed" });
    expect(sandbox.calls).toBe(0);
    sandbox.ready = true;
    expect(
      await app.runtime.submitTask(task, { purpose: "evaluation", snapshotId: genome.snapshot.id }),
    ).toMatchObject({ state: "succeeded" });
    expect(sandbox.calls).toBe(1);
  } finally {
    app.close();
  }
});
