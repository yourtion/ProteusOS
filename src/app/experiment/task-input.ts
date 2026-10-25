import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import type { adaptiveTask } from "./adaptive.ts";

/** 与 executionInputDigest 的目录/文件顺序及 base64 字节摘要一致，不访问文件系统。 */
export function adaptiveTaskInputDigest(task: ReturnType<typeof adaptiveTask>): string {
  if (task.inputs.length > 512) throw new Error("冻结任务输入超过 512 文件上限");
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const children = new Map<string, Set<string>>();
  let bytes = 0;
  for (const file of task.inputs) {
    const parts = file.name.split("/");
    if (
      parts.length > 64 ||
      Buffer.byteLength(file.name, "utf8") > 1024 ||
      /[\\:]/.test(file.name) ||
      file.name.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("冻结任务输入路径不合法");
    const content = Buffer.from(file.content, "utf8");
    if (content.toString("utf8") !== file.content)
      throw new Error("冻结任务输入不是完整 UTF-8 文本");
    bytes += content.length;
    if (bytes > 4 * 1024 * 1024) throw new Error("冻结任务输入超过 4 MiB 上限");
    if (files.has(file.name)) throw new Error("冻结任务输入文件重名");
    files.set(file.name, digestOf(content.toString("base64")));
    let parent = "";
    for (const [index, part] of parts.entries()) {
      const path = parent ? `${parent}/${part}` : part;
      if (index < parts.length - 1) directories.add(path);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(part);
      parent = path;
    }
  }
  for (const path of files.keys())
    if (directories.has(path)) throw new Error("冻结任务输入文件与目录冲突");
  const entries: Array<{ path: string; digest?: string; kind?: "directory" }> = [];
  const visit = (parent: string) => {
    for (const name of [...(children.get(parent) ?? [])].sort()) {
      const path = parent ? `${parent}/${name}` : name;
      if (directories.has(path)) {
        entries.push({ path, kind: "directory" });
        visit(path);
      } else entries.push({ path, digest: files.get(path)! });
    }
  };
  visit("");
  return digestOf(canonicalJson(entries));
}
