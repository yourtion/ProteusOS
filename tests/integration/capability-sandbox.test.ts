import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { ensureCapabilityGenome } from "../../src/evolution/assets.ts";
import type { CapabilityGenome } from "../../src/evolution/assets.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type { CapabilityModule } from "../../src/runtime/capability.ts";
import type { SandboxBackend, SandboxExecution, SandboxResult } from "../../src/runtime/sandbox.ts";
import { bootSeededInstance, upgradeJudgeToActive } from "../helpers.ts";

/**
 * 能力执行经 SandboxBackend 的集成行为。
 * - 注入沙箱替身（宿主执行但走完整 port 路径）：能力 Run 成功、产物经工作区回收
 * - 沙箱后端不可用：capability 执行明确拒绝，不静默降级
 * - 缺省（无沙箱）：进程级行为保持（M2 回归）
 */

const CFS = fileURLToPath(new URL("../fixtures/changed-file-summary", import.meta.url));

/** 沙箱替身：记录调用并宿主执行（验证 port 链路与文件回收，不验证隔离本身） */
function recordingSandbox(override?: Partial<SandboxBackend>): SandboxBackend & {
  calls: SandboxExecution[];
} {
  const calls: SandboxExecution[] = [];
  const base: SandboxBackend = {
    name: "fake-sandbox",
    isolated: true,
    available: () => ({ ok: true }),
    run(exec: SandboxExecution): SandboxResult {
      calls.push(exec);
      // 宿主执行：cwd=工作区，命令同沙箱语义（node 为 PATH 内命令）
      const started = Date.now();
      const r = spawnSync(exec.command[0]!, exec.command.slice(1), {
        cwd: exec.hostWorkspace,
        encoding: "utf8",
        timeout: exec.profile.timeoutMs,
      });
      return {
        exitCode: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        durationMs: Date.now() - started,
      };
    },
  };
  return Object.assign(base, override, { calls });
}

let inst: AppInstance | undefined;
let judgeSnapshot: string | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const SUMMARY_TASK = {
  requestedBy: "principal-local",
  goal: "对变更清单生成可验证的文件分类摘要",
  inputs: [join(CFS, "inputs", "changed-files.json")],
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
  requires: ["changed-file-summary"],
  acceptance: {
    outputSchema: join(CFS, "schema.json"),
    verifier: "stats-acceptance",
  },
};

function moduleContent(): CapabilityModule {
  return {
    kind: "capability-module-v1",
    name: "changed-file-summary",
    entry: "index.mjs",
    files: [
      {
        path: "index.mjs",
        content: readFileSync(join(CFS, "implementation.mjs"), "utf8"),
      },
    ],
  };
}

/** 直接构造含能力的 Runtime（绕开 instance 缓存，注入沙箱） */
async function runCapabilityWith(sandbox: SandboxBackend | undefined) {
  const app = instance();
  judgeSnapshot ??= upgradeJudgeToActive(app);
  const genome: CapabilityGenome = ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
      capabilities: [{ name: "changed-file-summary", module: moduleContent() }],
      createdBy: "principal-local",
    },
  );
  const runtime = new Runtime({
    storage: app.storage,
    kernel: app.kernel,
    organismId: "organism-default",
    executors: new Map(),
    decisions: new Map([["decision-rule", new RuleDecisionProvider()]]),
    blobs: app.blobs,
    instanceRoot: app.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: { ...DEFAULT_BUDGET },
    capabilitySandbox: sandbox,
  });
  return runtime.submitTask(SUMMARY_TASK, {
    purpose: "evaluation",
    snapshotId: genome.snapshot.id,
  });
}

const DEFAULT_BUDGET = {
  normal: { maxConcurrentRuns: 8, maxInFlightAttempts: 32, maxInFlightWallClockSeconds: 86_400 },
  evaluation: {
    maxConcurrentRuns: 8,
    maxInFlightAttempts: 32,
    maxInFlightWallClockSeconds: 86_400,
  },
};

describe("能力执行的沙箱链路", () => {
  it("沙箱替身：capability Run 经 port 执行成功，产物与调用记录可审计", async () => {
    const sandbox = recordingSandbox();
    const summary = await runCapabilityWith(sandbox);

    expect(summary.state).toBe("succeeded");
    expect(sandbox.calls).toHaveLength(1);
    const call = sandbox.calls[0]!;
    expect(call.command).toEqual(["node", "capability/changed-file-summary/index.mjs"]);
    expect(call.profile.network).toBe("none");
    expect(call.hostWorkspace).toContain(join("workspaces", summary.runId));
    // 输出经工作区回收且通过验收
    expect(summary.checks.every((c) => c.passed)).toBe(true);
  });

  it("沙箱不可用：明确拒绝执行（execution_aborted），不静默降级到进程级", async () => {
    const unavailable = recordingSandbox({
      available: () => ({ ok: false, reason: "虚拟化不可用（CI 无 KVM）" }),
    });
    const summary = await runCapabilityWith(unavailable);

    expect(summary.state).toBe("failed");
    // 无进程执行（exitCode=null → execution_aborted），错误信息带原因与不降级声明
    expect(summary.failureReason).toBe("execution_aborted");
    expect(unavailable.calls).toHaveLength(0);
    const events = instance().storage.listEvents({ runId: summary.runId }, 50);
    const failed = events.find((e) => e.type === "attempt.failed");
    expect(String(failed?.payload["stderrTail"])).toContain("不静默降级");
    expect(String(failed?.payload["stderrTail"])).toContain("虚拟化不可用");
  });

  it("缺省无沙箱：进程级行为保持（M2 回归）", async () => {
    const summary = await runCapabilityWith(undefined);
    expect(summary.state).toBe("succeeded");
  });
});
