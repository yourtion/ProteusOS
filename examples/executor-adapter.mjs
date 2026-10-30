// 无需导入 Proteus 源码；可以把此文件放在仓库外。
export default {
  version: "proteus-executor-adapter-v1",
  name: "my-acp",
  async create({ createAcpExecutor, signal }) {
    signal.throwIfAborted();
    const command = process.env.MY_ACP_COMMAND;
    if (!command) throw new Error("请设置 MY_ACP_COMMAND 为 ACP stdio 可执行文件路径");
    const args = JSON.parse(process.env.MY_ACP_ARGS ?? "[]");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
      throw new Error("MY_ACP_ARGS 必须是字符串数组 JSON");
    // 可在这里请求动态 token；鉴权网络调用也应传入 signal。
    // 请根据自己的 agent 修改变量名；环境只传给子进程，不写入策略或 trace。
    const token = process.env.MY_ACP_TOKEN;
    return createAcpExecutor({
      command,
      agentArgs: args,
      env: { ...process.env, ...(token ? { MY_AGENT_TOKEN: token } : {}) },
      // sessionMeta 可设置 agent 支持的模型、轮数等公开配置，不放凭据。
      sessionMeta: {},
    });
  },
};
