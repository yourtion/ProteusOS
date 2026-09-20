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
  parents: string[];
  dependencies: string[];
  createdBy: string;
  createdAt: number;
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
