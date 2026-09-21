import type { Artifact, ArtifactVersion, Clock, GenomeSnapshot, Kernel } from "../kernel/index.ts";
import type { CapabilityModule } from "../runtime/capability.ts";
import type { BlobStore } from "../storage/blobs.ts";
import { canonicalJson } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";

/**
 * Evolution 预注册资产（M2）：组合候选快照所需的固定版本。
 * 图/策略按能力名由模板生成，裁判为基质预注册的 hybrid 版本——
 * 它们不是 builder 产物，builder 只产出能力实现（capability-module）；
 * 全部按内容摘要幂等注册，同内容在任何实例产生同摘要。
 * 依赖方向：evolution → kernel / storage（repository.md），不依赖 runtime 与 app。
 */

export interface EvolutionDeps {
  kernel: Kernel;
  storage: Storage;
  blobs: BlobStore;
  clock: Pick<Clock, "now">;
}

/**
 * 能力组合图：骨架与 G0 相同（route → work → check），仅 decision options
 * 追加 capability/<name>。stats 形态任务（无能力声明）路由不变——回归语义。
 */
export function makeCapabilityGraphContent(capabilities: string[]): object {
  return {
    schemaVersion: 2,
    kind: "dag-v1",
    nodes: [
      {
        id: "route",
        type: "decision",
        provider: "decision-rule",
        problem: "choice",
        options: ["local-process", ...capabilities.map((c) => `capability/${c}`)],
        context: { nodeType: "execute" },
      },
      { id: "work", type: "execute", executorFrom: "route", dependsOn: ["route"] },
      {
        id: "check",
        type: "verify",
        verifier: "stats-acceptance",
        inputFrom: "work",
        dependsOn: ["work"],
      },
    ],
  };
}

/** 能力路由策略：声明能力的任务命中专属规则，兜底规则保持原行为 */
export function makeCapabilityPolicyContent(capabilities: string[]): object {
  return {
    schemaVersion: 2,
    kind: "rule-v1",
    routes: [
      ...capabilities.map((c) => ({
        when: { [`capability:${c}`]: true },
        choose: `capability/${c}`,
      })),
      { when: { nodeType: "execute" }, choose: "local-process" },
    ],
  };
}

/**
 * hybrid 裁判（M2 预注册）：stats 形态输出走与 v1 等价的校验，
 * 其余走纯 JSON Schema 校验。其与 v1 的判定等价性由 tests/evals 覆盖。
 */
export const HYBRID_EVALUATOR_CONTENT = {
  schemaVersion: 1,
  kind: "hybrid-acceptance-v1",
  checks: ["json-schema", "totals-consistency(stats 形态输出)"],
} as const;

export const EVOLUTION_LINEAGE_ID = "lineage-evolution";

export interface CapabilityAsset {
  name: string;
  module: CapabilityModule;
}

export interface CapabilityGenome {
  snapshot: GenomeSnapshot;
  versions: Map<string, ArtifactVersion>;
  /** 评估计划钉住的裁判版本（= 快照 acceptance-evaluator 槽位） */
  evaluatorVersion: ArtifactVersion;
}

/**
 * 组合能力候选快照：基准快照 + capability/<name> 槽位 + 预注册的
 * 图/策略/裁判新版本（parents 指向基准版本，血缘可追溯）。
 * 幂等：同基准同内容产生同快照（digest 内容寻址）。
 */
export function ensureCapabilityGenome(
  deps: EvolutionDeps,
  opts: {
    baseSnapshotId: string;
    capabilities: CapabilityAsset[];
    createdBy: string;
  },
): CapabilityGenome {
  return deps.storage.tx(() => {
    const { snapshot: base, versions: baseVersions } = deps.kernel.resolveSnapshot(
      opts.baseSnapshotId,
    );
    for (const slot of ["task-graph", "routing-policy", "acceptance-evaluator"] as const) {
      if (!baseVersions.has(slot)) {
        throw new Error(`基准快照 ${opts.baseSnapshotId} 缺少槽位 ${slot}，无法组合能力候选`);
      }
    }
    deps.kernel.createLineage(EVOLUTION_LINEAGE_ID, opts.createdBy, "scope:evolution");

    const names = opts.capabilities.map((c) => c.name);
    const bindings: Record<string, string> = { ...base.bindings };

    bindings["task-graph"] = registerDerivedVersion(deps, {
      slot: "task-graph",
      baseVersion: baseVersions.get("task-graph")!,
      content: makeCapabilityGraphContent(names),
      createdBy: opts.createdBy,
    }).id;
    bindings["routing-policy"] = registerDerivedVersion(deps, {
      slot: "routing-policy",
      baseVersion: baseVersions.get("routing-policy")!,
      content: makeCapabilityPolicyContent(names),
      createdBy: opts.createdBy,
    }).id;
    const evaluatorVersion = registerDerivedVersion(deps, {
      slot: "acceptance-evaluator",
      baseVersion: baseVersions.get("acceptance-evaluator")!,
      content: HYBRID_EVALUATOR_CONTENT,
      createdBy: opts.createdBy,
    });
    bindings["acceptance-evaluator"] = evaluatorVersion.id;

    for (const asset of opts.capabilities) {
      const artifactId = `capability/${asset.name}`;
      const principal = { id: opts.createdBy };
      deps.storage.insertArtifact({
        id: artifactId,
        kind: artifactId,
        lineageId: EVOLUTION_LINEAGE_ID,
        ownerId: principal.id,
        createdAt: deps.clock.now(),
      });
      const artifact = deps.storage.getArtifact(artifactId)!;
      const version = registerDerivedVersion(deps, {
        slot: artifactId,
        baseVersion: undefined,
        artifact,
        content: asset.module,
        createdBy: opts.createdBy,
      });
      bindings[artifactId] = version.id;
    }

    const snapshot = deps.kernel.createSnapshot(bindings, opts.createdBy);
    return {
      snapshot,
      versions: deps.kernel.resolveSnapshot(snapshot.id).versions,
      evaluatorVersion,
    };
  });
}

/** 注册派生版本：内容写入 blob，parents 指向基准版本；digest 幂等 */
function registerDerivedVersion(
  deps: EvolutionDeps,
  opts: {
    slot: string;
    baseVersion: ArtifactVersion | undefined;
    artifact?: Artifact;
    content: unknown;
    createdBy: string;
  },
): ArtifactVersion {
  const artifact = opts.artifact ?? deps.storage.getArtifact(opts.baseVersion!.artifactId)!;
  const { digest, ref } = deps.blobs.write(canonicalJson(opts.content));
  return deps.kernel.registerVersion({
    artifact,
    schemaVersion: 2,
    contentDigest: digest,
    contentRef: ref,
    parents: opts.baseVersion ? [opts.baseVersion.id] : [],
    dependencies: [],
    createdBy: opts.createdBy,
  });
}
