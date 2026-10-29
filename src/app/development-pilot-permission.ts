import { join, resolve } from "node:path";
import type { AcpPermissionPolicy } from "../adapters/executor-acp/index.ts";

/** Capability for the one-file pilot only; paths and tool names must both match. */
export function developmentPilotPermission(workspace: string): AcpPermissionPolicy {
  const readable = new Set(
    ["inputs/source.ts", "inputs/checks.mjs", "output/src/runtime/schema-validator.ts"].map(
      (path) => join(workspace, path),
    ),
  );
  const writable = join(workspace, "output/src/runtime/schema-validator.ts");
  return (request) => {
    const raw = request.toolCall.rawInput as { file_path?: unknown } | undefined;
    const meta = request.toolCall._meta as { claudeCode?: { toolName?: unknown } } | undefined;
    const toolName = request.toolCall.name ?? meta?.claudeCode?.toolName;
    if (
      request.toolCall.name &&
      meta?.claudeCode?.toolName &&
      request.toolCall.name !== meta.claudeCode.toolName
    )
      return { outcome: { outcome: "cancelled" } };
    const path = typeof raw?.file_path === "string" ? resolve(workspace, raw.file_path) : "";
    const allowed =
      (toolName === "Read" && readable.has(path)) ||
      ((toolName === "Write" || toolName === "Edit") && path === writable);
    const option = request.options.find((o) => o.kind === "allow_once");
    return allowed && option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };
}
