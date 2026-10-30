import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandUserPath(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** 用户级接入目录，与实例 PROTEUS_HOME 及项目目录独立。 */
export function localConfigDirectory(): string {
  const directory = process.env.PROTEUS_LOCAL_DIR ?? join(homedir(), ".proteus-local");
  if (!directory.trim()) throw new Error("PROTEUS_LOCAL_DIR 不能为空");
  return resolve(expandUserPath(directory));
}

/** 只发现约定入口；不遍历目录、不导入无关脚本，歧义或读取错误直接报错。 */
export async function discoverLocalModule(...names: string[]): Promise<string | undefined> {
  const directory = localConfigDirectory();
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error("本地接入配置路径必须是目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const name of names) {
    const found: string[] = [];
    for (const extension of ["mjs", "js", "mts", "ts"]) {
      const path = join(directory, `${name}.${extension}`);
      try {
        if (!(await stat(path)).isFile()) throw new Error(`本地配置入口不是文件：${path}`);
        found.push(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    if (found.length > 1) throw new Error(`本地配置存在多个 ${name} 入口，请仅保留一个扩展名`);
    if (found.length === 1) return found[0];
  }
  return undefined;
}
