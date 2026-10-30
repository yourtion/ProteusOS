import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Change, FileContent } from "./types.ts";
export type { Change, FileContent } from "./types.ts";
export const hash = (content: FileContent) =>
  typeof content === "string"
    ? createHash("sha256").update(content).digest("hex")
    : createHash("sha256").update(Buffer.from(content.data, "base64")).digest("hex") +
      ":" +
      content.mode;
export const fileBytes = (content: FileContent) =>
  typeof content === "string" ? Buffer.from(content) : Buffer.from(content.data, "base64");
export function readFile(root: string, name: string): FileContent | null {
  const path = safePath(root, name);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`不支持文件类型：${name}`);
  if (stat.size > 8 * 1024 * 1024) throw new Error(`执行文件超过 8 MiB：${name}`);
  const bytes = readFileSync(path),
    text = bytes.toString("utf8"),
    mode = stat.mode & 0o777;
  if (text.startsWith("version https://git-lfs.github.com/spec/v1\n"))
    throw new Error(`暂不支持 LFS 输入：${name}`);
  return mode === 0o644 &&
    bytes.length <= 1024 * 1024 &&
    !bytes.includes(0) &&
    Buffer.from(text).equals(bytes)
    ? text
    : { encoding: "base64", data: bytes.toString("base64"), mode };
}
export function contextProjection(
  files: Record<string, FileContent>,
  limit = 1024 * 1024,
): Array<{ path: string; bytes: number; digest: string; text?: string; omitted?: string }> {
  let remaining = limit;
  return Object.entries(files).map(([path, content]) => {
    const bytes = fileBytes(content),
      text = bytes.toString("utf8");
    const readable = !bytes.includes(0) && Buffer.from(text).equals(bytes);
    const included = readable && bytes.length <= remaining;
    if (included) remaining -= bytes.length;
    return {
      path,
      bytes: bytes.length,
      digest: hash(content),
      ...(included ? { text } : { omitted: readable ? "context-budget" : "binary" }),
    };
  });
}
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
export function readProject(root: string): Record<string, FileContent> {
  const names = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10000 },
  )
    .split("\0")
    .filter(Boolean);
  const files: Record<string, FileContent> = Object.create(null);
  let total = 0;
  for (const name of new Set(names)) {
    if (excluded(name)) continue;
    const path = safePath(root, name);
    if (!existsSync(path)) continue;
    const content = readFile(root, name)!;
    total += fileBytes(content).length;
    if (total > 64 * 1024 * 1024 || Object.keys(files).length >= 2000)
      throw new Error("项目超过 64 MiB 或 2000 个文件限制");
    files[name] = content;
  }
  return files;
}
export function writeFiles(root: string, files: Record<string, FileContent>) {
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = safePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fileBytes(text));
    chmodSync(path, typeof text === "string" ? 0o644 : text.mode);
  }
}
export function readOutput(root: string) {
  const files: Record<string, FileContent> = Object.create(null);
  let total = 0;
  function visit(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name),
        name = relative(root, path);
      if (/(^|\/)(\.env[^/]*|\.aws|\.ssh|\.codex|\.agents)(\/|$)|\.(pem|key|p12)$/.test(name))
        throw new Error(`输出包含受限文件：${name}`);
      if (excluded(name) || name === ".proteus-summary.md") continue;
      safePath(root, name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) {
        const content = readFile(root, name)!;
        total += fileBytes(content).length;
        if (total > 64 * 1024 * 1024 || Object.keys(files).length >= 2000)
          throw new Error("输出超过限制");
        files[name] = content;
      } else throw new Error("输出包含不支持的文件类型");
    }
  }
  visit(root);
  return files;
}
export function changes(
  before: Record<string, FileContent>,
  after: Record<string, FileContent>,
): Change[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(
      (path) =>
        before[path] === undefined ||
        after[path] === undefined ||
        hash(before[path]!) !== hash(after[path]!),
    )
    .map((path) => {
      const old = before[path],
        next = after[path];
      const view = (value: FileContent | undefined) =>
        typeof value === "string"
          ? value
          : value
            ? `[文件：${fileBytes(value).length} bytes，SHA-256 ${hash(value)}]`
            : null;
      return {
        path,
        before: view(old),
        after: view(next),
        ...(old && typeof old !== "string" ? { beforeFile: old } : {}),
        ...(next && typeof next !== "string" ? { afterFile: next } : {}),
      };
    });
}
export function changeContent(change: Change, side: "before" | "after"): FileContent | null {
  return (side === "before" ? change.beforeFile : change.afterFile) ?? change[side];
}
export function capture(root: string) {
  const files = readProject(root);
  const selected = new Set(Object.keys(files));
  const names = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const manifest = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, hash(content)]),
  );
  return {
    files,
    manifest,
    digest: hash(JSON.stringify(manifest)),
    excluded: names.filter((name) => !selected.has(name)),
    context: contextProjection(files),
  };
}
export const materialize = writeFiles;
export function collect(snapshot: Record<string, FileContent>, root: string) {
  return changes(snapshot, readOutput(root));
}
export type ApplyState = "applying" | "applied" | "rolled-back" | "needs-recovery";
function matchesChange(root: string, change: Change, side: "before" | "after") {
  const actual = readFile(root, change.path),
    expected = changeContent(change, side);
  return actual === null || expected === null
    ? actual === expected
    : hash(actual) === hash(expected);
}
function writeChange(root: string, change: Change, side: "before" | "after") {
  const content = changeContent(change, side),
    path = safePath(root, change.path);
  if (content === null) rmSync(path, { force: true });
  else writeFiles(root, { [change.path]: content });
}
export function applyChangeSet(
  root: string,
  baseline: Record<string, string>,
  changeSet: Change[],
  persist: (state: ApplyState, appliedAt?: number) => void,
) {
  const current = readProject(root);
  const actual = Object.fromEntries(
    Object.entries(current).map(([name, content]) => [name, hash(content)]),
  );
  const stable = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (stable(actual) !== stable(baseline))
    throw new Error("项目已变化，无法应用旧结果；请重新运行任务");
  for (const change of changeSet) safePath(root, change.path);
  persist("applying");
  const touched: Change[] = [];
  try {
    for (const change of changeSet) {
      if (!matchesChange(root, change, "before")) throw new Error("项目已变化，停止应用");
      touched.push(change);
      writeChange(root, change, "after");
    }
    const appliedAt = Date.now();
    persist("applied", appliedAt);
    return { appliedAt };
  } catch (error) {
    let state: ApplyState = "rolled-back";
    try {
      for (const change of touched.reverse()) {
        if (matchesChange(root, change, "before")) continue;
        if (!matchesChange(root, change, "after")) throw new Error("文件有额外修改，需要人工恢复");
        writeChange(root, change, "before");
      }
    } catch {
      state = "needs-recovery";
    }
    persist(state);
    throw error;
  }
}
export function restoreChangeSet(root: string, changeSet: Change[]) {
  for (const change of changeSet)
    if (!matchesChange(root, change, "before") && !matchesChange(root, change, "after"))
      throw new Error("文件已有额外修改，保留备份等待人工恢复");
  for (const change of changeSet) {
    if (matchesChange(root, change, "before")) continue;
    if (!matchesChange(root, change, "after"))
      throw new Error("文件已有额外修改，保留备份等待人工恢复");
    writeChange(root, change, "before");
  }
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
