import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { WatchJournal, type Json } from "../workbench/watch.ts";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Workbench, type WorkbenchOptions } from "../workbench/service.ts";

export function startWorkbench(
  port = 4310,
  home = ".proteus-web",
  options: Partial<WorkbenchOptions> = {},
) {
  const workbench = new Workbench({ ...options, home: resolve(home) });
  const token = randomBytes(24).toString("hex");
  const equal = (value: string | undefined) =>
    !!value &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
  let authority = `127.0.0.1:${port}`;
  const sessionCookie = () => `proteus_session_${authority.split(":").at(-1)}`;
  const app = new Hono();
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.header("host") !== authority) return c.json({ error: "host_denied" }, 403);
    const origin = c.req.header("origin");
    if (
      (origin && origin !== `http://${authority}`) ||
      c.req.header("sec-fetch-site") === "cross-site"
    )
      return c.json({ error: "origin_denied" }, 403);
    if (c.req.path === "/api/session" && c.req.method === "POST") {
      if (!equal(c.req.header("authorization")?.replace(/^Bearer /, "")))
        return c.json({ error: "unauthorized" }, 401);
      setCookie(c, sessionCookie(), token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        maxAge: 86400,
      });
      return c.json({ ok: true });
    }
    if (
      !equal(getCookie(c, sessionCookie())) &&
      !equal(c.req.header("authorization")?.replace(/^Bearer /, ""))
    )
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, 400));
  app.get("/api/governance", (c) => c.json(workbench.governance()));
  app.post("/api/governance", async (c) => c.json(await workbench.govern(await c.req.json())));
  app.get("/api/settings", (c) => c.json(workbench.settings()));
  app.get("/api/projects", (c) => c.json(workbench.projects()));
  app.post("/api/projects", async (c) => c.json(workbench.addProject(await c.req.json()), 201));
  app.get("/api/conversations", (c) => c.json(workbench.conversations()));
  app.get("/api/runs", (c) => c.json(workbench.list()));
  app.post("/api/runs", async (c) => c.json(workbench.submit(await c.req.json()), 202));
  app.get("/api/runs/:id", (c) => c.json(workbench.detail(c.req.param("id"))));
  app.post("/api/runs/:id/cancel", async (c) => c.json(await workbench.cancel(c.req.param("id"))));
  app.post("/api/runs/:id/reconcile", async (c) =>
    c.json(await workbench.reconcile(c.req.param("id"))),
  );
  app.post("/api/runs/:id/apply", (c) => c.json(workbench.apply(c.req.param("id"))));
  app.post("/api/interactions/:id/reply", async (c) => {
    const body = await c.req.json();
    if (typeof body.choice !== "string") throw new Error("缺少审批选项");
    return c.json(workbench.reply(c.req.param("id"), body.choice));
  });
  app.post("/api/runs/:id/restore-application", (c) =>
    c.json(workbench.restoreApplication(c.req.param("id"))),
  );
  app.get("/api/runs/:id/export", (c) => {
    const detail = workbench.detail(c.req.param("id"));
    c.header("Content-Disposition", `attachment; filename="proteus-${detail.id}.json"`);
    return c.json(detail);
  });
  const journals = new Map<string, WatchJournal>();
  app.get("/api/watch", (c) => {
    const runId = c.req.query("runId");
    if (runId) workbench.work(runId);
    const key = runId ?? "";
    let journal = journals.get(key);
    if (!journal) {
      journal = new WatchJournal(randomUUID());
      journals.set(key, journal);
      if (journals.size > 16) journals.delete(journals.keys().next().value!);
    }
    const selectedJournal = journal;
    return streamSSE(c, async (stream) => {
      let cursor = c.req.header("Last-Event-ID");
      let heartbeatAt = Date.now();
      while (!stream.aborted) {
        const state = JSON.parse(
          JSON.stringify({
            runs: workbench.list(),
            detail: runId ? workbench.detail(runId) : null,
          }),
        ) as Json;
        for (const frame of selectedJournal.read(state, cursor)) {
          await stream.writeSSE(frame);
          cursor = frame.id;
        }
        if (Date.now() - heartbeatAt >= 15000) {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
          heartbeatAt = Date.now();
        }
        await stream.sleep(250);
      }
    });
  });
  const root = fileURLToPath(new URL("../../../web/dist", import.meta.url));
  app.use("/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/*", serveStatic({ root }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
    authority = `127.0.0.1:${info.port}`;
    console.log(`Proteus 工作台：http://${authority}/#${token}`);
  });
  let shutdown: Promise<void> | undefined;
  const close = () =>
    (shutdown ??= (async () => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await workbench.close();
      await new Promise<void>((done) => server.close(() => done()));
    })());
  server.on("error", () => {
    void workbench.close();
  });
  void workbench.initialize();
  return Object.assign(server, { workbench, shutdown: close });
}
