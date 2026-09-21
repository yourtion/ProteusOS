import { createHash } from "node:crypto";
import type {
  Artifact,
  ArtifactVersion,
  GenomeSnapshot,
  Lineage,
  Organism,
  Principal,
  PrincipalKind,
  PromotionKind,
  PromotionRecord,
} from "./types.ts";

/** Kernel 持久化 port；由 storage 实现。Kernel 自身不触碰数据库或 SDK。 */
export interface KernelStore {
  insertPrincipal(p: Principal): void;
  getPrincipal(id: string): Principal | undefined;
  insertOrganism(o: Organism): void;
  getOrganism(id: string): Organism | undefined;
  insertLineage(l: Lineage): void;
  insertArtifact(a: Artifact): void;
  getArtifact(id: string): Artifact | undefined;
  insertArtifactVersion(v: ArtifactVersion): "inserted" | "exists";
  getArtifactVersion(id: string): ArtifactVersion | undefined;
  findArtifactVersionByDigest(artifactId: string, digest: string): ArtifactVersion | undefined;
  insertSnapshot(s: GenomeSnapshot): "inserted" | "exists";
  findSnapshotByDigest(digest: string): GenomeSnapshot | undefined;
  getSnapshot(id: string): GenomeSnapshot | undefined;
  /** 条件更新 active 指针；revision 不匹配返回 conflict，绝不静默覆盖 */
  setActiveGenome(
    organismId: string,
    snapshotId: string,
    expectedRevision: number,
  ): { ok: true; revision: number } | { ok: false; reason: "conflict" };
  insertPromotion(p: PromotionRecord): void;
  getPromotionByOperationId(operationId: string): PromotionRecord | undefined;
}

export interface Clock {
  now(): number;
}

export interface IdGen {
  next(): string;
}

export interface RegisterVersionInput {
  artifact: Artifact;
  schemaVersion: number;
  contentDigest: string;
  contentRef: string;
  parents: string[];
  dependencies: string[];
  createdBy: string;
}

export class KernelError extends Error {
  readonly code:
    | "unknown_artifact"
    | "unknown_parent"
    | "cycle_detected"
    | "unknown_version"
    | "slot_mismatch"
    | "missing_binding"
    | "duplicate_slot"
    | "unknown_organism"
    | "unknown_principal"
    | "promotion_target_unresolvable";

