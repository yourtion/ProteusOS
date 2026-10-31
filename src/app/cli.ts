import { loadAppAdapters } from "./adapters.ts";
import { Command } from "commander";
import {
  accessCommand,
  keyCreateCommand,
  keyTrustCommand,
  keyRevokeCommand,
  publicationSignCommand,
  registryCredentialCommand,
  registryRevokeCommand,
  registryPublishCommand,
  registryImportCommand,
  registryServeCommand,
} from "./sharing-commands.ts";
import {
  advanceCommand,
  buildCommand,
  candidatesCommand,
  cancelCommand,
  evaluateCommand,
  initCommand,
  inspectCommand,
  consolidateCancelCommand,
  consolidateCommand,
  consolidateJobCommand,
  consolidateJobsCommand,
  consolidateRunCommand,
  consolidateRecoverCommand,
  consolidateSubmitCommand,
  evaluatePolicyCommand,
  teamCreateCommand,
  teamGrantCommand,
  shareForkCommand,
  publishCommand,
  shareExportCommand,
  shareImportCommand,
  inheritCommand,
  shareRejectCommand,
  organismsCommand,
  validationRegisterCommand,
  datasetFreezeCommand,
  datasetInspectCommand,
  datasetListCommand,
  judgeUpgradeCommand,
  promoteCommand,
  recoverCommand,
  reconcileCommand,
  rollbackCommand,
  runsCommand,
  settleDecisionCommand,
  submitCommand,
  supersedeCommand,
} from "./commands.ts";

const program = new Command();
program.name("proteus").description("ProteusOS：多个体运行、受控演化与选择性共享").version("0.1.0");

function withCommon(cmd: Command): Command {
  return cmd
    .option("--executors-config <file>", "可用执行器与默认执行器配置模块")
    .option("--executor-adapter <file>", "本地执行器适配器模块（或 PROTEUS_EXECUTOR_ADAPTER）")
    .option("--runtime-adapter <file>", "本地决策/学习/能力沙箱模块（或 PROTEUS_RUNTIME_ADAPTER）")
    .option("--model-adapter <file>", "本地模型适配器模块（或 PROTEUS_MODEL_ADAPTER）")
    .option("--home <dir>", "实例根目录（默认 ~/.proteus 或 PROTEUS_HOME）")
    .option("--organism <id>", "个体 ID", "organism-default")
    .option("--actor <principal>", "当前主体 Principal ID", "principal-local")
    .option("--json", "以 JSON 输出");
}

withCommon(
  program
    .command("web")
    .description("启动本地代码工作台")
    .option("--port <port>", "监听端口", "4310"),
).action(async (opts) => {
  if (opts.organism !== "organism-default" || opts.actor !== "principal-local")
    throw new Error("首版工作台使用默认个体和本地操作者");
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无效端口");
  const { startWorkbench } = await import("./web/server.ts");
  const adapters = await loadAppAdapters(opts);
  const { buildWorkbenchAssets } = await import("./web/assets.ts");
  await buildWorkbenchAssets();
  const server = startWorkbench(port, opts.home ?? process.env.PROTEUS_HOME ?? ".proteus-web", {
    ...adapters,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server.shutdown().then(() => process.exit(0));
    });
});

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
    .command("evaluate-policy")
    .description("策略候选评估：双臂 × 验证集 × 重复（m3-policy-eval-v1，指标分列）")
    .argument("<id>", "Candidate ID")
    .option("--cases <file>", "验证集 JSON（[{id, familyId, task, expectedChoice}]）")
    .option("--repeats <n>", "每 case 重复次数（未提供时使用冻结计划）"),
).action(async (id: string, opts) => {
  await evaluatePolicyCommand(id, opts);
});

withCommon(
  program
    .command("validation-register")
    .description("注册不可变策略验证集及冻结评估计划")
    .requiredOption("--cases <file>", "验证集 JSON（[{id, familyId, task, expectedChoice}]）")
    .option("--repeats <n>", "每 case 重复次数", "1")
    .option("--dev-family <ids...>", "当前开发集 family ID")
    .option("--source <ref>", "来源引用（默认 cases 文件路径）"),
).action(async (opts) => {
  await validationRegisterCommand(opts);
});

withCommon(
  program
    .command("consolidate-submit")
    .description("异步提交 Consolidation 作业（提交即返回；consolidate-run 驱动执行）")
    .argument("<datasetId>", "development 用途的经验集 ID")
    .option("--gold <file>", "开发集标注 JSON（验证 family 不得传入）")
    .option("--validation-set <id>", "绑定验证集 ID")
    .option("--mode <mode>", "rule | llm（llm 需模型适配器或 PROTEUS_LLM_API_KEY）", "rule")
    .option("--min-support <n>", "最小支持数（默认 2）")
    .option("--min-precision <f>", "最小精度 0-1（默认 0.8）")
    .option("--max-rules <n>", "规则数上限（默认 4）"),
).action(async (datasetId: string, opts) => {
  await consolidateSubmitCommand(datasetId, opts);
});

