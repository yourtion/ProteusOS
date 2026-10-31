/** Deterministic ACP agent for clean browser acceptance; no model or network calls. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
let cwd = process.cwd();
let cancelled = false;
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fixture-model",
    options: [
      { value: "fixture-model", name: "Fixture model" },
      { value: "alternate-model", name: "Alternate" },
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
const sessionId = "browser-fixture";
const app = agent({ name: "browser-fixture" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    info: { name: "browser-fixture", version: "1" },
  }))
  .onRequest(methods.agent.session.new, async ({ params }) => {
    cwd = params.cwd;
    cancelled = false;
    return { sessionId, configOptions };
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const option = configOptions.find((o) => o.id === params.configId);
    if (!option || !option.options.some((v) => v.value === params.value))
      throw new Error("unsupported fixture option");
    option.currentValue = params.value;
    return { configOptions };
  })
  .onNotification(methods.agent.session.cancel, async () => {
    cancelled = true;
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const prompt = params.prompt.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    const goal = prompt.split("\nPrevious conversation")[0].split("\n\nWork only")[0];
    const message = async (text) =>
      client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    await message(
      `使用 ${configOptions[0].currentValue} / ${configOptions[1].currentValue} 开始验证。\n`,
    );
    if (goal.includes("SLOW")) {
      for (let i = 0; i < 600 && !cancelled; i++) await new Promise((r) => setTimeout(r, 100));
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    if (goal.includes("FAIL")) {
      await message("测试 agent 故意失败。\n");
      return { stopReason: "error" };
    }
    if (!goal.includes("READ")) {
      const toolCall = {
        toolCallId: "edit-math",
        title: "修改 math.mjs",
        status: "pending",
        kind: "edit",
      };
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { ...toolCall, sessionUpdate: "tool_call", status: "in_progress" },
      });
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow_once", name: "允许修改", kind: "allow_once" },
          { optionId: "reject_once", name: "拒绝修改", kind: "reject_once" },
        ],
      });
      if (
        permission.outcome.outcome !== "selected" ||
        permission.outcome.optionId !== "allow_once"
      ) {
        await message("权限被拒，未修改文件。\n");
        return { stopReason: "cancelled" };
      }
      if (goal.includes("BINARY")) writeFileSync(join(cwd, "asset.bin"), Buffer.from([0, 4, 5, 6]));
      writeFileSync(
        join(cwd, "math.mjs"),
        goal.includes("BUGGY")
          ? "export const add = (a,b) => a-b;\n"
          : "export const add = (a,b) => a+b;\n",
      );
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { ...toolCall, sessionUpdate: "tool_call_update", status: "completed" },
      });
    }
    const content = readFileSync(join(cwd, "math.mjs"), "utf8");
    const summary = `# 浏览器验收报告\n\n${goal.includes("READ") ? "已只读检查" : "已修改"} math.mjs。\n\n模型：${configOptions[0].currentValue}；强度：${configOptions[1].currentValue}\n\n\`\`\`js\n${content}\`\`\`\n`;
    writeFileSync(join(cwd, ".proteus-summary.md"), summary);
    await message(summary);
    return { stopReason: "end_turn" };
  });
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
