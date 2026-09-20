import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BlobStore } from "../../src/storage/blobs.ts";
import { MIGRATIONS } from "../../src/storage/migrations.ts";
import { SqliteDb } from "../../src/storage/sqlite.ts";
import { Storage } from "../../src/storage/store.ts";
import { tempInstanceRoot } from "../helpers.ts";

const root = tempInstanceRoot();
const db = new SqliteDb(":memory:");
db.migrate(MIGRATIONS);
const storage = new Storage(db);

afterAll(() => {
  db.close();
});

describe("事件流", () => {
  it("同一 stream 的 seq 单调递增", () => {
    const a = storage.appendEvent({ streamId: "s1", type: "t1", payload: {}, occurredAt: 1 });
    const b = storage.appendEvent({ streamId: "s1", type: "t2", payload: {}, occurredAt: 2 });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("不同 stream 独立计数", () => {
    const a = storage.appendEvent({ streamId: "s2", type: "t", payload: {}, occurredAt: 1 });
    expect(a.seq).toBe(1);
  });

  it("并发覆盖被 UNIQUE(stream_id, seq) 阻止", () => {
    expect(() =>
      db.run(
        `INSERT INTO events (event_id, stream_id, seq, type, schema_version, payload, occurred_at, recorded_at)
         VALUES ('dup', 's1', 1, 't3', 1, '{}', 1, 1)`,
      ),
    ).toThrow();
  });

  it("hasCancelIntent 只认 run.cancel_requested", () => {
    storage.appendEvent({
      streamId: "run-r9",
      type: "run.created",
      payload: {},
      runId: "r9",
      occurredAt: 1,
    });
    expect(storage.hasCancelIntent("r9")).toBe(false);
    storage.appendEvent({
      streamId: "run-r9",
      type: "run.cancel_requested",
      payload: {},
      runId: "r9",
      occurredAt: 2,
    });
    expect(storage.hasCancelIntent("r9")).toBe(true);
  });
});

describe("事务", () => {
  it("tx 内抛错整体回滚", () => {
    expect(() =>
      storage.tx(() => {
        storage.insertArtifact({
          id: "rollback-me",
          kind: "task-graph",
          lineageId: "l",
          ownerId: "p",
          createdAt: 0,
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(storage.getArtifact("rollback-me")).toBeUndefined();
  });

  it("嵌套事务拒绝", () => {
    expect(() => storage.tx(() => storage.tx(() => undefined))).toThrow(/嵌套/);
  });
});

describe("blob 存储", () => {
  const blobs = new BlobStore(join(root, "blobs"), join(root, "tmp"));

  it("写入返回摘要并可读回", () => {
    const content = JSON.stringify({ hello: "proteus" });
    const { digest, ref } = blobs.write(content);
    expect(digest).toHaveLength(64);
    expect(blobs.read(ref)).toBe(content);
  });

  it("相同内容幂等复用", () => {
    const a = blobs.write("same");
    const b = blobs.write("same");
    expect(a).toEqual(b);
  });

  it("摘要与内容一致（sha256）", async () => {
    const { createHash } = await import("node:crypto");
    const content = readFileSync(new URL("../helpers.ts", import.meta.url), "utf8");
    const { digest } = blobs.write(content);
    expect(digest).toBe(createHash("sha256").update(content).digest("hex"));
  });
});
