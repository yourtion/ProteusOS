import { describe, expect, it } from "vitest";
import { Kernel, KernelError } from "../../src/kernel/index.ts";
import type { GenomeSnapshot } from "../../src/kernel/index.ts";
import { MIGRATIONS } from "../../src/storage/migrations.ts";
import { SqliteDb } from "../../src/storage/sqlite.ts";
import { Storage } from "../../src/storage/store.ts";

/**
 * M2 切片④：Kernel.promote 单测（CAS 原语之上的晋升语义）。
 * - 成功：指针切换 + revision 递增 + 成功记录同事务落库
 * - 幂等：同 operationId 重试读回同一结果，revision 不再增加（响应丢失场景）
 * - stale：基准过期不落记录、指针不被覆盖
 * - 授权与目标校验：未知 principal / 不可解析快照拒绝
 */

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

function makeSnapshot(kernel: Kernel, storage: Storage, name: string): GenomeSnapshot {
  storage.insertArtifact({
    id: `a-${name}`,
    kind: "task-graph",
    lineageId: "l1",
    ownerId: "p1",
    createdAt: 0,
  });
  const artifact = storage.getArtifact(`a-${name}`)!;
  const version = kernel.registerVersion({
    artifact,
    schemaVersion: 1,
    contentDigest: `digest-${name}`,
    contentRef: `aa/digest-${name}`,
    parents: [],
    dependencies: [],
    createdBy: "p1",
  });
  return kernel.createSnapshot({ "task-graph": version.id }, "p1");
}

