import { describe, expect, it } from "vitest";
import { Kernel, KernelError } from "../../src/kernel/index.ts";
import { MIGRATIONS } from "../../src/storage/migrations.ts";
import { SqliteDb } from "../../src/storage/sqlite.ts";
import { Storage } from "../../src/storage/store.ts";

function boot() {
  const db = new SqliteDb(":memory:");
  db.migrate(MIGRATIONS);
  const storage = new Storage(db);
  let n = 0;
  const kernel = new Kernel(
    storage,
    { now: () => 1_000 },
    { next: () => `id-${String(++n).padStart(3, "0")}` },
  );
  storage.insertPrincipal({ id: "p1", kind: "user", createdAt: 0 });
  storage.insertLineage({ id: "l1", ownerId: "p1", scope: "organism:o1", createdAt: 0 });
  storage.insertOrganism({
    id: "o1",
    ownerId: "p1",
    scope: "organism:o1",
    activeGenomeId: null,
    revision: 0,
    createdAt: 0,
  });
  return { kernel, storage };
}

function makeArtifact(storage: Storage, id: string, kind: string) {
  storage.insertArtifact({ id, kind, lineageId: "l1", ownerId: "p1", createdAt: 0 });
  return storage.getArtifact(id)!;
}

describe("kernel：不可变版本", () => {
  it("同 artifact 同内容摘要幂等去重", () => {
    const { kernel, storage } = boot();
    const artifact = makeArtifact(storage, "stats-graph", "task-graph");
    const v1 = kernel.registerVersion({
      artifact,
      schemaVersion: 1,
      contentDigest: "d1",
      contentRef: "aa/d1",
      parents: [],
      dependencies: [],
      createdBy: "p1",
    });
    const v2 = kernel.registerVersion({
      artifact,
      schemaVersion: 1,
      contentDigest: "d1",
      contentRef: "aa/d1",
      parents: [],
      dependencies: [],
      createdBy: "p1",
    });
    expect(v2.id).toBe(v1.id);
  });

  it("不同摘要是新版本，parents 记录继承", () => {
    const { kernel, storage } = boot();
    const artifact = makeArtifact(storage, "stats-graph", "task-graph");
    const v1 = kernel.registerVersion({
      artifact,
      schemaVersion: 1,
      contentDigest: "d1",
      contentRef: "aa/d1",
      parents: [],
      dependencies: [],
      createdBy: "p1",
    });
    const v2 = kernel.registerVersion({
      artifact,
      schemaVersion: 1,
      contentDigest: "d2",
      contentRef: "bb/d2",
      parents: [v1.id],
      dependencies: [],
      createdBy: "p1",
    });
    expect(v2.parents).toEqual([v1.id]);
  });

  it("不存在的 parent 拒绝注册", () => {
    const { kernel, storage } = boot();
    const artifact = makeArtifact(storage, "stats-graph", "task-graph");
    expect(() =>
      kernel.registerVersion({
        artifact,
        schemaVersion: 1,
        contentDigest: "d9",
        contentRef: "aa/d9",
        parents: ["ghost"],
        dependencies: [],
        createdBy: "p1",
      }),
    ).toThrowError(KernelError);
  });
});

describe("kernel：GenomeSnapshot", () => {
  function seedThreeVersions(kernel: Kernel, storage: Storage) {
    const defs = [
      { id: "stats-graph", kind: "task-graph", digest: "dg1" },
      { id: "stats-rule", kind: "routing-policy", digest: "dg2" },
      { id: "stats-acceptance", kind: "acceptance-evaluator", digest: "dg3" },
    ];
    const ids: Record<string, string> = {};
    for (const def of defs) {
      const artifact = makeArtifact(storage, def.id, def.kind);
      const v = kernel.registerVersion({
        artifact,
        schemaVersion: 1,
        contentDigest: def.digest,
        contentRef: `x/${def.digest}`,
        parents: [],
        dependencies: [],
        createdBy: "p1",
      });
      ids[def.kind] = v.id;
    }
    return ids;
  }

  it("槽位 kind 必须匹配，错位绑定拒绝", () => {
    const { kernel, storage } = boot();
    const ids = seedThreeVersions(kernel, storage);
    expect(() =>
      kernel.createSnapshot({ "task-graph": ids["routing-policy"]! }, "p1"),
    ).toThrowError(KernelError);
  });

  it("空绑定拒绝", () => {
    const { kernel } = boot();
    expect(() => kernel.createSnapshot({}, "p1")).toThrowError(KernelError);
  });

  it("同闭包幂等返回同一快照", () => {
    const { kernel, storage } = boot();
    const ids = seedThreeVersions(kernel, storage);
    const s1 = kernel.createSnapshot({ ...ids }, "p1");
    const s2 = kernel.createSnapshot({ ...ids }, "p1");
    expect(s2.id).toBe(s1.id);
  });

  it("resolveSnapshot 返回槽位到精确版本的闭包", () => {
    const { kernel, storage } = boot();
    const ids = seedThreeVersions(kernel, storage);
    const snapshot = kernel.createSnapshot({ ...ids }, "p1");
    const { versions } = kernel.resolveSnapshot(snapshot.id);
    expect(versions.get("task-graph")!.id).toBe(ids["task-graph"]);
    expect(versions.get("acceptance-evaluator")!.contentDigest).toBe("dg3");
  });
});

describe("kernel：active 指针条件更新", () => {
  it("revision 匹配时原子切换，过期请求返回 conflict", () => {
    const { kernel, storage } = boot();
    const artifact = makeArtifact(storage, "stats-graph", "task-graph");
    const v1 = kernel.registerVersion({
      artifact,
      schemaVersion: 1,
      contentDigest: "d1",
      contentRef: "aa/d1",
      parents: [],
      dependencies: [],
      createdBy: "p1",
    });
    const v2 = kernel.registerVersion({
      artifact,
      schemaVersion: 1,
      contentDigest: "d2",
      contentRef: "bb/d2",
      parents: [v1.id],
      dependencies: [],
      createdBy: "p1",
    });
    const s1 = kernel.createSnapshot({ "task-graph": v1.id }, "p1");
    const s2 = kernel.createSnapshot({ "task-graph": v2.id }, "p1");

    const first = kernel.installAsActive("o1", s1.id, 0);
    expect(first).toEqual({ ok: true, revision: 1 });
    // 基于过期 revision 的并发请求必须 stale，不能静默覆盖
    const stale = kernel.installAsActive("o1", s2.id, 0);
    expect(stale).toEqual({ ok: false, reason: "conflict" });
    expect(storage.getOrganism("o1")!.activeGenomeId).toBe(s1.id);

    const second = kernel.installAsActive("o1", s2.id, 1);
    expect(second).toEqual({ ok: true, revision: 2 });
    expect(storage.getOrganism("o1")!.activeGenomeId).toBe(s2.id);
  });
});
