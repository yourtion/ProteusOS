// 复制到 ~/.proteus-local/executors.config.mjs 后，pnpm web 自动读取。
// 自己的适配器也放在此目录，以相对路径导入，不需要依赖项目源码。
// import traex from "./traex-executor.mjs";
// import opencodeW from "./opencode-w-executor.mjs";
export default {
  version: "proteus-executors-v1",
  enabled: ["pi", "opencode"],
  default: "pi",
  adapters: [],
  // 接入自己的实现后，可替换为：
  // enabled: ["traex", "opencode-w", "pi"],
  // default: "traex",
  // adapters: [traex, opencodeW],
};
