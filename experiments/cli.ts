import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { experimentRunCommand, experimentReportCommand } from "./commands.ts";
const program = new Command();
function withCommon(command: Command) {
  return command
    .option("--home <dir>")
    .option("--json")
    .option("--model-adapter <path>")
    .option("--executor-adapter <path>")
    .option("--executors-config <path>")
    .option("--organism <id>")
    .option("--actor <id>");
}
const experiment = program;

withCommon(
  experiment
    .command("run")
    .description("manifest 驱动执行实验（退出码 0 完成 / 2 预检失败 / 3 不完整）")
    .requiredOption("--dataset <dir>", "数据集目录（含 cases.json 与 bundle）")
    .requiredOption("--out <dir>", "实验输出目录（manifest/trials/report 落盘处）")
    .option(
      "--llm <impl>",
      "L 组实现：fake（管道演练）| real（真实 Adapter，需模型适配器或 PROTEUS_LLM_API_KEY）",
      "fake",
    )
    .option("--arm <arms...>", "执行的组别（默认 R L）")
    .option("--repeats <n>", "每个 case 的重复次数", "3")
    .option("--experiment-id <id>", "实验 ID（缺省生成；恢复沿用原 ID 只补未开始单元）")
    .option("--seed <n>", "随机种子（R/L 先后顺序平衡）", "20260921")
    .option("--organism-calls <n>", "organism 域决策调用上限", "1000")
    .option("--experiment-calls <n>", "experiment 域决策调用上限", "300")
    .option("--wall-clock-minutes <n>", "单轮墙钟上限（分钟，达限保留证据标 inconclusive）", "60")
    .option(
      "--capability-module <file>",
      "changed-file-summary 能力模块 fixture（JSON）",
      fileURLToPath(new URL("../src/resources/changed-file-summary.module.json", import.meta.url)),
    )
    .option("--oracle", "先行 Oracle 正反预检（正确→succeeded，错误→failed）"),
).action(async (opts) => {
  await experimentRunCommand({
    ...opts,
    repeats: Number(opts.repeats),
    seed: Number(opts.seed),
    organismCalls: Number(opts.organismCalls),
    experimentCalls: Number(opts.experimentCalls),
    wallClockMinutes: Number(opts.wallClockMinutes),
    arm: opts.arm ?? [],
  });
});

withCommon(
  experiment
    .command("report")
    .description("只读证据复算报告（不调用模型；退出码 0 工程通过 / 2 失败）")
    .argument("<dir>", "实验输出目录")
    .option("--dataset <dir>", "数据集目录（提供则校验输入包摘要漂移）"),
).action(async (dir: string, opts) => {
  await experimentReportCommand(dir, opts);
});

await program.parseAsync();
