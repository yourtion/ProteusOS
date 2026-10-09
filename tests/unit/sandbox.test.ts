import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BareProcessBackend,
  MicrosandboxBackend,
  SANDBOX_WORKSPACE_MOUNT,
} from "../../src/runtime/sandbox.ts";

/**
 * M3 切片①：沙箱后端合同（单元层，注入 spawn 替身验证调用约定）。
 * 真实 microsandbox 执行见 tests/e2e/sandbox-real.test.ts（PROTEUS_SANDBOX 门控）。
 */

interface CapturedCall {
  command: string;
  args: string[];
  timeout: number;
}

function fakeSpawn(
  responses: Array<
    (call: CapturedCall) => { status: number | null; stdout: string; stderr: string }
  >,
) {
  const calls: CapturedCall[] = [];
  let index = 0;
  const spawn = (command: string, args: string[], options: { timeout: number }) => {
    const call = { command, args, timeout: options.timeout };
    calls.push(call);
    const handler = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return handler(call);
  };
  return { spawn, calls };
}

describe("MicrosandboxBackend 合同", () => {
  it("available：doctor 通过 → ok；失败 → 带原因拒绝", () => {
    const ok = new MicrosandboxBackend({
      spawn: () => ({ status: 0, stdout: "ready", stderr: "" }),
    });
    expect(ok.available()).toEqual({ ok: true });

    const bad = new MicrosandboxBackend({
      spawn: () => ({ status: 1, stdout: "", stderr: "no kvm" }),
    });
    const availability = bad.available();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("no kvm");
  });

  it("run：构造正确的 msb 命令（挂载 realpath、--no-net、资源与超时限制、cd 到挂载点执行）", () => {
    const workspace = mkdtempSync(join(tmpdir(), "msb-unit-"));
    const { spawn, calls } = fakeSpawn([
      () => ({ status: 0, stdout: "", stderr: "" }),
      () => ({ status: 0, stdout: "", stderr: "" }),
    ]);
    const backend = new MicrosandboxBackend({ spawn });

    const result = backend.run({
      command: ["node", "capability/changed-file-summary/index.mjs"],
      hostWorkspace: workspace,
      profile: { network: "none", memoryMb: 512, cpus: 1, timeoutMs: 90_000 },
    });

    expect(result.exitCode).toBe(0);
    const runCall = calls[0]!;
    expect(runCall.command).toBe("msb");
    const args = runCall.args;
    expect(args[0]).toBe("run");
    expect(args).toContain("node:24-alpine");
    expect(args).toContain("--no-net");
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("512M");
    expect(args).toContain("--timeout");
    expect(args[args.indexOf("--timeout") + 1]).toBe("90s");
    const volume = args[args.indexOf("-v") + 1]!;
    expect(volume.startsWith("/")).toBe(true);
    expect(volume.endsWith(`:${SANDBOX_WORKSPACE_MOUNT}`)).toBe(true);
    expect(volume).not.toContain("/tmp/"); // realpath：不含符号链接段
    const script = args[args.length - 1]!;
    expect(script).toBe(
      `cd ${SANDBOX_WORKSPACE_MOUNT} && exec node capability/changed-file-summary/index.mjs`,
    );
    // 外层超时 = 命令超时 + 启动余量
    expect(runCall.timeout).toBeGreaterThan(90_000);
    // 执行后尽力清理（前台退出本已回收，外层 kill 的兜底）
    expect(calls[1]!.args[0]).toBe("remove");
  });

  it("run：工作区路径不可解析时如实失败", () => {
    const backend = new MicrosandboxBackend({
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    const result = backend.run({
      command: ["node", "x"],
      hostWorkspace: "/nonexistent-path-xyz",
      profile: { network: "none", memoryMb: 512, cpus: 1, timeoutMs: 1000 },
    });
    expect(result.exitCode).toBe(null);
    expect(result.stderr).toContain("不可解析");
  });
});

describe("BareProcessBackend 合同", () => {
  it("isolated=false（显式非真隔离）；进程级执行 cwd=工作区", () => {
    const backend = new BareProcessBackend();
    expect(backend.isolated).toBe(false);
    expect(backend.available()).toEqual({ ok: true });

    const workspace = mkdtempSync(join(tmpdir(), "bare-unit-"));
    writeFileSync(join(workspace, "probe.mjs"), "console.log('bare-ok')\n");
    const result = backend.run({
      command: [process.execPath, "probe.mjs"],
      hostWorkspace: workspace,
      profile: { network: "none", memoryMb: 0, cpus: 0, timeoutMs: 15_000 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("bare-ok");
  });

  it("超时：超 profile.timeoutMs 的命令被杀，exitCode 非 0", () => {
    const backend = new BareProcessBackend();
    const workspace = mkdtempSync(join(tmpdir(), "bare-timeout-"));
    writeFileSync(join(workspace, "slow.mjs"), "setTimeout(() => {}, 5000)\n");
    const result = backend.run({
      command: [process.execPath, "slow.mjs"],
      hostWorkspace: workspace,
      profile: { network: "none", memoryMb: 0, cpus: 0, timeoutMs: 300 },
    });
    expect(result.exitCode).not.toBe(0);
  });
});
