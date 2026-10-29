import type { SessionUpdate } from "@agentclientprotocol/sdk";

import type { PublicExecutionEvent } from "../../runtime/execution-evidence.ts";

// Only public tool metadata is projected. Thought chunks and opaque provider metadata are excluded.
export function publicEvent(update: SessionUpdate): PublicExecutionEvent | null {
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
    return { kind: "message", text: update.content.text };
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const input = boundedJson(update.rawInput);
    const output = boundedJson(update.rawOutput ?? update.content);
    return {
      kind: "tool",
      text: update.title?.slice(0, 500) ?? "",
      data: {
        toolCallId: update.toolCallId.slice(0, 256),
        status: update.status ?? undefined,
        toolKind: update.kind ?? undefined,
        input: input?.text,
        output: output?.text,
        truncated: !!(input?.truncated || output?.truncated),
      },
    };
  }
  if (update.sessionUpdate === "plan")
    return {
      kind: "plan",
      text: update.entries
        .slice(0, 30)
        .map((entry) => `${entry.status}: ${entry.content.slice(0, 300)}`)
        .join("\n"),
    };
  if (update.sessionUpdate === "usage_update")
    return {
      kind: "context",
      text: "上下文占用（不是累计计费 Token）",
      data: { used: update.used, size: update.size },
    };
  return null;
}

function boundedJson(value: unknown): { text: string; truncated: boolean } | undefined {
  if (value === undefined || value === null) return;
  let clipped = false;
  let remaining = 8000;
  const clean = (v: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 5) {
      clipped = true;
      return "[truncated]";
    }
    if (typeof v === "string") {
      const text = v.slice(0, Math.min(remaining, 4000));
      remaining -= text.length;
      clipped ||= text.length < v.length;
      return text;
    }
    if (Array.isArray(v)) {
      clipped ||= v.length > 30;
      return v.slice(0, 30).map((item) => clean(item, depth + 1));
    }
    if (v && typeof v === "object") {
      const entries = Object.entries(v);
      clipped ||= entries.length > 30;
      return Object.fromEntries(
        entries
          .slice(0, 30)
          .map(([key, item]) => [
            key.slice(0, 100),
            /password|secret|authorization|api.?key|access.?token/i.test(key)
              ? "[redacted]"
              : clean(item, depth + 1),
          ]),
      );
    }
    return v;
  };
  const serialized = JSON.stringify(clean(value, 0));
  if (!serialized) return;
  return { text: serialized.slice(0, 10000), truncated: clipped || serialized.length > 10000 };
}
