import { Command } from "commander";
import {
  advanceCommand,
  buildCommand,
  candidatesCommand,
  cancelCommand,
  evaluateCommand,
  initCommand,
  inspectCommand,
  promoteCommand,
  recoverCommand,
  reconcileCommand,
  rollbackCommand,
  runsCommand,
  submitCommand,
  supersedeCommand,
} from "./commands.ts";

const program = new Command();
program
  .name("proteus")
  .description("ProteusOS 运行基质 CLI（M0：单 Organism 本地闭环）")
  .version("0.1.0");

function withCommon(cmd: Command): Command {
  return cmd
    .option("--home <dir>", "实例根目录（默认 ~/.proteus 或 PROTEUS_HOME）")
    .option("--json", "以 JSON 输出");
}

withCommon(program.command("init").description("初始化实例：创建身份、安装 seed 并装载 G0")).action(
  async (opts) => {
    await initCommand(opts);
  },
);

withCommon(
  program
    .command("submit")
    .description("提交任务并内联执行到终态")
    .argument("<taskFile>", "task.yaml 路径"),
).action(async (taskFile: string, opts) => {
  await submitCommand(taskFile, opts);
});

withCommon(program.command("runs").description("列出或查看 Run").argument("[id]", "Run ID")).action(
  async (id: string | undefined, opts) => {
    await runsCommand(id, opts);
  },
);

withCommon(program.command("cancel").description("请求取消 Run").argument("<id>", "Run ID")).action(
  async (id: string, opts) => {
    await cancelCommand(id, opts);
  },
);

withCommon(
  program
    .command("advance")
    .description("推进能力缺口等待中的 Run：截止已到则 failed/missing_capability 结案")
    .argument("<id>", "Run ID"),
).action(async (id: string, opts) => {
  await advanceCommand(id, opts);
});

withCommon(
  program
    .command("build")
    .description("委托构建能力实现并采集构造候选（builder Run 内联到终态）")
    .requiredOption("--capability <name>", "能力短名（如 changed-file-summary）")
    .requiredOption("--spec <file>", "实现规范文件（作为 builder 任务指令）")
    .requiredOption("--tests <dir>", "能力验收测试目录（复制进 builder 工作区）")
    .requiredOption("--new-capability-task <file>", "构造候选前固定的新能力验收任务")
    .requiredOption("--regression-task <files...>", "构造候选前固定的核心及既有能力回归任务")
    .option("--executor <name>", "编码 worker 执行器名（默认 claude-code-acp）"),
).action(async (opts) => {
  await buildCommand(opts);
});

withCommon(
  program
    .command("candidates")
    .description("列出或查看候选（状态由事件投影）")
    .argument("[id]", "Candidate ID"),
).action(async (id: string | undefined, opts) => {
  await candidatesCommand(id, opts);
});

withCommon(
  program
    .command("evaluate")
    .description("独立评估候选：新能力验收 + 既有能力回归 + 基线对照（裁判由评估计划钉住）")
    .argument("<id>", "Candidate ID")
    .requiredOption("--new-capability-task <file>", "新能力验收任务 task.yaml")
    .requiredOption("--regression-task <files...>", "核心及既有能力回归任务 task.yaml"),
).action(async (id: string, opts) => {
  await evaluateCommand(id, opts);
});

withCommon(
  program
    .command("promote")
    .description("operator 批准晋升（须有 eligible 评估；CAS 提交，失败保持原快照）")
    .argument("<id>", "Candidate ID")
    .requiredOption("--as <principal>", "授权 operator 的 Principal ID")
    .option("--operation-id <id>", "幂等操作号（响应丢失重试时读回同一结果）")
    .option("--note <note>", "授权依据说明"),
).action(async (id: string, opts) => {
  await promoteCommand(id, opts);
});

withCommon(
  program
    .command("rollback")
    .description("回滚默认快照到历史版本（revision 只增不减，只影响后续 Run）")
    .requiredOption("--to <snapshot>", "目标快照 ID 或 digest")
    .requiredOption("--as <principal>", "授权 operator 的 Principal ID")
    .option("--operation-id <id>", "幂等操作号")
    .option("--note <note>", "回滚原因"),
).action(async (opts) => {
  await rollbackCommand(opts);
});

withCommon(
  program
    .command("supersede")
    .description("结案缺口等待的 Run 并创建接替 Run（R1 → failed/superseded，R2 绑当前快照）")
    .argument("<id>", "Run ID")
    .option("--note <note>", "接替说明"),
).action(async (id: string, opts) => {
  await supersedeCommand(id, opts);
});

withCommon(
  program
    .command("recover")
    .description("崩溃恢复：处置非终态 Run（遗留执行标记 unknown 等待对账，其余断点续跑）")
    .argument("[id]", "Run ID（缺省扫描全部）"),
).action(async (id: string | undefined, opts) => {
  await recoverCommand(id, opts);
});

withCommon(
  program
    .command("reconcile")
    .description("对账 unknown Attempt：以工作区产物完整性为完成证据，判定后续跑或重试")
    .argument("<id>", "Run ID"),
).action(async (id: string, opts) => {
  await reconcileCommand(id, opts);
});

withCommon(
  program
    .command("inspect")
    .description("按 ID 查看对象（run / task / snapshot / artifact-version / experience / 事件流）")
    .argument("<id>", "对象 ID"),
).action(async (id: string, opts) => {
  await inspectCommand(id, opts);
});

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
