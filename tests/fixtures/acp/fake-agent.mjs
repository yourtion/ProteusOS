/**
 * 测试用 fake ACP agent（M1）：真实实现 ACP 协议（@agentclientprotocol/sdk），
 * 行为脚本化，供 executor-acp 合同测试与 M1 验收故事（CI）使用。
 *
 * 按 prompt 内容分支：
 * - 含 "BUGGY"     → 写一个错误实现（测试失败路径）
 * - 含 "FAIL-MODE" → 直接 stopReason=error
 * - 含 "DENY-ME"   → 权限被拒后 stopReason=cancelled
 * - 含 "SLOW-MODE" → 模拟长任务：等待约 4s（期间可被 session/cancel 打断为 cancelled）
 * - 含 "EXIT-MODE" → 处理中进程自行退出（模拟 agent 崩溃断连）
 * - 含 "CHANGED-FILE-SUMMARY"（M2 builder）→ 写 src/changed-file-summary.mjs
 *   （BUGGY 同用：分类恒为 other，能力测试失败）
 * - 默认           → 请求权限 → 写正确实现 src/wordcount.mjs → end_turn
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const sessionState = { cwd: process.cwd(), sessionId: "fake-session-1" };
let cancelRequested = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const testConfiguration = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "base",
    options: [
      { value: "base", name: "Base" },
      { value: "my-model", name: "Custom" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];
const app = agent({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    info: { name: "fake-acp-agent", title: "Fake ACP Agent", version: "0.0.1" },
  }))
  .onRequest(methods.agent.session.new, async (ctx) => {
    const params = ctx.params;
    sessionState.cwd = params.cwd;
    if (params._meta?.testConfiguration === "probe") {
      writeFileSync(
        join(params.cwd, "configuration-probe.json"),
        JSON.stringify({
          meta: params._meta,
          environmentMatched: process.env.PROTEUS_TEST_ACP_ENV === "explicit-test-value",
        }),
      );
    }
    return {
      sessionId: sessionState.sessionId,
      modes: null,
      meta: {},
      ...(process.env.PROTEUS_TEST_CONFIG_OPTIONS ? { configOptions: testConfiguration } : {}),
    };
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const option = testConfiguration.find((item) => item.id === params.configId);
    if (!option || !option.options.some((item) => item.value === params.value))
      throw new Error("unsupported test configuration");
    option.currentValue = params.value;
    writeFileSync(
      join(sessionState.cwd, "selected-configuration.json"),
      JSON.stringify(
        Object.fromEntries(testConfiguration.map((item) => [item.id, item.currentValue])),
      ),
    );
    return { configOptions: testConfiguration };
  })
  .onNotification(methods.agent.session.cancel, async () => {
    cancelRequested = true;
  })
  .onRequest(methods.agent.session.prompt, async (reqCtx) => {
    const { params, client } = reqCtx;
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");

    if (text.includes("HIDDEN-MODE")) {
      await client.notify(methods.client.session.update, {
        sessionId: sessionState.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "HIDDEN-THOUGHT-MARKER" },
        },
      });
    }

    if (text.includes("EXIT-MODE")) {
      // 模拟 agent 崩溃：发一个 update 后进程退出，连接关闭
      await client.notify(methods.client.session.update, {
        sessionId: sessionState.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "即将崩溃" },
        },
      });
      process.exit(3);
    }

    if (text.includes("SLOW-MODE")) {
      for (let i = 0; i < 80 && !cancelRequested; i++) {
        await sleep(50);
      }
      return { stopReason: cancelRequested ? "cancelled" : "end_turn" };
    }

    if (text.includes("ACCOUNTING-MODE")) {
      for (let i = 0; i < 1000; i++)
        await client.notify(methods.client.session.update, {
          sessionId: sessionState.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "text" } },
        });
      for (const status of ["in_progress", "completed"])
        await client.notify(methods.client.session.update, {
          sessionId: sessionState.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "late-tool",
            title: "late write",
            status,
          },
        });
      for (let i = 0; i < 3; i++)
        await client.notify("_claude/sdkMessage", {
          sessionId: sessionState.sessionId,
          message: {
            type: "assistant",
            message: {
              id: "response-1",
              model: "fixture-model",
              content: [{ type: "thinking", thinking: "PRIVATE-SDK-CONTENT" }],
              usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 30,
                cache_creation_input_tokens: 40,
              },
            },
          },
        });
      for (let i = 0; i < 2; i++)
        await client.notify("_claude/sdkMessage", {
          sessionId: sessionState.sessionId,
          message: {
            type: "result",
            total_cost_usd: 0.012,
            modelUsage: {
              "fixture-model": {
                inputTokens: 10,
                outputTokens: 20,
                cacheReadInputTokens: 30,
                cacheCreationInputTokens: 40,
              },
            },
          },
        });
      await sleep(100);
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedReadTokens: 30,
          cachedWriteTokens: 40,
          totalTokens: 100,
        },
      };
    }

    const toolCall = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "write implementation",
      kind: "create",
      status: "in_progress",
    };
    await client.notify(methods.client.session.update, {
      sessionId: sessionState.sessionId,
      update: toolCall,
    });

    const permission = await client.request(methods.client.session.requestPermission, {
      sessionId: sessionState.sessionId,
      toolCall: { ...toolCall, status: "pending" },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });
    const denied =
      permission.outcome.outcome !== "selected" || permission.outcome.optionId !== "allow_once";

    if (denied) {
      await client.notify(methods.client.session.update, {
        sessionId: sessionState.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "权限被拒，无法写文件" },
        },
      });
      return { stopReason: "cancelled" };
    }

    if (text.includes("FAIL-MODE")) {
      return { stopReason: "error" };
    }

    const buggy = text.includes("BUGGY");
    const capabilityBuild = text.includes("CHANGED-FILE-SUMMARY");
    mkdirSync(join(sessionState.cwd, "src"), { recursive: true });
    if (capabilityBuild) {
      // M2 builder 分支：标准实现从 fixture 读取（与测试基准一致）；BUGGY 恒返 other
      const good = readFileSync(
        join(
          fileURLToPath(import.meta.url),
          "..",
          "..",
          "changed-file-summary",
          "implementation.mjs",
        ),
        "utf8",
      );
      const bad = [
        good.split("export function")[0] ?? "",
        "export function classifyChanges(changes) {",
        '  return { total: changes.length, files: changes.map((c) => ({ path: c.path, category: "other" })) }; // BUGGY',
        "}",
        "",
      ].join("\n");
      writeFileSync(
        join(sessionState.cwd, "src", "changed-file-summary.mjs"),
        buggy ? bad : good,
        "utf8",
      );
    } else {
      writeFileSync(
        join(sessionState.cwd, "src", "wordcount.mjs"),
        buggy
          ? "export function countWords(text) {\n  return 0; // BUGGY\n}\n"
          : "export function countWords(text) {\n  return text.split(/\\s+/).filter((w) => w.length > 0).length;\n}\n",
        "utf8",
      );
    }

    const writtenFile = capabilityBuild ? "src/changed-file-summary.mjs" : "src/wordcount.mjs";
    await client.notify(methods.client.session.update, {
      sessionId: sessionState.sessionId,
      update: { ...toolCall, status: "completed" },
    });
    await client.notify(methods.client.session.update, {
      sessionId: sessionState.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `已实现 ${writtenFile}${buggy ? "（故意错误）" : ""}` },
      },
    });
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
