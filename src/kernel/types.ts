/**
 * Kernel 领域类型：身份、不可变版本与行为快照。
 * 概念合同见 docs/domain-model.md；本文件不含持久化细节。
 */

export type PrincipalKind = "user" | "organism" | "team";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  createdAt: number;
}

export interface Organism {
  id: string;
  ownerId: string;
  scope: string;
  /** 新 Run 读取的默认 GenomeSnapshot；null 表示尚未安装 seed */
  activeGenomeId: string | null;
  /** 单调递增；并发晋升以它做条件更新 */
  revision: number;
  createdAt: number;
}

export interface Lineage {
  id: string;
  ownerId: string;
  scope: string;
  createdAt: number;
}

/** kind 同时是 GenomeSnapshot bindings 的槽位名（如 task-graph、routing-policy） */
export interface Artifact {
  id: string;
  kind: string;
  lineageId: string;
  ownerId: string;
  createdAt: number;
}

/** 内容、依赖与来源创建后不可变；修改产生新版本 */
export interface ArtifactVersion {
  id: string;
  artifactId: string;
  lineageId: string;
  schemaVersion: number;
  contentDigest: string;
  contentRef: string;
  /** Visibility belongs to the immutable version, not its content or active pointer. */
  scope?: string;
  parents: string[];
  dependencies: string[];
  createdBy: string;
  createdAt: number;
}

export type AccessAction = "read" | "operate" | "promote" | "publish" | "manage";

export interface ExternalVersionRef {
  id: string;
  contentDigest: string;
  lineageId: string;
  publicationDigest: string;
}

/** slot -> ArtifactVersion id 的不可变映射 */
export interface GenomeSnapshot {
  id: string;
  digest: string;
  bindings: Record<string, string>;
  createdBy: string;
  createdAt: number;
}

export type ArtifactSlot = string;

/** Promotion 种类：adopt=采用候选；rollback=回滚到历史快照（同样走 CAS，revision 只增不减） */
export type PromotionKind = "adopt" | "rollback";

/**
 * 晋升记录（M2）：成功记录与指针切换同事务提交；
 * operationId 幂等——提交成功但响应丢失时按它读回同一结果。
 */
export interface PromotionRecord {
  id: string;
  operationId: string;
  kind: PromotionKind;
  organismId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  expectedRevision: number;
  resultRevision: number;
  evaluationRef: string | null;
  authorizationRef: string | null;
  actor: string;
  note: string | null;
  createdAt: number;
}
