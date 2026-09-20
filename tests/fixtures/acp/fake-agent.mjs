#!/usr/bin/env node
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
 * - 默认           → 请求权限 → 写正确实现 src/wordcount.mjs → end_turn
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const sessionState = { cwd: process.cwd(), sessionId: "fake-session-1" };
let cancelRequested = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = agent({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    info: { name: "fake-acp-agent", title: "Fake ACP Agent", version: "0.0.1" },
  }))
  .onRequest(methods.agent.session.new, async (ctx) => {
    const params = ctx.params;
    sessionState.cwd = params.cwd;
    return { sessionId: sessionState.sessionId, modes: null, meta: {} };
  })
  .onNotification(methods.agent.session.cancel, async () => {
    cancelRequested = true;
  })
  .onRequest(methods.agent.session.prompt, async (reqCtx) => {
    const { params, client } = reqCtx;
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");

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

    const toolCall = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "write src/wordcount.mjs",
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
    mkdirSync(join(sessionState.cwd, "src"), { recursive: true });
    writeFileSync(
      join(sessionState.cwd, "src", "wordcount.mjs"),
      buggy
        ? "export function countWords(text) {\n  return 0; // BUGGY\n}\n"
        : "export function countWords(text) {\n  return text.split(/\\s+/).filter((w) => w.length > 0).length;\n}\n",
      "utf8",
    );

    await client.notify(methods.client.session.update, {
      sessionId: sessionState.sessionId,
      update: { ...toolCall, status: "completed" },
    });
    await client.notify(methods.client.session.update, {
      sessionId: sessionState.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `已实现 src/wordcount.mjs${buggy ? "（故意错误）" : ""}` },
      },
    });
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
