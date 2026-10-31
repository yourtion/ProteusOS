import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("仓库外 CLI 和 Web 发现本地运行时适配器，显式路径覆盖环境，坏模块阻止启动", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-runtime-startup-"));
  const local = join(root, ".proteus-local");
  mkdirSync(local);
  const file = join(local, "runtime-adapter.mjs");
  writeFileSync(
    file,
    `export default async()=>({version:'proteus-runtime-adapter-v1',id:'startup@1',decisions:[{name:'custom-decision',remote:false,capabilities(){return {problems:['choice']}},async decide(r){return {kind:'abstain',reason:'fixture',provenance:{provider:this.name,policyVersion:r.policy.versionId}}}}]});`,
  );
  const cli = fileURLToPath(new URL("../../bin/proteus.mjs", import.meta.url));
  const env = {
    ...process.env,
    HOME: root,
    PROTEUS_LOCAL_DIR: undefined,
    PROTEUS_MODEL_ADAPTER: undefined,
    PROTEUS_EXECUTOR_ADAPTER: undefined,
    PROTEUS_EXECUTORS_CONFIG: undefined,
    PROTEUS_RUNTIME_ADAPTER: undefined,
  };
  const init = spawnSync(
    process.execPath,
    [cli, "init", "--home", join(root, "instance"), "--runtime-adapter", file, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...env, PROTEUS_RUNTIME_ADAPTER: "missing.mjs" },
      timeout: 15000,
    },
  );
  expect(init.status, init.stderr).toBe(0);
  expect(JSON.parse(init.stdout).snapshotId).toBeTruthy();
  for (const command of ["init", "web"]) {
    const home = join(root, `bad-${command}`);
    const bad = spawnSync(process.execPath, [cli, command, "--home", home], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, PROTEUS_RUNTIME_ADAPTER: "missing.mjs" },
      timeout: 15000,
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("运行时适配器加载失败");
    expect(existsSync(join(home, "metadata.sqlite"))).toBe(false);
  }
  const lease = createServer();
  lease.listen(0, "127.0.0.1");
  await once(lease, "listening");
  const port = (lease.address() as { port: number }).port;
  await new Promise<void>((resolve) => lease.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [cli, "web", "--port", String(port), "--home", join(root, "web")],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const token = await new Promise<string>((resolve, reject) => {
      let output = "",
        errors = "";
      const timer = setTimeout(() => reject(new Error("startup timeout: " + errors)), 15000);
      child.stderr.on("data", (chunk) => {
        errors += String(chunk);
      });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const m = output.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("startup failed: " + errors));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtimeAdapter: { id: "startup@1", decisions: ["custom-decision"] },
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
  }
});
