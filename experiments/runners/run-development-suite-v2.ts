import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import { runDevelopmentPilot } from "../protocols/development-pilot.ts";
import { developmentPilotPermission } from "../protocols/development-pilot-permission.ts";
import { resolvePackageBin } from "../../src/app/instance.ts";
import { experimentServiceConfig } from "../protocols/service-config.ts";
import { digestOf } from "../../src/storage/blobs.ts";
import {
  fixtures,
  manifest,
  prepareCase,
  rawManifest,
  repository,
} from "./development-suite-v2-support.ts";

const { values } = parseArgs({
  options: { output: { type: "string" }, "claude-settings": { type: "string" } },
});
if (!values.output) throw new Error("--output NEW_DIRECTORY --claude-settings FILE required");
const requested = resolve(values.output);
if (existsSync(requested)) throw new Error("existing output cannot be retried automatically");
mkdirSync(requested);
const output = realpathSync(requested);
writeFileSync(join(output, "manifest.json"), rawManifest);
mkdirSync(join(output, "controls"));
const prepared = new Map<string, ReturnType<typeof prepareCase>>();
for (const task of manifest.cases)
  prepared.set(task.id, prepareCase(task, join(output, "controls", task.id)));
const { config } = experimentServiceConfig(values["claude-settings"]);
if (config.baseUrl?.replace(/\/$/, "") !== manifest.endpoint)
  throw new Error("endpoint differs from registered suite");
const harnessFiles = [
  "experiments/protocols/development-pilot.ts",
  "experiments/protocols/development-pilot-permission.ts",
  "experiments/protocols/development-repository.ts",
  "experiments/protocols/development-repository-review.mjs",
  "src/app/instance.ts",
  "src/runtime/index.ts",
  "src/runtime/types.ts",
  "src/runtime/execution-evidence.ts",
  "src/adapters/executor-acp/index.ts",
  "src/adapters/executor-acp/accounting.ts",
  "src/adapters/executor-acp/observation.ts",
  "experiments/runners/run-development-suite-v2.ts",
  "experiments/runners/development-suite-v2-support.ts",
];
const harnessDigests = Object.fromEntries(
  harnessFiles.map((path) => [path, digestOf(readFileSync(join(repository, path), "utf8"))]),
);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const sourceTreeDirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()
    .length > 0;
const sequence = [
  ...manifest.cases
    .filter((task) => task.stage === "gate")
    .flatMap((task) =>
      Array.from({ length: manifest.repetitions }, (_, i) => ({ task, repetition: i + 1 })),
    ),
  ...Array.from({ length: manifest.repetitions }, (_, i) =>
    manifest.cases
      .filter((task) => task.stage === "expansion")
      .map((task) => ({ task, repetition: i + 1 })),
  ).flat(),
];
const runs: Array<Record<string, unknown>> = [];
let halted: string | null = null;
const save = () =>
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        version: manifest.version,
        manifestDigest: digestOf(rawManifest),
        plannedRuns: sequence.length,
        runs,
        halted,
        benefit: "inconclusive",
      },
      null,
      2,
    ),
  );