describe("kernel.promote：CAS 晋升语义", () => {
  it("成功晋升：指针切换 + revision 递增 + 成功记录", () => {
    const { kernel, storage } = boot();
    const s0 = makeSnapshot(kernel, storage, "g0");
    const s1 = makeSnapshot(kernel, storage, "g1");
    storage.tx(() => {
      kernel.installAsActive("o1", s0.id, 0);
    });

    let outcome!: ReturnType<Kernel["promote"]>;
    storage.tx(() => {
      outcome = kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: s1.id,
        expectedRevision: 1,
        operationId: "op-1",
        authorizedBy: "p1",
        evaluationRef: "eval-1",
      });
    });

    expect(outcome.result).toBe("promoted");
    const organism = storage.getOrganism("o1")!;
    expect(organism.activeGenomeId).toBe(s1.id);
    expect(organism.revision).toBe(2);
    expect(outcome).toMatchObject({
      promotion: {
        kind: "adopt",
        fromSnapshotId: s0.id,
        toSnapshotId: s1.id,
        expectedRevision: 1,
        resultRevision: 2,
        evaluationRef: "eval-1",
        actor: "p1",
      },
    });
    expect(storage.getPromotionByOperationId("op-1")!.id).toBe(
      outcome.result === "promoted" || outcome.result === "already"
        ? outcome.promotion.id
        : "unreachable",
    );
  });

  it("operationId 幂等：提交成功但响应丢失后重试，读回同一结果，revision 不再增加", () => {
    const { kernel, storage } = boot();
    const s0 = makeSnapshot(kernel, storage, "g0");
    const s1 = makeSnapshot(kernel, storage, "g1");
    storage.tx(() => {
      kernel.installAsActive("o1", s0.id, 0);
      kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: s1.id,
        expectedRevision: 1,
        operationId: "op-lost",
        authorizedBy: "p1",
      });
    });

    // 响应丢失后重试（revision 已是 2，expectedRevision 仍传 1）：按 operationId 读回
    let retried!: ReturnType<Kernel["promote"]>;
    storage.tx(() => {
      retried = kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: s1.id,
        expectedRevision: 1,
        operationId: "op-lost",
        authorizedBy: "p1",
      });
    });
    expect(retried.result).toBe("already");
    if (retried.result === "stale") throw new Error("unreachable");
    expect(retried.promotion.resultRevision).toBe(2);
    expect(storage.getOrganism("o1")!.revision).toBe(2);
    expect(storage.listPromotions("o1", 10)).toHaveLength(1);
  });

  it("stale：基准过期不落记录、指针不被覆盖（并发候选一胜一 stale）", () => {
    const { kernel, storage } = boot();
    const s0 = makeSnapshot(kernel, storage, "g0");
    const sA = makeSnapshot(kernel, storage, "ga");
    const sB = makeSnapshot(kernel, storage, "gb");
    storage.tx(() => {
      kernel.installAsActive("o1", s0.id, 0);
      // A 基于 revision 1 成功
      kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: sA.id,
        expectedRevision: 1,
        operationId: "op-a",
        authorizedBy: "p1",
      });
    });

    let stale!: ReturnType<Kernel["promote"]>;
    storage.tx(() => {
      // B 仍基于 revision 1 → stale
      stale = kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: sB.id,
        expectedRevision: 1,
        operationId: "op-b",
        authorizedBy: "p1",
      });
    });
    expect(stale).toEqual({ result: "stale", currentRevision: 2 });
    expect(storage.getOrganism("o1")!.activeGenomeId).toBe(sA.id);
    expect(storage.getPromotionByOperationId("op-b")).toBeUndefined();
    expect(storage.listPromotions("o1", 10)).toHaveLength(1);
  });

  it("回滚到相同快照引用后，旧并发晋升请求仍然 stale（revision 不倒退）", () => {
    const { kernel, storage } = boot();
    const s0 = makeSnapshot(kernel, storage, "g0");
    const s1 = makeSnapshot(kernel, storage, "g1");
    storage.tx(() => {
      kernel.installAsActive("o1", s0.id, 0);
      kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: s1.id,
        expectedRevision: 1,
        operationId: "op-1",
        authorizedBy: "p1",
      });
      // 回滚到 G0：revision 3，快照引用与最初相同
      kernel.promote({
        organismId: "o1",
        kind: "rollback",
        toSnapshotId: s0.id,
        expectedRevision: 2,
        operationId: "op-2",
        authorizedBy: "p1",
      });
    });
    expect(storage.getOrganism("o1")!.activeGenomeId).toBe(s0.id);
    expect(storage.getOrganism("o1")!.revision).toBe(3);

    // 基于 revision 1 的旧请求（回滚后快照引用相同）不能意外成功
    let outcome!: ReturnType<Kernel["promote"]>;
    storage.tx(() => {
      outcome = kernel.promote({
        organismId: "o1",
        kind: "adopt",
        toSnapshotId: s1.id,
        expectedRevision: 1,
        operationId: "op-3",
        authorizedBy: "p1",
      });
    });
    expect(outcome.result).toBe("stale");
  });

  it("未知授权者 / 不可解析目标快照拒绝", () => {
    const { kernel, storage } = boot();
    const s0 = makeSnapshot(kernel, storage, "g0");
    storage.tx(() => {
      kernel.installAsActive("o1", s0.id, 0);
    });

    expect(() =>
      storage.tx(() => {
        kernel.promote({
          organismId: "o1",
          kind: "adopt",
          toSnapshotId: s0.id,
          expectedRevision: 1,
          operationId: "op-x",
          authorizedBy: "ghost",
        });
      }),
    ).toThrowError(KernelError);

    // 伪造依赖缺失的快照（bindings 引用不存在版本）
    storage.insertSnapshot({
      id: "broken",
      digest: "broken-digest",
      bindings: { "task-graph": "version-nonexistent" },
      createdBy: "p1",
      createdAt: 0,
    });
    expect(() =>
      storage.tx(() => {
        kernel.promote({
          organismId: "o1",
          kind: "rollback",
          toSnapshotId: "broken",
          expectedRevision: 1,
          operationId: "op-y",
          authorizedBy: "p1",
        });
      }),
    ).toThrowError(/不可解析/);
  });
});
