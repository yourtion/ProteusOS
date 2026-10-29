import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Change } from "./contracts.ts";
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function safePath(root: string, name: string) {
  const path = resolve(root, name);
  if (
    !name ||
    path === resolve(root) ||
    !path.startsWith(resolve(root) + sep) ||
    name.split(/[\\/]/).includes(".git")
  )
    throw new Error("路径超出项目范围");
  let current = path;
  while (current !== resolve(root)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("不支持符号链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  return path;
}
export function repository(path: string) {
  const root = realpathSync(path);
  const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  if (realpathSync(top) !== root) throw new Error("请选择 Git 仓库根目录");
  if (existsSync(join(root, ".gitmodules"))) throw new Error("首版不支持含子模块的项目");
  return root;
}
const excluded = (name: string) =>
  /(^|\/)(\.git|node_modules|dist|build|coverage|\.proteus[^/]*|\.env[^/]*|\.aws|\.ssh|\.codex|\.agents|\.pnpm-store)(\/|$)|\.(pem|key|p12)$/.test(
    name,
  );
export function readProject(root: string): Record<string, string> {
  const names = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10000 },
  )
    .split("\0")
    .filter(Boolean);
  const files: Record<string, string> = Object.create(null);
  let total = 0;
  for (const name of new Set(names)) {
    if (excluded(name)) continue;
    const path = safePath(root, name);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`不支持文件类型：${name}`);
    if (stat.size > 1024 * 1024) throw new Error(`文件超过 1 MiB：${name}`);
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
      throw new Error(`首版仅支持 UTF-8 文本项目：${name}`);
    total += bytes.length;
    if (total > 20 * 1024 * 1024 || Object.keys(files).length >= 2000)
      throw new Error("项目超过 20 MiB 或 2000 个文件限制");
    files[name] = text;
  }
  return files;
}
export function writeFiles(root: string, files: Record<string, string>) {
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = safePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
export function readOutput(root: string) {
  const files: Record<string, string> = Object.create(null);
  let total = 0;
  function visit(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name),
        name = relative(root, path);
      if (excluded(name) || name === ".proteus-summary.md") continue;
      safePath(root, name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) {
        const stat = lstatSync(path);
        if (stat.size > 1024 * 1024) throw new Error("输出文件过大");
        const bytes = readFileSync(path);
        const text = bytes.toString("utf8");
        if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
          throw new Error("输出包含非文本文件");
        total += bytes.length;
        if (total > 20 * 1024 * 1024 || Object.keys(files).length >= 2000)
          throw new Error("输出超过限制");
        files[name] = text;
      } else throw new Error("输出包含不支持的文件类型");
    }
  }
  visit(root);
  return files;
}
export function changes(before: Record<string, string>, after: Record<string, string>): Change[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((path) => before[path] !== after[path])
    .map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
}
export async function runCheck(
  command: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  onOutput: (s: string) => void,
) {
  if (!command.length)
    return { tested: false, passed: true, output: "项目未配置测试命令；结果未经自动测试。" };
  return await new Promise<{ tested: boolean; passed: boolean; output: string }>(
    (resolveResult) => {
      let output = "";
      let settled = false;
      const child = spawn(command[0]!, command.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: process.env,
      });
      const stop = () => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Process already exited. */
        }
      };
      const timer = setTimeout(stop, Math.max(1, timeoutMs));
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const finish = (passed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        resolveResult({ tested: true, passed: passed && !signal.aborted, output });
      };
      const collect = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output = (output + text).slice(-64000);
        onOutput(text.slice(-4000));
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (e) => {
        output += e.message;
        finish(false);
      });
      child.on("close", (code) => finish(code === 0));
    },
  );
}