save();
for (const { task, repetition } of sequence) {
  const id = `${task.id}-${repetition}`;
  try {
    for (const [path, digest] of Object.entries(harnessDigests))
      if (digestOf(readFileSync(join(repository, path), "utf8")) !== digest)
        throw new Error(`harness changed during suite: ${path}`);
    const agentConfig = join(dirname(output), `${output.split("/").at(-1)}-private-config-${id}`);
    if (existsSync(agentConfig)) throw new Error("agent configuration must be fresh");
    mkdirSync(agentConfig, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: agentConfig,
      ANTHROPIC_AUTH_TOKEN: config.apiKey,
      ANTHROPIC_BASE_URL: config.baseUrl,
      ANTHROPIC_MODEL: manifest.model,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(manifest.outputMaxTokens),
      DISABLE_NONESSENTIAL_TRAFFIC: "1",
      MAX_THINKING_TOKENS: "0",
    };
    const sessionMeta = {
      claudeCode: {
        options: {
          model: manifest.model,
          settingSources: [],
          tools: ["Read", "Write", "Edit"],
          mcpServers: {},
          strictMcpConfig: true,
          maxTurns: manifest.maxTurns,
          allowDangerouslySkipPermissions: false,
        },
      },
    };
    const report = await runDevelopmentPilot({
      output: join(output, id),
      sourceFile: join(fixtures, task.id, "source.ts.txt"),
      checksFile: join(fixtures, task.id, "checks.mjs"),
      target: task.target,
      goal: task.goal,
      repository: prepared.get(task.id)!.plan,
      maxWallClockSeconds: manifest.maxWallClockSeconds,
      onProgress: (event) =>
        process.stderr.write(
          JSON.stringify({ type: "execution.progress", case: id, ...event }) + "\n",
        ),
      executor: {
        name: "claude-code-acp-suite-v2",
        recoveryPolicy: "manual",
        start(request) {
          return new AcpExecutor({
            name: this.name,
            agentEntry: resolvePackageBin(
              "@agentclientprotocol/claude-agent-acp",
              "claude-agent-acp",
            ),
            env,
            sessionMeta,
            captureClaudeUsage: true,
            permissionPolicy: developmentPilotPermission(request.workspaceDir, task.target, true),
          }).start(request);
        },
      },
      provenance: {
        mode: "real",
        sourceCommit,
        requestedModel: manifest.model,
        sourceTreeDirty,
        harnessDigests,
        executionProfile: {
          endpoint: manifest.endpoint,
          maxTurns: manifest.maxTurns,
          outputMaxTokens: manifest.outputMaxTokens,
          tools: ["Read", "Write", "Edit"],
        },
      },
    });
    const evidence = report.summary.attempts[0]?.evidence;
    const workspace = join(output, id, "instance/workspaces", report.summary.runId, "develop");
    const tracePath = join(workspace, ".proteus/acp-trace.json");
    const verificationPath = join(workspace, ".proteus/pilot-verification.json");
    const publicTrace = existsSync(tracePath) ? JSON.parse(readFileSync(tracePath, "utf8")) : null;
    const verification = existsSync(verificationPath)
      ? JSON.parse(readFileSync(verificationPath, "utf8"))
      : null;
    const complete =
      evidence?.traceStatus === "complete" &&
      evidence.droppedEvents === 0 &&
      report.modelUsage?.tokenStatus === "complete" &&
      !!evidence.accountingDigest &&
      publicTrace?.journal?.failed === false &&
      publicTrace?.journal?.droppedEvents === 0 &&
      publicTrace?.projectionDropped === 0 &&
      publicTrace?.progressFailures === 0;
    const row = {
      id,
      task: task.id,
      stage: task.stage,
      repetition,
      runId: report.summary.runId,
      passed: report.passed,
      functional: verification?.repository?.functional?.passed ?? false,
      repositoryTypes: verification?.repository?.repositoryTypes?.passed ?? false,
      apiCompatibility: verification?.repository?.apiCompatibility?.passed ?? false,
      elapsedMs: report.elapsedMs,
      evidenceComplete: complete,
      droppedEvents: evidence?.droppedEvents ?? null,
      usage: report.modelUsage,
    };
    runs.push(row);
    if (!complete || (task.stage === "gate" && !report.passed)) halted = `gate failed at ${id}`;
    save();
    console.log(
      JSON.stringify({ ...row, usage: { tokens: report.modelUsage?.totals?.totalTokens ?? null } }),
    );
    if (halted) break;
  } catch (error) {
    halted = `interrupted at ${id}: ${error instanceof Error ? error.message : String(error)}`;
    save();
    throw error;
  }
}
if (halted || runs.some((run) => !run.passed)) process.exitCode = 1;
