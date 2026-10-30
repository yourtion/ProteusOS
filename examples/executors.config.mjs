// 只列出允许派发的执行器；default 必须位于 enabled 中。
// Pi 使用现有 SDK 和 ~/.pi/agent 配置；OpenCode 通过 opencode acp 接入。
export default {
  version: "proteus-executors-v1",
  enabled: ["codex", "claude", "pi", "opencode"],
  default: "pi",
  // 可导入自己的执行器适配器对象，加入 adapters，并将其 name 加入 enabled。
  adapters: [],
  // 可添加 choices: { "my-acp": { models: ["实际模型 ID"], reasoningEfforts: ["high"] } }
  // choices 的键必须对应内置或 adapters 中已注册的执行器。
};
