import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 沙箱后端（M3 前置①：真隔离，ADR 0006 挂账兑现）。
 * 能力代码与评估执行经 SandboxBackend 进入真实隔离环境；后端可替换
 * （microsandbox → docker → …），port 即替换边界。工作区目录隔离不构成
 * 安全沙箱的立场不变：网络/文件系统/凭据限制由后端的隔离机制施加，
 * 后端不可用时明确拒绝执行，不静默降级到进程级。
 */

export interface SandboxProfile {
  network: "none";
  memoryMb: number;
  cpus: number;
  timeoutMs: number;
}

export interface SandboxExecution {
  /** 工作区内执行的命令（相对挂载点，如 ["node", "capability/x/index.mjs"]） */
  command: string[];
  /** 宿主工作区绝对路径，后端负责挂载为沙箱内 /workspace */
  hostWorkspace: string;
  profile: SandboxProfile;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxBackend {
  readonly name: string;
  /** true=真隔离（网络/文件系统受限）；bare-process 为 false */
  readonly isolated: boolean;
  available(): { ok: boolean; reason?: string };
  run(exec: SandboxExecution): SandboxResult;
}

export const DEFAULT_SANDBOX_PROFILE: SandboxProfile = {
  network: "none",
  memoryMb: 512,
  cpus: 1,
  timeoutMs: 120_000,
};

/** microsandbox 内工作区固定挂载点；能力合同（读 inputs/ 写 output.json）以此为 cwd */
export const SANDBOX_WORKSPACE_MOUNT = "/workspace";

type SpawnFn = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
) => { status: number | null; stdout: string; stderr: string };

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawnSync(command, args, options) as unknown as {
    status: number | null;
    stdout: string;
    stderr: string;
  };

/**
 * microsandbox 后端（libkrun microVM；macOS Apple Silicon / Linux KVM）。
 * 每次执行一次性 VM：挂载工作区 → --no-net → 资源/超时限制下执行 → 前台退出自动回收。
 * CLI 是最稳定的受控接口；镜像首次拉取依赖网络（经环境代理），之后走本地缓存。
 */
export class MicrosandboxBackend implements SandboxBackend {
  readonly name = "microsandbox";
  readonly isolated = true;
  private readonly spawn: SpawnFn;
  private readonly image: string;
  /** VM 启动与回收的外层余量（命令级超时之外） */
  private readonly bootSlackMs: number;

  constructor(options: { spawn?: SpawnFn; image?: string; bootSlackMs?: number } = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.image = options.image ?? "node:24-alpine";
    this.bootSlackMs = options.bootSlackMs ?? 45_000;
  }

  available(): { ok: boolean; reason?: string } {
    const probe = this.spawn("msb", ["doctor"], { encoding: "utf8", timeout: 30_000 });
    if (probe.status !== 0) {
      return {
        ok: false,
        reason: `msb doctor 失败（exit=${String(probe.status)}）：${(probe.stderr || probe.stdout || "").slice(-300)}`,
      };
    }
    return { ok: true };
  }

  run(exec: SandboxExecution): SandboxResult {
    // 挂载路径必须 realpath：msb 拒绝经符号链接的宿主路径
    let workspace: string;
    try {
      workspace = realpathSync(exec.hostWorkspace);
    } catch (err) {
      return {
        exitCode: null,
        stdout: "",
        stderr: `工作区路径不可解析：${String(err)}`,
        durationMs: 0,
      };
    }
    const name = `proteus-cap-${randomUUID()}`;
    const timeoutSeconds = Math.max(1, Math.ceil(exec.profile.timeoutMs / 1000));
    const script = `cd ${SANDBOX_WORKSPACE_MOUNT} && exec ${exec.command.join(" ")}`;
    const startedAt = Date.now();
    const result = this.spawn(
      "msb",
      [
        "run",
        this.image,
        "--name",
        name,
        "-v",
        `${workspace}:${SANDBOX_WORKSPACE_MOUNT}`,
        "--no-net",
        "-m",
        `${exec.profile.memoryMb}M`,
        "-c",
        String(exec.profile.cpus),
        "--timeout",
        `${timeoutSeconds}s`,
        "--",
        "/bin/sh",
        "-c",
        script,
      ],
      { encoding: "utf8", timeout: exec.profile.timeoutMs + this.bootSlackMs },
    );
    const durationMs = Date.now() - startedAt;
    // 外层超时 SIGKILL 可能残留 VM：尽力清理（前台模式正常退出即自动回收）
    this.spawn("msb", ["remove", "--force", name], { encoding: "utf8", timeout: 15_000 });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs,
    };
  }
}

/**
 * 进程级后端（M2 行为的显式命名）：独立 node 子进程 + cwd 限定 + 超时。
 * isolated=false——工作区目录隔离不限制网络、凭据与宿主文件系统，
 * 仅用于受信 fixture 与显式选择非真隔离的场景（ADR 0006 立场）。
 */
export class BareProcessBackend implements SandboxBackend {
  readonly name = "bare-process";
  readonly isolated = false;

  available(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  run(exec: SandboxExecution): SandboxResult {
    const startedAt = Date.now();
    const result = spawnSync(exec.command[0]!, exec.command.slice(1), {
      cwd: exec.hostWorkspace,
      encoding: "utf8",
      timeout: exec.profile.timeoutMs,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: Date.now() - startedAt,
    };
  }
}