withCommon(
  program
    .command("consolidate-run")
    .description("驱动 Consolidation 队列（queued → running → completed/failed）")
    .option("--limit <n>", "一次最多处理的作业数（默认 1）", "1")
    .option("--learning-calls <n>", "设置本个体独立累计学习调用上限（未知调用保留额度）"),
).action(async (opts) => {
  await consolidateRunCommand(opts);
});

withCommon(
  program
    .command("consolidate-recover")
    .description("停止其他归纳进程后结案崩溃遗留作业；不重发模型调用"),
).action(async (opts) => {
  await consolidateRecoverCommand(opts);
});

withCommon(
  program
    .command("consolidate-jobs")
    .description("列出 Consolidation 作业")
    .argument("[datasetId]", "按经验集过滤"),
).action(async (datasetId: string | undefined, opts) => {
  await consolidateJobsCommand(datasetId, opts);
});

withCommon(
  program.command("consolidate-job").description("查看作业详情与事件").argument("<id>", "Job ID"),
).action(async (id: string, opts) => {
  await consolidateJobCommand(id, opts);
});

withCommon(
  program
    .command("consolidate-cancel")
    .description("取消排队或执行中的归纳作业（未知费用保留）")
    .argument("<id>", "Job ID"),
).action(async (id: string, opts) => {
  await consolidateCancelCommand(id, opts);
});

withCommon(
  program
    .command("consolidate")
    .description("从冻结经验集归纳策略候选（确定性规则归纳，只改 routing-policy）")
    .argument("<datasetId>", "development 用途的经验集 ID")
    .option("--gold <file>", "开发集标注 JSON（[{goal, choice}]；验证 family 不得传入）")
    .option("--validation-set <id>", "绑定验证集 ID"),
).action(async (datasetId: string, opts) => {
  await consolidateCommand(datasetId, opts);
});

withCommon(
  program
    .command("dataset-freeze")
    .description("冻结经验窗口为数据集（显式成员 + 内容摘要 + 截止点 + 用途许可）")
    .option("--purpose <purpose>", "development | validation | regression", "development")
    .option("--cutoff <iso>", "截止时刻（默认现在）"),
).action(async (opts) => {
  await datasetFreezeCommand(opts);
});

withCommon(program.command("dataset-list").description("列出冻结经验集")).action(async (opts) => {
  await datasetListCommand(opts);
});

withCommon(
  program
    .command("dataset-inspect")
    .description("查看经验集与学习投影")
    .argument("<id>", "Dataset ID"),
).action(async (id: string, opts) => {
  await datasetInspectCommand(id, opts);
});

withCommon(
  program.command("team-create").description("创建共享团队").argument("<teamId>", "Team ID"),
).action(async (teamId: string, opts) => teamCreateCommand(teamId, opts));

withCommon(
  program
    .command("team-grant")
    .description("向主体授予团队权限")
    .argument("<teamId>", "Team ID")
    .argument("<principalId>", "Principal ID")
    .requiredOption("--permission <permission>", "read | publish | manage"),
).action(async (teamId: string, principalId: string, opts) => {
  await teamGrantCommand(teamId, principalId, opts);
});

withCommon(
  program
    .command("share-fork")
    .description("将共享版本分叉到当前个体")
    .requiredOption("--versions <ids...>", "源版本 ID")
    .requiredOption("--scope <scope>", "public | team:<id> | organism:<id>"),
).action(async (opts) => {
  await shareForkCommand(opts);
});

withCommon(
  program
    .command("publish")
    .description("发布版本包到公共或团队范围")
    .requiredOption("--team <id>", "Team ID")
    .requiredOption("--versions <ids...>", "要发布的版本 ID")
    .requiredOption("--scope <scope>", "public | team:<id>")
    .option("--evidence <evaluationIds...>", "评估记录 ID"),
).action(async (opts) => {
  await publishCommand(opts);
});

withCommon(
  program
    .command("share-export")
    .description("导出已发布的共享包")
    .argument("<publicationId>", "Publication ID")
    .requiredOption("--out <file>", "导出 JSON 文件路径"),
).action(async (publicationId: string, opts) => {
  await shareExportCommand(publicationId, opts);
});

withCommon(
  program
    .command("share-import")
    .description("导入共享包（不激活）")
    .argument("<file>", "Share envelope JSON 路径"),
).action(async (file: string, opts) => {
  await shareImportCommand(file, opts);
});

withCommon(
  program
    .command("inherit")
    .description("基于已导入版本构造继承候选")
    .argument("<importId>", "Import ID")
    .requiredOption("--validation-set <id>", "验证集 ID")
    .option("--versions <localids...>", "继承的本地版本 ID")
    .option("--hypothesis <text>", "候选假设"),
).action(async (importId: string, opts) => {
  await inheritCommand(importId, opts);
});

