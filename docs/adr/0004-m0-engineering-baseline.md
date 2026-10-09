---
status: accepted
date: 2026-09-20
---

# 仓库技术栈与工程基线

ProteusOS 的仓库级技术栈于 2026-09-20 逐项确认。本文是唯一完整清单，[repository.md](../repository.md) 与 [roadmap.md](../roadmap.md) 只保留摘要并指向这里；架构层面的取舍见 ADR 0001–0003。

## 决策清单

| 领域 | 决策 |
| --- | --- |
| 语言与运行时 | TypeScript（strict）+ Node 24；`engines: >=24`，`.node-version` 固定 24；CLI 用 tsx 直跑 |
| 模块与构建 | ESM-only、NodeNext 模块解析；M0 无构建步骤，CLI 入口经 tsx 加载 TypeScript 源码，出现分发需求再加编译产物 |
| 存储 | 内置 `node:sqlite` 单 writer + 按摘要寻址的 blob 文件；驱动位于 Persistence port 之后 |
| 包管理 | pnpm；根包 `@techs/proteus`，后续包统一 `@techs` scope，暂不发布 |
| CLI | commander；二进制名 `proteus` |
| 运行时校验 | zod v4；分享包等边界校验；任务验收由 runtime 的 JSON Schema 校验实现执行 |
| 配置解析 | `yaml` 包（task.yaml 等配置文件） |
| 日志 | pino 结构化 JSON 运维日志；与 SQLite 事件账本是两条独立通道 |
| 测试 | vitest；分层布局与替身要求见 [repository.md §5](../repository.md#5-验证布局) |
| Lint / Format | oxlint + oxfmt |
| CI | GitHub Actions，Linux + macOS 矩阵；默认无外网、无凭据、合成 fixtures；真实 ACP 集成显式启用 |
| 标识与时间 | ID 用 UUIDv7（时间有序，利于事件流排序）；时钟经注入 seam，不直接调用系统时间 |
| 仓库结构 | 单包模块化（`src/` 分模块），拆包触发条件与实例数据布局见 [repository.md](../repository.md) |
| License | Apache-2.0；版权署名：郭宇翔（沿用原 MIT License 中的署名） |

## 替代方案与理由

- **Node，而非 Bun**：Bun 内置 SQLite 与 test runner、零依赖起点，但 Node 生态更保守、团队更熟；用 tsx 补齐直跑 TypeScript 的体验。
- **node:sqlite，而非 better-sqlite3**：原生模块需随 Node 大版本重编译（曾在 Node 24 出现 ABI 故障）；内置 API 的兼容风险由 Persistence port 隔离，更换运行时版本时复核。
- **zod v4，而非 ajv**：TS-first 类型推导与严格对象校验；验收 JSON Schema 与边界对象校验分别使用各自实现。
- **commander，而非 cac / 手写解析**：五命令起步但只增不减，子命令、help、flag 解析一次到位。
- **pino，而非手写 JSONL**：时间戳、级别、子上下文是白送能力；M0 的崩溃恢复验收需要结构化现场。

## 后续决策

外部执行器见 ADR 0005，自举与评估见 ADR 0006/0008，共享治理见 ADR 0009/0010。当前剩余工作统一见 [路线图](../roadmap.md#2-尚未完成或验证)。更换运行时主版本时复核 node:sqlite API、迁移与恢复兼容性。
