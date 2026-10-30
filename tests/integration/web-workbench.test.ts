import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { startWorkbench } from "../../src/app/web/server.ts";
import { Workbench } from "../../src/app/workbench/service.ts";
import type { WorkbenchOptions } from "../../src/app/workbench/service.ts";
import { openInstance } from "../../src/app/instance.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proteus-workbench-"));
  const project = join(root, "project");
  execFileSync("git", ["init", "-q", project]);
  writeFileSync(join(project, "math.mjs"), "export const add = (a,b) => a-b;\n");
  writeFileSync(
    join(project, "check.mjs"),
    'import {add} from "./math.mjs"; if(add(2,3)!==5) process.exit(1);\n',
  );
  return { root, project, home: join(root, "instance") };
}
const factory: WorkbenchOptions["executorFactory"] = (_name, permission) => ({
  name: "test",
  recoveryPolicy: "manual",
  async start(req) {
    req.onEvent?.({ kind: "message", text: "正在修复加法" });
    if (req.prompt.includes("SLOW"))
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    else {
      if (req.prompt.includes("ASK")) {
        const response = await permission({
          sessionId: "test-session",
          toolCall: { toolCallId: "test-tool", title: "写入 math.mjs", status: "pending" },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "允许一次" },
            { optionId: "reject_once", kind: "reject_once", name: "拒绝" },
          ],
        });
        if (response.outcome.outcome !== "selected" || response.outcome.optionId !== "allow_once")
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "权限被拒绝",
            durationMs: 1,
            outputRef: null,
          };
      }
      if (!req.prompt.includes("READ"))
        writeFileSync(join(req.workspaceDir, "math.mjs"), "export const add = (a,b) => a+b;\n");
      writeFileSync(join(req.workspaceDir, ".proteus-summary.md"), "已完成分析或修复。");
    }
    return {
      ok: !req.signal?.aborted,
      exitCode: 0,
      stdout: "完成",
      stderr: "",
      durationMs: 1,
      outputRef: null,
    };
  },
});
async function waitFor<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const result = fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}
const input = (projectId: string, goal = "修复加法") => ({
  projectId,
  goal,
  mode: "edit",
  executor: "codex",
  timeoutSeconds: 30,
  requestId: crypto.randomUUID(),
});