withCommon(
  program
    .command("share-reject")
    .description("拒绝导入记录")
    .argument("<importId>", "Import ID")
    .option("--note <note>", "拒绝说明"),
).action(async (importId: string, opts) => {
  await shareRejectCommand(importId, opts);
});

withCommon(program.command("organisms").description("列出当前主体拥有或获准访问的个体")).action(
  async (opts) => organismsCommand(opts),
);

withCommon(
  program
    .command("judge-upgrade")
    .description("构造裁判升级候选（hybrid）并做判定等价评估；晋升仍由 operator promote")
    .requiredOption("--regression-task <file>", "能力不变的回归任务 task.yaml（判定等价对照）")
    .option("--as <principal>", "提议者 Principal ID（默认 principal-local）"),
).action(async (opts) => {
  await judgeUpgradeCommand(opts);
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
    .description(
      "按 ID 查看对象（run / task / candidate / evaluation / promotion / snapshot / artifact-version / experience / 事件流）",
    )
    .argument("<id>", "对象 ID"),
).action(async (id: string, opts) => {
  await inspectCommand(id, opts);
});

withCommon(
  program
    .command("settle-decision")
    .description(
      "显式结案 unknown 决策调用（保留证据与未结算费用，Run 以 failed/decision_unknown 结案）",
    )
    .argument("<decisionId>", "决策调用 ID")
    .option("--note <note>", "结案说明"),
).action(async (decisionId: string, opts) => {
  await settleDecisionCommand(decisionId, opts);
});

for (const kind of ["grant", "revoke"] as const) {
  withCommon(
    program
      .command(`access-${kind}`)
      .description(`${kind === "grant" ? "授予" : "撤销"}当前组织或团队权限`)
      .argument("<scope>", "organism:<id> 或 team:<id>")
      .argument("<principal>")
      .requiredOption("--permission <action>", "read/operate/promote/publish/manage"),
  ).action(async (scope: string, principal: string, opts) => {
    await accessCommand(kind, scope, principal, opts);
  });
}
withCommon(
  program
    .command("sharing-key-create")
    .description("创建团队发布签名密钥，仅导出公钥")
    .argument("<team>")
    .requiredOption("--public-out <file>", "公钥文件（须不存在）"),
).action(async (team: string, opts) => {
  await keyCreateCommand(team, opts);
});
withCommon(
  program
    .command("sharing-key-trust")
    .description("登记当前个体信任的团队发布公钥")
    .argument("<team>")
    .requiredOption("--publisher <principal>")
    .requiredOption("--public-key <file>"),
).action(async (team: string, opts) => {
  await keyTrustCommand(team, opts);
});
withCommon(
  program
    .command("sharing-key-revoke")
    .description("永久撤销当前个体对发布公钥的信任")
    .argument("<keyId>"),
).action(async (keyId: string, opts) => {
  await keyRevokeCommand(keyId, opts);
});
withCommon(
  program
    .command("publication-sign")
    .description("导出带来源签名的离线分享包")
    .argument("<publicationId>")
    .requiredOption("--key <keyId>")
    .requiredOption("--out <file>"),
).action(async (publicationId: string, opts) => {
  await publicationSignCommand(publicationId, opts);
});

const registry = program
  .command("registry")
  .description("签名发布 registry（客户端远程地址须 HTTPS）");
withCommon(
  registry
    .command("serve")
    .description("启动本地 registry；远程部署通过 HTTPS 反向代理接入")
    .option("--port <port>", "本机监听端口，0 为随机", "9030"),
).action(async (opts) => {
  await registryServeCommand(opts);
});
withCommon(
  registry
    .command("token-create")
    .description("为团队已有权限签发 registry 凭据")
    .requiredOption("--team <id>")
    .requiredOption("--principal <id>")
    .requiredOption("--permission <actions...>", "read/publish")
    .requiredOption("--out <file>", "凭据文件（须不存在，权限 0600）"),
).action(async (opts) => {
  await registryCredentialCommand(opts);
});
withCommon(
  registry.command("token-revoke").description("撤销 registry 凭据").argument("<id>"),
).action(async (id: string, opts) => {
  await registryRevokeCommand(id, opts);
});
withCommon(
  registry
    .command("publish")
    .description("签名并上传精确发布记录，不重试远端写入")
    .argument("<publicationId>")
    .requiredOption("--key <keyId>")
    .requiredOption("--registry <url>")
    .requiredOption("--token-file <file>"),
).action(async (publicationId: string, opts) => {
  await registryPublishCommand(publicationId, opts);
});
withCommon(
  registry
    .command("import")
    .description("下载并验证当前个体信任的签名发布，不改变默认行为")
    .argument("<digest>")
    .requiredOption("--registry <url>")
    .option("--token-file <file>", "team 包需要 registry read 凭据"),
).action(async (digest: string, opts) => {
  await registryImportCommand(digest, opts);
});

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
