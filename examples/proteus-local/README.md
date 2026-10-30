# 用户级本地接入目录

在仓库根目录执行以下命令，以不覆盖已有文件的方式安装示例：

```bash
mkdir -p ~/.proteus-local
cp -n examples/proteus-local/executors.config.mjs ~/.proteus-local/executors.config.mjs
pnpm web
```

将自己的 `traex-executor.mjs`、`opencode-w-executor.mjs` 移到 `~/.proteus-local/`，然后修改该目录下的 `executors.config.mjs`，通过 `./traex-executor.mjs` 等相对路径导入。

可选：把模型适配器命名为 `~/.proteus-local/model-adapter.mjs`，启动时会一起加载。只有需要模型服务时才添加这个入口；可以从仓库的 `examples/model-adapter.mjs` 复制，并按自己的鉴权协议修改。

本地目录不需要包含 Proteus 源码。外部依赖需要安装在本地目录能解析到的位置；`.mjs` 适配器使用 `createAcpExecutor` 时无需导入 Proteus 包。完整教程见仓库 `docs/local-configuration.md`。
