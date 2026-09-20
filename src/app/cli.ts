import { Command } from "commander";
import {
  cancelCommand,
  initCommand,
  inspectCommand,
  runsCommand,
  submitCommand,
} from "./commands.ts";

const program = new Command();
program
  .name("proteus")
  .description("ProteusOS 运行基质 CLI（M0 切片①：单节点闭环）")
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
