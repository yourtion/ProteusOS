// 只列出允许派发的执行器；default 必须位于 enabled 中。
// Pi 使用现有 SDK 和 ~/.pi/agent 配置；OpenCode 通过 opencode acp 接入。
export default {
  version: "proteus-executors-v1",
  enabled: ["codex", "claude", "pi", "opencode"],
  default: "pi",
  // 可导入自己的执行器适配器对象，加入 adapters，并将其 name 加入 enabled。
  adapters: [],
};
