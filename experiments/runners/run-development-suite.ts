import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import { runDevelopmentPilot } from "../protocols/development-pilot.ts";
import { developmentPilotPermission } from "../protocols/development-pilot-permission.ts";
import { resolvePackageBin } from "../../src/app/instance.ts";
import { experimentServiceConfig } from "../protocols/service-config.ts";
import { digestOf } from "../../src/storage/blobs.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = join(repository, "tests/fixtures/development-suite-v1");
const rawManifest = readFileSync(join(fixtures, "manifest.json"), "utf8");
const manifest = JSON.parse(rawManifest) as {
  version: string;
  endpoint: string;
  model: string;
  repetitions: number;
  maxTurns: number;
  maxWallClockSeconds: number;
  outputMaxTokens: number;
  cases: Array<{
    id: string;
    target: string;
    sourceCommit: string;
    fixCommit: string;
    goal: string;
    sourceDigest: string;
    checksDigest: string;
    referenceDigest: string;
  }>;
};
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "claude-settings": { type: "string" },
    preflight: { type: "boolean" },
  },
});

// Validate all frozen files and the red/green controls before loading credentials or starting an agent.
const controls = manifest.cases.map((task) => {
  for (const [file, expected] of [
    ["source.ts.txt", task.sourceDigest],
    ["reference.ts.txt", task.referenceDigest],
    ["checks.mjs", task.checksDigest],
  ]) {
    if (digestOf(readFileSync(join(fixtures, task.id, file!), "utf8")) !== expected)
      throw new Error(`fixture digest mismatch: ${task.id}/${file}`);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "proteus-suite-preflight-")));
  try {
    const checker = join(root, "checks.mjs");
    writeFileSync(checker, readFileSync(join(fixtures, task.id, "checks.mjs")));
    const check = (file: string) => {
      const candidate = join(root, "candidate.ts");
      writeFileSync(candidate, readFileSync(join(fixtures, task.id, file)));
      const result = spawnSync(
        process.execPath,
        ["--permission", `--allow-fs-read=${root}`, checker, candidate],
        { encoding: "utf8", env: { LANG: "C.UTF-8" }, timeout: 15000 },
      );
      if (result.error) throw result.error;
      if (!result.stdout)
        throw new Error(`control did not return results: ${task.id}: ${result.stderr}`);
      return {
        exitCode: result.status,
        ...(JSON.parse(result.stdout) as {
          passed: boolean;
          results: Array<{ name: string; passed: boolean }>;
        }),
      };
    };
    const red = check("source.ts.txt"),
      green = check("reference.ts.txt");
    if (
      red.exitCode !== 1 ||
      red.passed !== false ||
      green.exitCode !== 0 ||
      green.passed !== true ||
      !red.results.some((r) => r.passed) ||
      !red.results.some((r) => !r.passed) ||
      !green.results.every((r) => r.passed) ||
      JSON.stringify(red.results.map((r) => r.name)) !==
        JSON.stringify(green.results.map((r) => r.name))
    )
      throw new Error(`invalid red/green controls: ${task.id}`);
    return {
      id: task.id,
      checks: red.results.length,
      baselinePassed: red.results.filter((r) => r.passed).length,
      referencePassed: green.results.length,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
if (values.preflight) {
  console.log(JSON.stringify({ manifestDigest: digestOf(rawManifest), controls }, null, 2));
} else {
  if (!values.output) throw new Error("Use --preflight or --output NEW_DIR --claude-settings FILE");
  const output = resolve(values.output);
  if (existsSync(output))
    throw new Error("suite directory already exists; inspect it without retrying");
  const { config } = experimentServiceConfig(values["claude-settings"]);
  if (config.baseUrl?.replace(/\/$/, "") !== manifest.endpoint)
    throw new Error("endpoint differs from registered suite");
  mkdirSync(output);
  writeFileSync(join(output, "manifest.json"), rawManifest);
  writeFileSync(join(output, "controls.json"), JSON.stringify(controls, null, 2));
  const harnessDigests = Object.fromEntries(
    [
      "experiments/protocols/development-pilot.ts",
      "experiments/protocols/development-pilot-permission.ts",
      "src/adapters/executor-acp/index.ts",
      "src/adapters/executor-acp/accounting.ts",
      "src/adapters/executor-acp/observation.ts",
      "src/runtime/execution-evidence.ts",
      "src/runtime/index.ts",
      "experiments/runners/run-development-suite.ts",
    ].map((path) => [path, digestOf(readFileSync(join(repository, path), "utf8"))]),
  );
  const runs: Array<Record<string, unknown>> = [];
  let halted: string | null = null;
  const save = () =>
    writeFileSync(
      join(output, "summary.json"),
      JSON.stringify(
        {
          version: manifest.version,
          manifestDigest: digestOf(rawManifest),
          plannedRuns: manifest.cases.length * manifest.repetitions,
          runs,
          halted,
          benefit: "inconclusive",
        },
        null,
        2,
      ),
    );
  save();
  outer: for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
    for (const task of manifest.cases) {
      for (const [path, expected] of Object.entries(harnessDigests)) {
        if (digestOf(readFileSync(join(repository, path), "utf8")) !== expected) {
          halted = `harness changed during suite: ${path}`;
          save();
          throw new Error(halted);
        }
      }
      const id = `${task.id}-${repetition}`;
      const agentConfig = join(dirname(output), `${output.split("/").at(-1)}-private-config-${id}`);
      if (existsSync(agentConfig)) throw new Error("agent configuration directory must be fresh");
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
      try {
        const report = await runDevelopmentPilot({
          output: join(output, id),
          sourceFile: join(fixtures, task.id, "source.ts.txt"),
          checksFile: join(fixtures, task.id, "checks.mjs"),
          target: task.target,
          goal: task.goal,
          maxWallClockSeconds: manifest.maxWallClockSeconds,
          onProgress: (event) =>
            process.stderr.write(
              JSON.stringify({ type: "execution.progress", case: id, ...event }) + "\n",
            ),
          executor: {
            name: "claude-code-acp-suite",
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
                permissionPolicy: developmentPilotPermission(request.workspaceDir, task.target),
              }).start(request);
            },
          },
          provenance: {
            mode: "real",
            sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: repository,
              encoding: "utf8",
            }).trim(),
            requestedModel: manifest.model,
            sourceTreeDirty:
              execFileSync("git", ["status", "--porcelain"], {
                cwd: repository,
                encoding: "utf8",
              }).trim().length > 0,
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
        const complete =
          evidence?.traceStatus === "complete" &&
          evidence.droppedEvents === 0 &&
          report.modelUsage?.tokenStatus === "complete" &&
          !!evidence.accountingDigest &&
          report.summary.attempts[0]?.progress?.phase === "completed";
        runs.push({
          id,
          repetition,
          task: task.id,
          runId: report.summary.runId,
          passed: report.passed,
          elapsedMs: report.elapsedMs,
          evidenceComplete: complete,
          traceStatus: evidence?.traceStatus ?? null,
          droppedEvents: evidence?.droppedEvents ?? null,
          usage: report.modelUsage,
        });
        if (!complete || (runs.length === 1 && !report.passed))
          halted = `evidence gate failed at ${id}`;
        save();
        console.log(
          JSON.stringify({
            id,
            passed: report.passed,
            evidenceComplete: complete,
            elapsedMs: report.elapsedMs,
          }),
        );
        if (halted) break outer;
      } catch (error) {
        halted = `interrupted at ${id}: ${error instanceof Error ? error.message : String(error)}`;
        save();
        throw error;
      }
    }
  }
  if (halted || runs.some((run) => !run.passed)) process.exitCode = 1;
}
