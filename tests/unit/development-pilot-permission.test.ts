import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { developmentPilotPermission } from "../../src/app/development-pilot-permission.ts";

const workspace = "/private/tmp/pilot/workspaces/run/develop";
function request(name: string, filePath: string): RequestPermissionRequest {
  return {
    sessionId: "test",
    toolCall: {
      toolCallId: "write",
      title: "Write source",
      name,
      kind: "edit",
      status: "pending",
      rawInput: { file_path: filePath, content: "fixed source" },
    },
    options: [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "allow-all", name: "Yes to all", kind: "allow_always" },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ],
  };
}
describe("development pilot ACP permissions", () => {
  it("expands to exactly one registered target and rejects traversal in the target itself", async () => {
    const policy = developmentPilotPermission(workspace, "src/kernel/index.ts");
    expect(await policy(request("Write", "output/src/kernel/index.ts"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(await policy(request("Write", "output/src/runtime/schema-validator.ts"))).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(() => developmentPilotPermission(workspace, "../outside.ts")).toThrow(/safe relative/);
  });
  it("accepts the standard toolCall.name shape observed in the real run, once only", async () => {
    const policy = developmentPilotPermission(workspace);
    for (const path of [
      "output/src/runtime/schema-validator.ts",
      `${workspace}/output/src/runtime/schema-validator.ts`,
    ]) {
      expect(await policy(request("Write", path))).toEqual({
        outcome: { outcome: "selected", optionId: "allow-once" },
      });
    }
    expect(await policy(request("Read", "inputs/source.ts"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });
  it("rejects input writes, paths outside the workspace, unknown tools and conflicting metadata", async () => {
    const policy = developmentPilotPermission(workspace);
    for (const r of [
      request("Write", "inputs/checks.mjs"),
      request("Read", "../../secrets"),
      request("Write", "/tmp/elsewhere"),
      request("Bash", "output/src/runtime/schema-validator.ts"),
      {
        ...request("Read", "output/src/runtime/schema-validator.ts"),
        toolCall: {
          ...request("Read", "output/src/runtime/schema-validator.ts").toolCall,
          _meta: { claudeCode: { toolName: "Write" } },
        },
      },
    ]) {
      expect(await policy(r)).toEqual({ outcome: { outcome: "cancelled" } });
    }
  });
});