it("runs a real SQLite task, checks code, supports follow-up, and applies changes once", async () => {
  const f = fixture();
  const archive = Buffer.alloc(1024 * 1024 + 1);
  writeFileSync(join(f.project, "evidence.tar.gz"), archive);
  execFileSync("git", ["-C", f.project, "add", "evidence.tar.gz"]);
  const app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    await app.initialize();
    expect(() => openInstance(f.home)).toThrow("Web Host");
    const project = app.addProject({
      path: f.project,
      testCommand: [process.execPath, "check.mjs"],
    });
    const request = input(project.id);
    const receipt = app.submit(request);
    expect(app.submit(request)).toEqual(receipt);
    expect(() => app.submit({ ...request, goal: "other" })).toThrow("不同内容");
    await waitFor(() => app.detail(receipt.runId).run?.state === "succeeded");
    expect(readFileSync(join(f.project, "math.mjs"), "utf8")).toContain("a-b");
    const work = app.work(receipt.runId);
    expect(work.result?.checks.tested).toBe(true);
    expect(work.result?.checks.passed).toBe(true);
    expect(work.result?.changes).toHaveLength(1);
    expect(work.baseline).toHaveProperty("evidence.tar.gz");
    const follow = app.submit({
      ...input(project.id, "READ 检查修复结果"),
      mode: "read",
      parentId: receipt.runId,
    });
    await waitFor(() =>
      ["failed", "succeeded"].includes(app.detail(follow.runId).run?.state ?? ""),
    );
    const child = app.work(follow.runId);
    expect(child.conversationId).toBe(work.conversationId);
    expect(child.turnId).not.toBe(work.turnId);
    expect(app.conversations()).toHaveLength(1);
    expect(app.conversations()[0]?.turns).toHaveLength(2);
    expect(app.conversations()[0]?.turns[1]?.parentTurnId).toBe(work.turnId);
    const applied = app.apply(receipt.runId);
    expect(app.apply(receipt.runId)).toEqual(applied);
    expect(readFileSync(join(f.project, "math.mjs"), "utf8")).toContain("a+b");
    expect(readFileSync(join(f.project, "evidence.tar.gz")).equals(archive)).toBe(true);
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
it("rejects stale application and keeps permissions and cancellation explicit", async () => {
  const f = fixture();
  const app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    const p = app.addProject({ path: f.project, testCommand: [process.execPath, "check.mjs"] });
    const { runId } = app.submit(input(p.id, "ASK 修复"));
    const pending = await waitFor(() => app.interactions().find((i) => i.state === "pending"));
    app.reply(pending.id, "allow_once");
    await waitFor(() => app.detail(runId).run?.state === "succeeded");
    writeFileSync(join(f.project, "math.mjs"), "user change");
    expect(() => app.apply(runId)).toThrow("项目已变化");
    expect(readFileSync(join(f.project, "math.mjs"), "utf8")).toBe("user change");
    const slow = app.submit(input(p.id, "SLOW"));
    await waitFor(() => app.detail(slow.runId).run?.state === "running");
    await app.cancel(slow.runId);
    await waitFor(() => app.detail(slow.runId).run?.state === "cancelled");
    expect(() => app.reply(pending.id, "allow_once")).toThrow("失效");
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
it("serves authenticated HTTP and durable snapshots", async () => {
  const f = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const server = startWorkbench(0, f.home, { executorFactory: factory });
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    const token = String(log.mock.calls.at(-1)?.[0]).split("#")[1];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await fetch(base + "/api/projects")).status).toBe(401);
    expect(
      (
        await fetch(base + "/api/projects", {
          headers: { ...headers, origin: "https://example.com" },
        })
      ).status,
    ).toBe(403);
    const session = await fetch(base + "/api/session", { method: "POST", headers });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-cookie")).toContain("HttpOnly");
    const project = (await (
      await fetch(base + "/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ path: f.project }),
      })
    ).json()) as { id: string };
    const submitted = await fetch(base + "/api/runs", {
      method: "POST",
      headers,
      body: JSON.stringify(input(project.id)),
    });
    expect(submitted.status).toBe(202);
    const receipt = (await submitted.json()) as { runId: string };
    await waitFor(() => server.workbench.detail(receipt.runId).run?.state === "succeeded");
    const controller = new AbortController();
    const response = await fetch(base + "/api/watch", { headers, signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const first = await response.body!.getReader().read();
    const snapshot = new TextDecoder().decode(first.value);
    expect(snapshot).toContain("snapshot");
    const cursor = snapshot.match(/id: (.+)/)?.[1];
    expect(cursor).toBeTruthy();
    controller.abort();
    const follow = server.workbench.submit({
      ...input(project.id, "READ follow"),
      mode: "read",
      parentId: receipt.runId,
    });
    await waitFor(() => server.workbench.detail(follow.runId).run?.state === "succeeded");
    const reconnect = new AbortController();
    try {
      const resumed = await fetch(base + "/api/watch", {
        headers: { ...headers, "Last-Event-ID": cursor! },
        signal: reconnect.signal,
      });
      const next = await resumed.body!.getReader().read();
      const frame = new TextDecoder().decode(next.value);
      expect(frame).toContain("event: delta");
      expect(frame).toContain(cursor);
    } finally {
      reconnect.abort();
    }
  } finally {
    await server.shutdown();
    log.mockRestore();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("retains operation receipts and results across host restart", async () => {
  const f = fixture();
  let app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    const project = app.addProject({ path: f.project });
    const request = input(project.id);
    const receipt = app.submit(request);
    await waitFor(() => app.detail(receipt.runId).run?.state === "succeeded");
    await app.close();
    app = new Workbench({ home: f.home, executorFactory: factory });
    await app.initialize();
    expect(app.submit(request)).toEqual(receipt);
    expect(app.works()).toHaveLength(1);
    expect(app.work(receipt.runId).result?.summary).toContain("已完成");
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("rejects permission requests without writing and rejects readonly edits", async () => {
  const f = fixture();
  const app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    const project = app.addProject({ path: f.project });
    const receipt = app.submit(input(project.id, "ASK 拒绝场景"));
    const pending = await waitFor(() => app.interactions().find((i) => i.state === "pending"));
    app.reply(pending.id, "reject_once");
    await waitFor(() => app.detail(receipt.runId).run?.state === "failed");
    expect(() => app.apply(receipt.runId)).toThrow("通过验收");
    const readonly = app.submit({ ...input(project.id), mode: "read" });
    await waitFor(() => app.detail(readonly.runId).run?.state === "failed");
    expect(readFileSync(join(f.project, "math.mjs"), "utf8")).toContain("a-b");
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("fails a task when independent checks fail, and refuses to apply it", async () => {
  const f = fixture();
  const app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    const project = app.addProject({
      path: f.project,
      testCommand: [process.execPath, "-e", "process.exit(1)"],
    });
    const receipt = app.submit(input(project.id));
    await waitFor(() => app.detail(receipt.runId).run?.state === "failed");
    expect(app.work(receipt.runId).result?.checks.passed).toBe(false);
    expect(() => app.apply(receipt.runId)).toThrow("通过验收");
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("exposes existing learning records and rejects stale or conflicting governance operations", async () => {
  const f = fixture();
  const app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    const project = app.addProject({ path: f.project });
    const receipt = app.submit(input(project.id));
    await waitFor(() => app.detail(receipt.runId).run?.state === "succeeded");
    const revision = app.governance().organism!.revision;
    await expect(
      app.govern({
        action: "freeze",
        expectedRevision: revision + 1,
        requestId: "stale-operation",
      }),
    ).rejects.toThrow("版本已变化");
    const request = { action: "freeze", expectedRevision: revision, requestId: "freeze-operation" };
    const first = await app.govern(request);
    expect(await app.govern(request)).toEqual(first);
    expect(app.governance().datasets.length).toBeGreaterThan(0);
    await expect(app.govern({ ...request, action: "promote", target: "missing" })).rejects.toThrow(
      "其他内容",
    );
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("keeps browser sessions independent across local instance ports", async () => {
  const first = fixture();
  const second = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const servers = [
    startWorkbench(0, first.home, { executorFactory: factory }),
    startWorkbench(0, second.home, { executorFactory: factory }),
  ];
  try {
    await Promise.all(servers.map((server) => once(server, "listening")));
    const urls = log.mock.calls
      .map((call) => String(call[0]).match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/)?.[0])
      .filter((url): url is string => !!url);
    expect(urls).toHaveLength(2);
    const cookies: string[] = [];
    for (const url of urls) {
      const [base, token] = url.split("/#");
      const response = await fetch(base + "/api/session", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      cookies.push(response.headers.get("set-cookie")!.split(";")[0]!);
    }
    expect(cookies[0]!.split("=")[0]).not.toEqual(cookies[1]!.split("=")[0]);
    for (const url of urls) {
      const response = await fetch(url.split("/#")[0] + "/api/settings", {
        headers: { cookie: cookies.join("; ") },
      });
      expect(response.status).toBe(200);
    }
  } finally {
    await Promise.all(servers.map((server) => server.shutdown()));
    log.mockRestore();
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

it("persists ACP tool events, progress, accounting and conversation context for Web reads", async () => {
  const { AcpExecutor } = await import("../../src/adapters/executor-acp/index.ts");
  const { fileURLToPath } = await import("node:url");
  const f = fixture();
  const options = {
    home: f.home,
    executorFactory: (
      _name: string,
      permission: import("../../src/adapters/executor-acp/index.ts").AcpPermissionPolicy,
    ) =>
      new AcpExecutor({
        name: "fixture-claude",
        agentEntry: fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url)),
        captureClaudeUsage: true,
        permissionPolicy: permission,
      }),
  };
  let app = new Workbench(options);
  try {
    const project = app.addProject({ path: f.project });
    const receipt = app.submit(input(project.id, "ACCOUNTING-MODE"));
    await waitFor(() => app.detail(receipt.runId).run?.state === "succeeded");
    const detail = app.detail(receipt.runId);
    expect(detail.evidence?.accounting).toMatchObject({
      tokenStatus: "complete",
      totals: { totalTokens: 100 },
      observedModelResponses: 1,
    });
    expect(detail.activity.filter((event) => event.kind === "tool")).toHaveLength(2);
    expect(detail.activity.find((event) => event.kind === "tool")?.data?.toolCallId).toBe(
      "late-tool",
    );
    expect(detail.activity.filter((event) => event.kind === "message").length).toBeLessThan(10);
    expect(detail.progress?.toolCalls).toBe(1);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE-SDK-CONTENT");
    expect(app.list()[0]?.evidence).toBeUndefined();
    await app.close();
    app = new Workbench(options);
    expect(app.detail(receipt.runId).evidence?.accounting?.totals?.totalTokens).toBe(100);
    expect(app.detail(receipt.runId).conversation.turns[0]?.goal).toBe("ACCOUNTING-MODE");
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("migrates legacy task ancestry deterministically across restarts", async () => {
  const f = fixture();
  let app = new Workbench({ home: f.home, executorFactory: factory });
  try {
    const project = app.addProject({ path: f.project });
    const first = app.submit(input(project.id));
    await waitFor(() => app.detail(first.runId).run?.state === "succeeded");
    const second = app.submit({
      ...input(project.id, "READ"),
      mode: "read",
      parentId: first.runId,
    });
    await waitFor(() => app.detail(second.runId).run?.state === "succeeded");
    app.instance.storage.tx(() => {
      for (const work of app.works()) {
        const { conversationId: _conversation, turnId: _turn, ...legacy } = work;
        app.instance.storage.workbenchPut("work", work.id, legacy);
      }
    });
    await app.close();
    app = new Workbench({ home: f.home, executorFactory: factory });
    const migrated = app.work(second.runId);
    expect(migrated.conversationId).toBe(`conversation-${first.runId}`);
    expect(app.work(first.runId).conversationId).toBe(migrated.conversationId);
    expect(app.conversation(second.runId).turns).toHaveLength(2);
    await app.close();
    app = new Workbench({ home: f.home, executorFactory: factory });
    expect(app.work(second.runId).turnId).toBe(migrated.turnId);
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("executes with binary inputs and applies binary changes without losing file bytes", async () => {
  const f = fixture();
  writeFileSync(join(f.project, "fixture.bin"), Buffer.from([0, 255, 1]));
  const binaryFactory: WorkbenchOptions["executorFactory"] = (name, permission) => {
    const executor = factory!(name, permission);
    return {
      ...executor,
      async start(req) {
        expect(readFileSync(join(req.workspaceDir, "fixture.bin"))).toEqual(
          Buffer.from([0, 255, 1]),
        );
        const result = await executor.start(req);
        writeFileSync(join(req.workspaceDir, "fixture.bin"), Buffer.from([0, 128, 2]));
        return result;
      },
    };
  };
  const app = new Workbench({ home: f.home, executorFactory: binaryFactory });
  try {
    const project = app.addProject({
      path: f.project,
      testCommand: [process.execPath, "check.mjs"],
    });
    const receipt = app.submit(input(project.id));
    await waitFor(() => app.detail(receipt.runId).run?.state === "succeeded");
    expect(
      app.work(receipt.runId).result!.changes.find((c) => c.path === "fixture.bin")!.afterFile,
    ).toBeDefined();
    app.apply(receipt.runId);
    expect(readFileSync(join(f.project, "fixture.bin"))).toEqual(Buffer.from([0, 128, 2]));
  } finally {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
