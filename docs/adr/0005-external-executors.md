---
status: accepted
date: 2026-09-20
---

# M1 外部执行器：标准 ACP SDK + 官方 agent 适配器 + pi SDK 直连

外部编码 agent 经三种方式接入，共用同一个内部 ExecutorProvider 合同：Claude Code 与 Codex 分别经官方 `@agentclientprotocol/claude-agent-acp` 与 `@agentclientprotocol/codex-acp`（agent 侧适配器，spawn 为子进程）以 ACP 接入；client 端只实现一次，基于官方 [typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk)（`@agentclientprotocol/sdk`）。pi 无原生 ACP（自有 pi-protocol v8 / RPC 体系），按其官方 SDK `@earendil-works/pi-coding-agent` 进程内直连。

考虑过为 pi 使用社区桥接包（`@geohar/pi-acp`，基于 fork 包装旧 RPC 模式）：引入非官方维护的中间层，而 pi 的 SDK 本身就是稳定的编程接口，直连少一层失效面。自研协议（类似 pi 的自研路线）被否决——ProteusOS 的立场是适配外部协议而非发明协议（ADR 0001）；需要定制的行为（权限策略、trace 收集、超时先 `session/cancel` 再宽限强杀）全部落在适配层内解决。

需要定制行为时的扩展点在适配层而非协议层：权限策略可注入（默认选首个 allow 类选项，无人值守可换 deny-all）；update 流与权限决定落盘为工作区 `.proteus/acp-trace.json`。真实凭据 E2E 默认门控（`PROTEUS_E2E=claude|codex|pi|all`），CI 用真实协议实现的 fake agent 覆盖合同；M1 真实验证结果：Claude Code（50s）与 Codex（28s，经代理）全链路通过，pi 链路验证至模型调用（受当时凭据的模型配额限制，与接入方式无关）。
