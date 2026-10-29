import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import { runDevelopmentPilot } from "../../src/app/development-pilot.ts";
import { developmentPilotPermission } from "../../src/app/development-pilot-permission.ts";
import { resolvePackageBin } from "../../src/app/instance.ts";
import { experimentServiceConfig } from "../../src/app/experiment/service-config.ts";
import { digestOf } from "../../src/storage/blobs.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "claude-settings": { type: "string" },
    "source-file": { type: "string" },
  },
});
if (!values.output)
  throw new Error("Use --output NEW_DIR [--claude-settings FILE] [--source-file ORIGINAL_TS]");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const output = resolve(values.output);
const { config } = experimentServiceConfig(values["claude-settings"]);
const model = "GLM-5.3-Flash";
// No ambient user/project plugins, MCP servers or hooks; only explicit source/test files are inputs.
const agentConfig = join(dirname(output), `${output.split("/").at(-1)}-agent-config`);
mkdirSync(agentConfig, { recursive: true, mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: "C.UTF-8",
  CLAUDE_CONFIG_DIR: agentConfig,
  ANTHROPIC_AUTH_TOKEN: config.apiKey,
  ANTHROPIC_BASE_URL: config.baseUrl,
  ANTHROPIC_MODEL: model,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
  DISABLE_NONESSENTIAL_TRAFFIC: "1",
  MAX_THINKING_TOKENS: "0",
};
const sessionMeta = {
  claudeCode: {
    options: {
      model,
      settingSources: [],
      tools: ["Read", "Write", "Edit"],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 6,
      allowDangerouslySkipPermissions: false,
    },
  },
};
const executor: ExecutorProvider = {
  name: "claude-code-acp-pilot",
  recoveryPolicy: "manual",
  start(request) {
    return new AcpExecutor({
      name: this.name,
      agentEntry: resolvePackageBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp"),
      env,
      sessionMeta,
      captureClaudeUsage: true,
      permissionPolicy: developmentPilotPermission(request.workspaceDir),
    }).start(request);
  },
};
const report = await runDevelopmentPilot({
  output,
  sourceFile: values["source-file"]
    ? resolve(values["source-file"])
    : join(repository, "src/runtime/schema-validator.ts"),
  checksFile: join(repository, "tests/fixtures/development-pilot/schema-own-properties.mjs"),
  target: "src/runtime/schema-validator.ts",
  goal: "Fix the JSON Schema subset validator: required and properties must inspect fields actually present on the output object, not fields inherited from its prototype. Preserve current supported keyword behavior and error paths. The frozen tests reproduce missing constructor/toString/__proto__/hasOwnProperty fields, optional inherited properties, and ordinary regression cases. Make the smallest correct source change.",
  executor,
  maxWallClockSeconds: 300,
  onProgress: (event) =>
    process.stderr.write(JSON.stringify({ type: "execution.progress", ...event }) + "\n"),
  provenance: {
    mode: "real",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    requestedModel: model,
    sourceTreeDirty:
      execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()
        .length > 0,
    harnessDigests: Object.fromEntries(
      [
        "src/app/development-pilot.ts",
        "src/app/development-pilot-permission.ts",
        "src/adapters/executor-acp/index.ts",
        "tests/experiments/run-development-pilot.ts",
      ].map((path) => [path, digestOf(readFileSync(join(repository, path), "utf8"))]),
    ),
    executionProfile: {
      endpoint: config.baseUrl!,
      maxTurns: 6,
      outputMaxTokens: 4096,
      tools: ["Read", "Write", "Edit"],
    },
  },
});
console.log(
  JSON.stringify({
    output,
    runId: report.summary.runId,
    state: report.summary.state,
    passed: report.passed,
    elapsedMs: report.elapsedMs,
    modelUsage: report.modelUsage,
  }),
);
if (!report.passed) process.exitCode = 1;
