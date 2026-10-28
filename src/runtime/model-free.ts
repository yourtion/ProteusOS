import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import type { SandboxBackend, SandboxExecution, SandboxResult } from "./sandbox.ts";
import {
  ExecutionTrace,
  readExecutionTrace,
  type StoredExecutionEvidence,
} from "./execution-evidence.ts";
import type { BlobStore } from "../storage/blobs.ts";
import type { ExecutionRequest, ExecutorProvider } from "./types.ts";

/** 宿主配置的受信 JS worker；Node 权限模型不用于执行恶意代码。 */
export interface ModelFreeConstraint {
  version: "model-free-node-v1";
  nodeVersion: string;
  entryDigest: string;
  network: "denied";
  childProcesses: "denied";
  workers: "denied";
  environment: "not-inherited";
}

export function runModelFreeNode(
  exec: SandboxExecution,
  entry: string,
): SandboxResult & {
  constraint: ModelFreeConstraint;
} {
  if (Number(process.versions.node.split(".")[0]) < 26)
    throw new Error("model-free-node-v1 requires Node >=26 network permissions");
  const workspace = realpathSync(exec.hostWorkspace);
  const script = realpathSync(entry);
  const constraint: ModelFreeConstraint = {
    version: "model-free-node-v1",
    nodeVersion: process.version,
    entryDigest: digestOf(readFileSync(script, "utf8")),
    network: "denied",
    childProcesses: "denied",
    workers: "denied",
    environment: "not-inherited",
  };
  const start = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${script}`,
      `--allow-fs-read=${workspace}`,
      `--allow-fs-write=${workspace}`,
      script,
      workspace,
    ],
    {
      cwd: workspace,
      env: {},
      encoding: "utf8",
      timeout: exec.profile.timeoutMs,
      maxBuffer: 64 * 1024,
    },
  );
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - start,
    constraint,
  };
}

/** 只接受宿主持久化且与 trace 内约束事件一致的零模型用量；旧证据返回 null。 */
export function modelFreeUsage(
  evidence: StoredExecutionEvidence | undefined,
  blobs: Pick<BlobStore, "read">,
) {
  if (!evidence?.modelConstraint) return null;
  const c = evidence.modelConstraint;
  if (
    c.version !== "model-free-node-v1" ||
    !/^v(?:2[6-9]|[3-9]\d)\./.test(c.nodeVersion) ||
    !/^[a-f0-9]{64}$/.test(c.entryDigest) ||
    c.network !== "denied" ||
    c.childProcesses !== "denied" ||
    c.workers !== "denied" ||
    c.environment !== "not-inherited"
  )
    throw new Error("invalid_model_free_constraint");
  const trace = readExecutionTrace(evidence, blobs);
  const events = trace?.events.filter((e) => e.kind === "model.constraint");
  if (events?.length !== 1 || events[0]!.data["digest"] !== digestOf(canonicalJson(c)))
    throw new Error("model_free_constraint_not_persisted");
  if (evidence.usage?.inputTokens !== 0 || evidence.usage.outputTokens !== 0)
    throw new Error("model_free_usage_mismatch");
  return { modelCalls: 0, usage: evidence.usage };
}

export function modelFreeEntry(workspace: string, command: string[]) {
  if (command.length !== 2 || command[0] !== "node" || command[1]!.startsWith("-"))
    throw new Error("model-free-node-v1 only supports a Node entry file");
  const root = realpathSync(workspace);
  const entry = realpathSync(join(root, command[1]!));
  if (!entry.startsWith(`${root}/`)) throw new Error("model-free entry outside workspace");
  return entry;
}

export class ModelFreeNodeSandbox implements SandboxBackend {
  readonly name = "model-free-node-v1";
  // Node permission 是受信代码的约束，不冒充抵御恶意代码的系统沙箱。
  readonly isolated = false;
  available() {
    return Number(process.versions.node.split(".")[0]) >= 26
      ? { ok: true }
      : { ok: false, reason: "Node >=26 required" };
  }
  run(exec: SandboxExecution): SandboxResult {
    const result = runModelFreeNode(exec, modelFreeEntry(exec.hostWorkspace, exec.command));
    return { ...result, modelConstraint: result.constraint };
  }
}

export class ModelFreeProcessExecutor implements ExecutorProvider {
  readonly name = "local-process";
  readonly recoveryPolicy = "manual";
  private readonly entry: string;
  private readonly entryDigest: string;
  constructor(entry: string) {
    this.entry = realpathSync(entry);
    this.entryDigest = digestOf(readFileSync(this.entry, "utf8"));
  }
  async start(req: ExecutionRequest) {
    if (digestOf(readFileSync(this.entry, "utf8")) !== this.entryDigest)
      throw new Error("model-free worker changed after registration");
    const trace = new ExecutionTrace();
    const result = runModelFreeNode(
      {
        command: ["node", this.entry],
        hostWorkspace: req.workspaceDir,
        profile: { network: "none", cpus: 1, memoryMb: 512, timeoutMs: req.timeoutMs },
      },
      this.entry,
    );
    trace.record("model.constraint", { digest: digestOf(canonicalJson(result.constraint)) });
    trace.record("process.completed", { exitCode: result.exitCode });
    const output = join(req.workspaceDir, "output.json");
    return {
      ...result,
      ok: result.exitCode === 0 && existsSync(output),
      outputRef: existsSync(output) ? output : null,
      evidence: trace.finish("model-free-process-v1", "lifecycle", result.exitCode !== null, {
        modelConstraint: result.constraint,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costAmount: null,
          costCurrency: null,
          priceRef: null,
        },
      }),
    };
  }
}
