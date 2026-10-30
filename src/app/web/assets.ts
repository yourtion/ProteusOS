import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolvePackageBin } from "../instance.ts";
/** 启动时构建当前前端，防止新后端继续提供旧执行器表单。 */
export async function buildWorkbenchAssets(): Promise<void> {
  try {
    await promisify(execFile)(
      process.execPath,
      [resolvePackageBin("@rsbuild/core", "rsbuild"), "build"],
      {
        cwd: fileURLToPath(new URL("../../../web", import.meta.url)),
        timeout: 120_000,
      },
    );
  } catch {
    throw new Error("工作台前端构建失败，请运行 pnpm web:build 查看详情");
  }
}
