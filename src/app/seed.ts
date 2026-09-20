import type { Clock, Kernel } from "../kernel/index.ts";
import { snapshotDigest } from "../kernel/index.ts";
import type { BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";

/** M0 seed：固定身份、三个产物版本与首个 GenomeSnapshot（G0）。 */

export const PRINCIPAL_ID = "principal-local";
export const ORGANISM_ID = "organism-default";
export const LINEAGE_ID = "lineage-seed";

const GRAPH_CONTENT = {
  schemaVersion: 2,
  kind: "dag-v1",
  nodes: [
    {
      id: "route",
      type: "decision",
      provider: "decision-rule",
      problem: "choice",
      options: ["local-process"],
      context: { nodeType: "execute" },
    },
    {
      id: "stats",
      type: "execute",
      executorFrom: "route",
      dependsOn: ["route"],
    },
    {
      id: "check",
      type: "verify",
      verifier: "stats-acceptance",
      inputFrom: "stats",
      dependsOn: ["stats"],
    },
  ],
} as const;

const POLICY_CONTENT = {
  schemaVersion: 2,
  kind: "rule-v1",
  // 决策节点消费：route.when 的全部键值匹配决策上下文时命中
  routes: [{ when: { nodeType: "execute" }, choose: "local-process" }],
} as const;

const EVALUATOR_CONTENT = {
  schemaVersion: 1,
  kind: "stats-acceptance-v1",
  checks: ["json-schema", "totals-consistency"],
} as const;

export const SEED_ARTIFACTS = [
  { id: "stats-graph", kind: "task-graph", content: GRAPH_CONTENT },
  { id: "stats-rule", kind: "routing-policy", content: POLICY_CONTENT },
  { id: "stats-acceptance", kind: "acceptance-evaluator", content: EVALUATOR_CONTENT },
] as const;

export interface SeedVersion {
  artifactId: string;
  versionId: string;
  digest: string;
}

export interface SeedResult {
  principalId: string;
  organismId: string;
  snapshotId: string;
  snapshotDigest: string;
  revision: number;
  /** false 表示重复 init 且内容一致，幂等复用 */
  installed: boolean;
  versions: SeedVersion[];
}

export interface SeedDeps {
  kernel: Kernel;
  storage: Storage;
  blobs: BlobStore;
  clock: Pick<Clock, "now">;
}

/**
 * 安装 seed。幂等性来自三层去重：版本按内容摘要、快照按闭包摘要、
 * active 指针仅在为空时装载；已安装其他快照的实例拒绝覆盖。
 */
export function installSeed(deps: SeedDeps): SeedResult {
  return deps.storage.tx(() => {
    const { kernel, storage, blobs, clock } = deps;
    const principal = kernel.createPrincipal(PRINCIPAL_ID, "user");
    const scope = `organism:${ORGANISM_ID}`;
    kernel.createLineage(LINEAGE_ID, principal.id, scope);
    const organism = kernel.createOrganism(ORGANISM_ID, principal.id, scope);

    const bindings: Record<string, string> = {};
    const resolved: Array<{ slot: string; version: { id: string; contentDigest: string } }> = [];
    const versions: SeedVersion[] = [];
    for (const def of SEED_ARTIFACTS) {
      storage.insertArtifact({
        id: def.id,
        kind: def.kind,
        lineageId: LINEAGE_ID,
        ownerId: principal.id,
        createdAt: clock.now(),
      });
      const canonical = canonicalJson(def.content);
      const { digest, ref } = blobs.write(canonical);
      const versionExisted = Boolean(storage.findArtifactVersionByDigest(def.id, digest));
      const artifact = storage.getArtifact(def.id)!;
      const version = kernel.registerVersion({
        artifact,
        schemaVersion: 1,
        contentDigest: digest,
        contentRef: ref,
        parents: [],
        dependencies: [],
        createdBy: PRINCIPAL_ID,
      });
      if (!versionExisted) {
        storage.appendEvent({
          streamId: "seed",
          type: "seed.version.registered",
          payload: { artifactId: def.id, versionId: version.id, digest },
          occurredAt: clock.now(),
        });
      }
      bindings[def.kind] = version.id;
      resolved.push({ slot: def.kind, version });
      versions.push({ artifactId: def.id, versionId: version.id, digest });
    }

    const digest = snapshotDigest(resolved as never);
    const snapshotExisted = Boolean(storage.findSnapshotByDigest(digest));
    const snapshot = kernel.createSnapshot(bindings, PRINCIPAL_ID);
    if (!snapshotExisted) {
      storage.appendEvent({
        streamId: "seed",
        type: "genome.snapshot.created",
        payload: { snapshotId: snapshot.id, digest, bindings },
        occurredAt: clock.now(),
      });
    }

    const current = kernel.getOrganism(ORGANISM_ID)!;
    let installed = false;
    if (current.activeGenomeId === snapshot.id) {
      // 幂等复用：同 seed 内容产生同快照
    } else if (current.activeGenomeId === null) {
      const result = kernel.installAsActive(ORGANISM_ID, snapshot.id, current.revision);
      if (!result.ok) throw new Error("seed 安装的 CAS 提交冲突，请重试 init");
      installed = true;
      storage.appendEvent({
        streamId: `organism-${ORGANISM_ID}`,
        type: "organism.genome.installed",
        payload: {
          snapshotId: snapshot.id,
          fromRevision: current.revision,
          toRevision: result.revision,
        },
        organismId: ORGANISM_ID,
        occurredAt: clock.now(),
      });
    } else {
      throw new Error(
        `实例已安装默认快照 ${current.activeGenomeId}；init 不覆盖既有选择（更换默认快照须走显式晋升流程）`,
      );
    }

    return {
      principalId: principal.id,
      organismId: organism.id,
      snapshotId: snapshot.id,
      snapshotDigest: digest,
      revision: kernel.getOrganism(ORGANISM_ID)!.revision,
      installed,
      versions,
    };
  });
}

/** 稳定序列化：键排序，保证同内容同摘要 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
