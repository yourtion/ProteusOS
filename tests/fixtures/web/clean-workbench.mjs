/** Run the actual CLI with a new HOME, user config, database and Git project. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
const existing = process.argv[2];
const root = existing ? resolve(existing) : mkdtempSync(join(tmpdir(), "proteus-browser-clean-"));
const project = join(root, "project"),
  secondProject = join(root, "second-project"),
  home = join(root, "home");
const config = join(home, ".proteus-local");
if (!existing) {
  mkdirSync(config, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["init", "-q", secondProject]);
  writeFileSync(join(secondProject, "note.txt"), "second project");
  writeFileSync(join(project, "math.mjs"), "export const add = (a,b) => a-b;\n");
  writeFileSync(join(project, "asset.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(
    join(project, "check.mjs"),
    "import {add} from './math.mjs'; if(add(2,3)!==5) throw new Error('add must return 5');\n",
  );
  const agent = fileURLToPath(new URL("./agent.mjs", import.meta.url));
  const factory = (name) =>
    `{version:'proteus-executor-adapter-v1',name:'${name}',create:({createAcpExecutor})=>createAcpExecutor({command:${JSON.stringify(process.execPath)},agentArgs:[${JSON.stringify(agent)}],env:{PATH:process.env.PATH}})}`;
  writeFileSync(
    join(config, "executors.config.mjs"),
    `export default {version:'proteus-executors-v1',enabled:['traex','opencode-w'],default:'traex',adapters:[${factory("traex")},${factory("opencode-w")}],choices:{traex:{models:['fixture-model','alternate-model'],reasoningEfforts:['low','high']},'opencode-w':{models:['fixture-model'],reasoningEfforts:['low']}}};`,
  );
}
let port;
if (existing) port = JSON.parse(readFileSync(join(root, "validation.json"), "utf8")).port;
else {
  const lease = createServer();
  await new Promise((r) => lease.listen(0, "127.0.0.1", r));
  port = lease.address().port;
  await new Promise((r) => lease.close(r));
}
writeFileSync(
  join(root, "validation.json"),
  JSON.stringify(
    { root, project, secondProject, home, port, node: process.execPath, pid: process.pid },
    null,
    2,
  ),
);
console.log(JSON.stringify({ root, project, home, port }));
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../../../bin/proteus.mjs", import.meta.url)),
    "web",
    "--port",
    String(port),
    "--home",
    join(root, "instance"),
  ],
  {
    env: {
      ...process.env,
      HOME: home,
      PROTEUS_LOCAL_DIR: undefined,
      PROTEUS_EXECUTORS_CONFIG: undefined,
      PROTEUS_EXECUTOR_ADAPTER: undefined,
      PROTEUS_MODEL_ADAPTER: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (data) => {
  const text = data.toString();
  process.stdout.write(text);
  const url = text.match(/http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]+/);
  if (url) writeFileSync(join(root, "url.txt"), url[0]);
});
child.stderr.pipe(process.stderr);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
