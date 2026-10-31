import { mkdirSync, cpSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
/** Self-contained clean-environment browser acceptance runner. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const server = spawn(
  process.execPath,
  [fileURLToPath(new URL("../fixtures/web/clean-workbench.mjs", import.meta.url))],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let root;
try {
  await new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    const timer = setTimeout(() => reject(new Error("Web startup timeout: " + errors)), 30000);
    server.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    server.stdout.on("data", (chunk) => {
      output += String(chunk);
      const first = output.split("\n")[0];
      try {
        root = JSON.parse(first).root;
      } catch {}
      if (output.includes("Proteus 工作台：")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Web exited: " + errors));
    });
  });
  console.log("Clean browser fixture:", root);
  const browser = spawn(
    process.execPath,
    [fileURLToPath(new URL("./workbench.mjs", import.meta.url)), root],
    { stdio: "inherit" },
  );
  const [code] = await once(browser, "exit");
  process.exitCode = code ?? 1;
} finally {
  if (root && existsSync(join(root, "browser-report.json"))) {
    const artifacts = resolve("artifacts/web-browser");
    mkdirSync(artifacts, { recursive: true });
    copyFileSync(join(root, "browser-report.json"), join(artifacts, "report.json"));
    cpSync(join(root, "screenshots"), join(artifacts, "screenshots"), { recursive: true });
    console.log("Browser evidence:", artifacts);
  }
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
}
