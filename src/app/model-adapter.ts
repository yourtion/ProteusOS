import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkedModelAdapter, type ModelAdapter } from "../model/index.ts";

/** 只加载操作者显式指定的本地代码；相对路径以启动目录解析，不读取任务/项目配置。 */
export async function loadModelAdapter(
  file = process.env.PROTEUS_MODEL_ADAPTER,
): Promise<ModelAdapter | undefined> {
  if (file === undefined) return undefined;
  if (!file.trim() || /^[a-z][a-z\d+.-]*:/i.test(file))
    throw new Error("--model-adapter 必须是本地文件路径");
  const path = resolve(file);
  if (![".js", ".mjs", ".ts", ".mts"].includes(extname(path)))
    throw new Error("模型适配器文件必须为 .js、.mjs、.ts 或 .mts");
  let value: unknown;
  try {
    if (!(await stat(path)).isFile()) throw new Error("not_a_file");
    const module = await import(pathToFileURL(path).href);
    value = typeof module.default === "function" ? await module.default() : module.default;
  } catch {
    // 模块的原始异常可能包含鉴权响应或 token，不透传到 CLI/Web 日志。
    throw new Error(`模型适配器加载失败：${path}；请检查文件、依赖与初始化配置`);
  }
  return checkedModelAdapter(value);
}
