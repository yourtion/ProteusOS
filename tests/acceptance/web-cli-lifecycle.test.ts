import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const cli = fileURLToPath(new URL("../../bin/proteus.mjs", import.meta.url));
it("停止 CLI 启动器会关闭实际 Web 服务和实例锁，并允许同端口重启", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-cli-lifecycle-"));
  const config = join(root, ".proteus-local");
  mkdirSync(config);
  writeFileSync(
    join(config, "executors.config.mjs"),
    "export default {version:'proteus-executors-v1',enabled:['pi'],default:'pi'};",
  );
  const lease = createServer();
  lease.listen(0, "127.0.0.1");
  await once(lease, "listening");
  const address = lease.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise((resolve) => lease.close(resolve));
  const home = join(root, "instance");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const child = spawn(process.execPath, [cli, "web", "--home", home, "--port", String(port)], {
      env: {
        ...process.env,
        HOME: root,
        PROTEUS_LOCAL_DIR: config,
        PROTEUS_EXECUTORS_CONFIG: undefined,
        PROTEUS_EXECUTOR_ADAPTER: undefined,
        PROTEUS_MODEL_ADAPTER: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Web did not start: " + stderr)), 12000);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("Proteus 工作台：")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Web exited before listening: " + stderr));
        });
      });
      const exit = once(child, "exit");
      child.kill(signal);
      await exit;
      expect(existsSync(join(home, ".workbench.lock"))).toBe(false);
      const accepting = await new Promise<boolean>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      expect(accepting).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  }
});
