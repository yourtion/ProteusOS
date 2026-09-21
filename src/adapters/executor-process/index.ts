import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRequest, ExecutionResult, ExecutorProvider } from "../../runtime/types.ts";

/**
 * 本地受信进程执行器（M0）：spawn 固定 worker 脚本，等待完成。
 * 工作区只隔离文件变更，不构成安全沙箱（docs/runtime.md §5）；
 * handle/事件流/取消随切片④ 扩展。
 */
export class LocalProcessExecutor implements ExecutorProvider {
  readonly name = "local-process";
  readonly recoveryPolicy = "retry-safe";
  private readonly workerPath: string;

  constructor(workerPath: string) {
    this.workerPath = workerPath;
  }

  start(req: ExecutionRequest): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(process.execPath, [this.workerPath, req.workspaceDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, req.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const finish = (exitCode: number | null) => {
        const outputRef = join(req.workspaceDir, "output.json");
        const hasOutput = existsSync(outputRef);
        resolve({
          // 超时或异常退出（exitCode null）都视为失败；output 缺失同样不算成功
          ok: !timedOut && exitCode === 0 && hasOutput,
          exitCode,
          stdout,
          stderr: timedOut ? `${stderr}\n[executor] 执行超时被终止` : stderr,
          durationMs: Date.now() - startedAt,
          outputRef: hasOutput ? outputRef : null,
        });
      };

      child.on("error", (err) => {
        clearTimeout(timer);
        stderr += `\n[executor] spawn 失败：${String(err)}`;
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code);
      });
    });
  }
}
