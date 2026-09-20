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
| 运行时校验 | zod v4；内部边界校验与 JSON Schema 导出（`z.toJSONSchema`）共用一个库 |
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
- **node:sqlite，而非 better-sqlite3**：原生模块需随 Node 大版本重编译（曾在 Node 24 出现 ABI 故障）；node:sqlite 尚为 Stability 1.2（Release Candidate），该风险由 Persistence port 隔离、驱动可平移对冲。
- **zod v4，而非 ajv**：TS-first 类型推导；`z.toJSONSchema` 让 task 验收 schema 文件与内部边界校验共用一套定义。
- **commander，而非 cac / 手写解析**：五命令起步但只增不减，子命令、help、flag 解析一次到位。
- **pino，而非手写 JSONL**：时间戳、级别、子上下文是白送能力；M0 的崩溃恢复验收需要结构化现场。

## 延后与复核

以下不属本文预决，决策时点见 [roadmap.md 待验证项](../roadmap.md#待验证项)：ACP SDK 与 worker 选型（M1）、隔离执行环境（M1/M2）、晋升自动化边界（M2）、评估协议参数（M2/M3）、本地模型与微调路线（M3 后）、团队治理（M4 前）。M0 的 CLI 命令集、task.yaml schema、预算维度与 G0 快照槽位属产品形态决策，同样记录于该表。

Node 26 转 LTS（2026-10-28）后复核 `node:sqlite` API 稳定性与 engines 基线。
