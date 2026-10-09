import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionResult } from "./types.ts";

/**
 * 能力模块（M2）：快照 capability/<name> 槽位产物的内容合同与独立进程执行。
 * 代码候选经子进程协议加载，不热加载进 kernel（roadmap M2）；
 * 执行合同与本地 worker 一致：cwd=工作区，读 inputs/，写 output.json。
 * 隔离级别为进程级（超时 + cwd 限定）；真沙箱挂账 M3（ADR 0006）。
 */

export interface CapabilityModuleFile {
  path: string;
  content: string;
}

export interface CapabilityModule {
  kind: "capability-module-v1";
  name: string;
  /** 模块入口（相对模块根目录，必须在 files 中） */
  entry: string;
  files: CapabilityModuleFile[];
}

export type CapabilityModuleParse =
  | { ok: true; module: CapabilityModule }
  | { ok: false; error: string };

/** 能力短名同时进入快照槽位和工作区目录，只允许单段、可移植的 slug。 */
export function isCapabilityName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name);
}

export function parseCapabilityModule(content: unknown): CapabilityModuleParse {
  if (typeof content !== "object" || content === null) {
    return { ok: false, error: "能力模块内容不是对象" };
  }
  const c = content as Record<string, unknown>;
  if (c["kind"] !== "capability-module-v1") {
    return {
      ok: false,
      error: `能力模块 kind 应为 capability-module-v1，实际 ${String(c["kind"])}`,
    };
  }
  if (typeof c["name"] !== "string" || !isCapabilityName(c["name"])) {
    return { ok: false, error: "能力模块缺少合法 name" };
  }
  if (typeof c["entry"] !== "string" || c["entry"].length === 0) {
    return { ok: false, error: "能力模块缺少合法 entry" };
  }
  if (!Array.isArray(c["files"]) || c["files"].length === 0) {
    return { ok: false, error: "能力模块 files 为空" };
  }
  const files: CapabilityModuleFile[] = [];
  for (const f of c["files"]) {
    if (typeof f !== "object" || f === null) {
      return { ok: false, error: "files 项不是对象" };
    }
    const { path, content: body } = f as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, error: "files 项缺少合法 path" };
    }
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      return { ok: false, error: `files 路径越界：${path}` };
    }
    if (typeof body !== "string") {
      return { ok: false, error: `files 项 ${path} 的 content 不是字符串` };
    }
    files.push({ path, content: body });
  }
  if (!files.some((f) => f.path === c["entry"])) {
    return { ok: false, error: `entry ${String(c["entry"])} 不在 files 中` };
  }
  return {
    ok: true,
    module: {
      kind: "capability-module-v1",
      name: c["name"],
      entry: c["entry"],
      files,
    },
  };
}

export function capabilityModuleDir(workspace: string, name: string): string {
  if (!isCapabilityName(name)) throw new Error(`能力名称不合法：${name}`);
  const capabilityRoot = resolve(workspace, "capability");
  const moduleRoot = resolve(capabilityRoot, name);
  if (!isWithin(capabilityRoot, moduleRoot)) throw new Error(`能力模块目录越界：${name}`);
  return moduleRoot;
}

/** 独立进程执行能力模块：产物落盘 → node 子进程（cwd=工作区）→ 读 output.json */
export function runCapabilityModule(
  module: CapabilityModule,
  workspace: string,
  timeoutMs: number,
): ExecutionResult {
  const moduleRoot = capabilityModuleDir(workspace, module.name);
  for (const f of module.files) {
    const target = resolve(moduleRoot, f.path);
    if (!isWithin(moduleRoot, target)) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: `能力模块文件路径越界：${f.path}`,
        durationMs: 0,
        outputRef: null,
      };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf8");
  }

  const startedAt = Date.now();
  // 入口先 realpath 再作为 argv[1] 传入：Node ESM 的 import.meta.url 总是真实路径，
  // 若经符号链接传参（如 /tmp → /private/tmp），被测代码的主模块判断会失配——
  // 基座负责消除歧义，不要求每个能力实现自行处理符号链接
  const result = spawnSync(process.execPath, [realpathSync(join(moduleRoot, module.entry))], {
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const outputRef = join(workspace, "output.json");
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
    // output.json 的存在性由调用方按合同检查（失败时如实记录）
    outputRef: result.status === 0 ? outputRef : null,
  };
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