  constructor(code: KernelError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Kernel：身份、不可变版本、快照完整性与 active 指针的条件更新。
 * 它只返回领域结果；事件记录由调用方（app/runtime）在同一事务中追加。
 */
export class Kernel {
  private readonly store: KernelStore;
  private readonly clock: Clock;
  private readonly ids: IdGen;

  constructor(store: KernelStore, clock: Clock, ids: IdGen) {
    this.store = store;
    this.clock = clock;
    this.ids = ids;
  }

  createPrincipal(id: string, kind: PrincipalKind): Principal {
    const existing = this.store.getPrincipal(id);
    if (existing) return existing;
    const p: Principal = { id, kind, createdAt: this.clock.now() };
    this.store.insertPrincipal(p);
    return p;
  }

  createOrganism(id: string, ownerId: string, scope: string): Organism {
    const existing = this.store.getOrganism(id);
    if (existing) return existing;
    const o: Organism = {
      id,
      ownerId,
      scope,
      activeGenomeId: null,
      revision: 0,
      createdAt: this.clock.now(),
    };
    this.store.insertOrganism(o);
    return o;
  }

  createLineage(id: string, ownerId: string, scope: string): Lineage {
    const l: Lineage = { id, ownerId, scope, createdAt: this.clock.now() };
    this.store.insertLineage(l);
    return l;
  }

  /**
   * 注册不可变版本。相同内容（同 artifact 同 digest）幂等返回既有版本；
   * parents 必须存在且不能形成环。
   */
  registerVersion(input: RegisterVersionInput): ArtifactVersion {
    const artifact = this.store.getArtifact(input.artifact.id);
    if (!artifact)
      throw new KernelError("unknown_artifact", `artifact ${input.artifact.id} 不存在`);

    const existing = this.store.findArtifactVersionByDigest(artifact.id, input.contentDigest);
    if (existing) return existing;

    for (const parentId of input.parents) {
      if (!this.store.getArtifactVersion(parentId)) {
        throw new KernelError("unknown_parent", `parent ${parentId} 不存在`);
      }
    }
    this.assertNoCycle(input.parents);

    const version: ArtifactVersion = {
      id: this.ids.next(),
      artifactId: artifact.id,
      lineageId: artifact.lineageId,
      schemaVersion: input.schemaVersion,
      contentDigest: input.contentDigest,
      contentRef: input.contentRef,
      parents: [...input.parents],
      dependencies: [...input.dependencies],
      createdBy: input.createdBy,
      createdAt: this.clock.now(),
    };
    this.store.insertArtifactVersion(version);
    return version;
  }

  private assertNoCycle(parents: string[]): void {
    for (const start of parents) {
      const visited = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const v = this.store.getArtifactVersion(id);
        if (!v) continue;
        for (const p of v.parents) {
          if (p === start) throw new KernelError("cycle_detected", `parents 形成环，回到 ${start}`);
          stack.push(p);
        }
      }
    }
  }

  /**
   * 创建不可变 GenomeSnapshot：每个槽位绑定的版本必须存在、artifact.kind 与槽位一致、
   * 同一 artifact 不能占多个槽位。相同 bindings 闭包幂等返回同一快照。
   */
  createSnapshot(bindings: Record<string, string>, createdBy: string): GenomeSnapshot {
    const slots = Object.keys(bindings);
    if (slots.length === 0) throw new KernelError("missing_binding", "快照至少绑定一个槽位");

    const resolved: Array<{ slot: string; version: ArtifactVersion }> = [];
    const seenArtifacts = new Set<string>();
    for (const slot of slots) {
      const version = this.store.getArtifactVersion(bindings[slot]!);
      if (!version) throw new KernelError("unknown_version", `槽位 ${slot} 引用的版本不存在`);
      const artifact = this.store.getArtifact(version.artifactId);
      if (!artifact)
        throw new KernelError("unknown_artifact", `版本 ${version.id} 的 artifact 不存在`);
      if (artifact.kind !== slot) {
        throw new KernelError(
          "slot_mismatch",
          `槽位 ${slot} 需要 kind=${slot} 的产物，实际绑定 ${artifact.id}（kind=${artifact.kind}）`,
        );
      }
      if (seenArtifacts.has(artifact.id)) {
        throw new KernelError("duplicate_slot", `artifact ${artifact.id} 被多个槽位绑定`);
      }
      seenArtifacts.add(artifact.id);
      resolved.push({ slot, version });
    }

    const digest = snapshotDigest(resolved);
    const existing = this.store.findSnapshotByDigest(digest);
    if (existing) return existing;

    const snapshot: GenomeSnapshot = {
      id: this.ids.next(),
      digest,
      bindings: { ...bindings },
      createdBy,
      createdAt: this.clock.now(),
    };
    this.store.insertSnapshot(snapshot);
    return snapshot;
  }

  getOrganism(id: string): Organism | undefined {
    return this.store.getOrganism(id);
  }

  getPrincipal(id: string): Principal | undefined {
    return this.store.getPrincipal(id);
  }

  getSnapshot(id: string): GenomeSnapshot | undefined {
    return this.store.getSnapshot(id);
  }

  /** 解析快照闭包：slot -> 精确版本，供 Run 创建时固定 */
  resolveSnapshot(id: string): {
    snapshot: GenomeSnapshot;
    versions: Map<string, ArtifactVersion>;
  } {
    const snapshot = this.store.getSnapshot(id);
    if (!snapshot) throw new KernelError("unknown_version", `快照 ${id} 不存在`);
    const versions = new Map<string, ArtifactVersion>();
    for (const [slot, versionId] of Object.entries(snapshot.bindings)) {
      const version = this.store.getArtifactVersion(versionId);
      if (!version) {
        throw new KernelError(
          "unknown_version",
          `快照 ${id} 槽位 ${slot} 引用的版本 ${versionId} 缺失`,
        );
      }
      versions.set(slot, version);
    }
    return { snapshot, versions };
  }

  /** 安装为默认快照：仅当 revision 仍等于 expectedRevision 时原子切换 */
  installAsActive(
    organismId: string,
    snapshotId: string,
    expectedRevision: number,
  ): { ok: true; revision: number } | { ok: false; reason: "conflict" } {
    return this.store.setActiveGenome(organismId, snapshotId, expectedRevision);
  }

  /**
   * 晋升（M2）：一次验证快照可解析、授权者存在与 revision，再交由同事务的
   * CAS 与成功记录原子提交（docs/repository.md：调用者不手动串起可漏掉的步骤）。
   * - operationId 已存在 → already：幂等读回同一结果，不重复增加 revision
   * - CAS 冲突 → stale：不落记录，调用方据此重构候选重评
   * 事件记录由调用方（evolution）在同一事务内追加。
   * 必须在 Storage.tx 内调用。
   */
  promote(input: {
    organismId: string;
    kind: PromotionKind;
    toSnapshotId: string;
    expectedRevision: number;
    operationId: string;
    authorizedBy: string;
    evaluationRef?: string | null;
    authorizationRef?: string | null;
    note?: string | null;
  }):
    | { result: "promoted"; promotion: PromotionRecord }
    | { result: "already"; promotion: PromotionRecord }
    | { result: "stale"; currentRevision: number } {
    const existing = this.store.getPromotionByOperationId(input.operationId);
    if (existing) return { result: "already", promotion: existing };

    const organism = this.store.getOrganism(input.organismId);
    if (!organism) {
      throw new KernelError("unknown_organism", `organism ${input.organismId} 不存在`);
    }
    // 目标快照必须可解析完整依赖闭包（不能回滚/晋升到依赖缺失的组合）
    try {
      this.resolveSnapshot(input.toSnapshotId);
    } catch (err) {
      throw new KernelError(
        "promotion_target_unresolvable",
        `目标快照 ${input.toSnapshotId} 不可解析：${String(err)}`,
      );
    }
    if (!this.store.getPrincipal(input.authorizedBy)) {
      throw new KernelError("unknown_principal", `授权者 ${input.authorizedBy} 不存在`);
    }

    const fromSnapshotId = organism.activeGenomeId ?? "";
    const cas = this.store.setActiveGenome(
      input.organismId,
      input.toSnapshotId,
      input.expectedRevision,
    );
    if (!cas.ok) {
      return { result: "stale", currentRevision: organism.revision };
    }
    const promotion: PromotionRecord = {
      id: this.ids.next(),
      operationId: input.operationId,
      kind: input.kind,
      organismId: input.organismId,
      fromSnapshotId,
      toSnapshotId: input.toSnapshotId,
      expectedRevision: input.expectedRevision,
      resultRevision: cas.revision,
      evaluationRef: input.evaluationRef ?? null,
      authorizationRef: input.authorizationRef ?? null,
      actor: input.authorizedBy,
      note: input.note ?? null,
      createdAt: this.clock.now(),
    };
    this.store.insertPromotion(promotion);
    return { result: "promoted", promotion };
  }
}

/**
 * 快照摘要：对排序后的 slot -> contentDigest 闭包做 sha256。
 * 纯内容寻址、不含实例特定的 versionId——同一 seed 内容在任何实例
 * 产生同一摘要，这是"人工安装 seed 快照可重复"的实质保证。
 */
export function snapshotDigest(
  resolved: Array<{ slot: string; version: Pick<ArtifactVersion, "contentDigest"> }>,
): string {
  const canonical: Record<string, string> = {};
  for (const { slot, version } of resolved) {
    canonical[slot] = version.contentDigest;
  }
  const sorted = Object.keys(canonical)
    .sort()
    .map((slot) => `${slot}\n${canonical[slot]}`)
    .join("\n---\n");
  return createHash("sha256").update(sorted).digest("hex");
}

export type {
  Artifact,
  ArtifactVersion,
  GenomeSnapshot,
  Lineage,
  Organism,
  Principal,
  PromotionKind,
  PromotionRecord,
} from "./types.ts";
