import { createHash } from "node:crypto";
import type { Artifact, ArtifactVersion, Clock, GenomeSnapshot, Kernel } from "../kernel/index.ts";
import type { CapabilityModule } from "../runtime/capability.ts";
import { isCapabilityName } from "../runtime/capability.ts";
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
        // 声明受限视图（M3）：路由决策可按词表特征分流；快照须含 decision-view 槽位
        view: "decision-view-v1",
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

/**
 * 评估协议（m2-bootstrap-eval-v1，构造候选前固定，避免事后移动标准）：
 * 成功与回归为硬约束，质量/时延/成本分别比较，不合成总分。
 */
export const EVALUATION_PROTOCOL_CONTENT = {
  schemaVersion: 1,
  kind: "m2-bootstrap-eval-v1",
  runs: [
    { role: "new-capability", binding: "candidate", requisite: "succeeded" },
    {
      role: "regression",
      binding: "candidate",
      cardinality: "one-per-existing-capability-plus-core-regression",
      requisite: "all-succeeded",
    },
    {
      role: "baseline",
      binding: "base",
      cardinality: "same-regression-set",
      requisite: "all-succeeded",
    },
  ],
  verdictRules: {
    eligible: "三个 Run 全部 succeeded",
    rejected: "候选绑定的新能力验收或回归失败（证据保留）",
    inconclusive: "基线对照失败——评估环境不可信，不判 rejected，可重评",
  },
  evaluator: "按内容寻址钉住 hybrid-acceptance-v1（不取候选快照槽位）",
  metrics: ["success", "regression", "latency"],
} as const;

export function evaluationProtocolDigest(): string {
  return createHash("sha256")
    .update(canonicalJson(EVALUATION_PROTOCOL_CONTENT), "utf8")
    .digest("hex");
}

/**
 * 评估计划钉住的裁判版本：按内容寻址注册 HYBRID_EVALUATOR_CONTENT。
 * digest 幂等——与组合候选时注册的是同一版本；即使候选快照的
 * acceptance-evaluator 槽位被换成放水裁判，评估裁判也不受影响。
 */
export function ensureHybridEvaluatorVersion(
  deps: EvolutionDeps,
  opts: { baseSnapshotId: string; createdBy: string },
): ArtifactVersion {
  return deps.storage.tx(() => {
    const { versions } = deps.kernel.resolveSnapshot(opts.baseSnapshotId);
    const baseEvaluator = versions.get("acceptance-evaluator");
    if (!baseEvaluator) {
      throw new Error(`基准快照 ${opts.baseSnapshotId} 缺少 acceptance-evaluator 槽位`);
    }
    deps.blobs.write(canonicalJson(EVALUATION_PROTOCOL_CONTENT));
    return registerDerivedVersion(deps, {
      slot: "acceptance-evaluator",
      baseVersion: baseEvaluator,
      content: HYBRID_EVALUATOR_CONTENT,
      createdBy: opts.createdBy,
    });
  });
}

export const EVOLUTION_LINEAGE_ID = "lineage-evolution";

/**
 * builder 快照：固定 builder 图（dev → check）+ test-runner 裁判。
 * 图骨架固定，执行器名与测试命令按参数注入；digest 幂等。
 * 构建规范只授予写工作区之权，不涉及 seed 裁判与 kernel（roadmap M2 步骤 2）。
 */
export function ensureBuilderGenome(
  deps: EvolutionDeps,
  opts: {
    capability: string;
    executorName: string;
    testCommand: string[];
    createdBy: string;
  },
): { snapshot: GenomeSnapshot } {
  return deps.storage.tx(() => {
    deps.kernel.createLineage(EVOLUTION_LINEAGE_ID, opts.createdBy, "scope:evolution");
    const now = deps.clock.now();
    deps.storage.insertArtifact({
      id: "builder-graph",
      kind: "task-graph",
      lineageId: EVOLUTION_LINEAGE_ID,
      ownerId: opts.createdBy,
      createdAt: now,
    });
    deps.storage.insertArtifact({
      id: "builder-acceptance",
      kind: "acceptance-evaluator",
      lineageId: EVOLUTION_LINEAGE_ID,
      ownerId: opts.createdBy,
      createdAt: now,
    });
    const graphVersion = registerDerivedVersion(deps, {
      slot: "task-graph",
      baseVersion: undefined,
      artifact: deps.storage.getArtifact("builder-graph")!,
      content: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          { id: "dev", type: "execute", executor: opts.executorName, dependsOn: [] },
          {
            id: "check",
            type: "verify",
            verifier: "builder-acceptance",
            inputFrom: "dev",
            dependsOn: ["dev"],
          },
        ],
      },
      createdBy: opts.createdBy,
    });
    const evaluatorVersion = registerDerivedVersion(deps, {
      slot: "acceptance-evaluator",
      baseVersion: undefined,
      artifact: deps.storage.getArtifact("builder-acceptance")!,
      content: {
        schemaVersion: 1,
        kind: "test-runner-v1",
        command: opts.testCommand,
        attestPaths: [`src/${opts.capability}.mjs`],
      },
      createdBy: opts.createdBy,
    });
    const snapshot = deps.kernel.createSnapshot(
      { "task-graph": graphVersion.id, "acceptance-evaluator": evaluatorVersion.id },
      opts.createdBy,
    );
    return { snapshot };
  });
}

export interface CapabilityAsset {
  name: string;
  module: CapabilityModule;
}

export interface CapabilityGenome {
  snapshot: GenomeSnapshot;
  versions: Map<string, ArtifactVersion>;
  /** 评估计划钉住的裁判版本（继承自基准的 acceptance-evaluator 槽位） */
  evaluatorVersion: ArtifactVersion;
}

/**
 * 裁判候选快照（M3 裁判拆分，evolution.md §6"裁判与被评估行为同时变化时，
 * 拆分为不同候选"的正式兑现）：只升级 acceptance-evaluator，其余槽位继承基准。
 * 其评估 = 能力不变的回归集上新旧判定等价（tests/evals 固定用例 +
 * 运行时对照）；晋升后能力候选基于它组合，两者不再同处一个快照。
 * 幂等：同基准同内容产生同快照。
 */
export function ensureJudgeGenome(
  deps: EvolutionDeps,
  opts: { baseSnapshotId: string; evaluatorContent: object; createdBy: string },
): CapabilityGenome {
  return deps.storage.tx(() => {
    const { snapshot: base, versions: baseVersions } = deps.kernel.resolveSnapshot(
      opts.baseSnapshotId,
    );
    const baseEvaluator = baseVersions.get("acceptance-evaluator");
    if (!baseEvaluator) {
      throw new Error(`基准快照 ${opts.baseSnapshotId} 缺少 acceptance-evaluator 槽位`);
    }
    deps.kernel.createLineage(EVOLUTION_LINEAGE_ID, opts.createdBy, "scope:evolution");
    deps.blobs.write(canonicalJson(EVALUATION_PROTOCOL_CONTENT));
    const evaluatorVersion = registerDerivedVersion(deps, {
      slot: "acceptance-evaluator",
      baseVersion: baseEvaluator,
      content: opts.evaluatorContent,
      createdBy: opts.createdBy,
    });
    const bindings = { ...base.bindings, "acceptance-evaluator": evaluatorVersion.id };
    const snapshot = deps.kernel.createSnapshot(bindings, opts.createdBy);
    return {
      snapshot,
      versions: deps.kernel.resolveSnapshot(snapshot.id).versions,
      evaluatorVersion,
    };
  });
}

/**
 * 组合能力候选快照：基准快照 + capability/<name> 槽位 + 预注册的
 * 图/策略新版本（parents 指向基准版本，血缘可追溯）。
 * 裁判与能力变化已拆分（M3）：本函数不再升级 acceptance-evaluator，
 * 直接继承基准槽位；基准裁判必须已能验收新能力任务的输出形态
 * （hybrid-acceptance-v1），否则要求先走裁判候选（ensureJudgeGenome）。
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
    for (const capability of opts.capabilities) {
      if (!isCapabilityName(capability.name) || capability.module.name !== capability.name) {
        throw new Error(`能力名称不合法或声明不一致：${capability.name}`);
      }
    }
    const { snapshot: base, versions: baseVersions } = deps.kernel.resolveSnapshot(
      opts.baseSnapshotId,
    );
    for (const slot of ["task-graph", "routing-policy", "acceptance-evaluator"] as const) {
      if (!baseVersions.has(slot)) {
        throw new Error(`基准快照 ${opts.baseSnapshotId} 缺少槽位 ${slot}，无法组合能力候选`);
      }
    }
    // 裁判拆分校验：能力候选继承基准裁判；基准裁判必须适用混合输出形态
    const baseEvaluator = baseVersions.get("acceptance-evaluator")!;
    const evaluatorContent = parseEvaluatorKind(deps.blobs.read(baseEvaluator.contentRef));
    if (evaluatorContent !== "hybrid-acceptance-v1") {
      throw new Error(
        `基准裁判为 ${evaluatorContent}，不能验收新能力任务的输出形态；` +
          `请先经 ensureJudgeGenome + 评估 + 晋升升级裁判（裁判与能力变化不得同处一个候选）`,
      );
    }
    deps.kernel.createLineage(EVOLUTION_LINEAGE_ID, opts.createdBy, "scope:evolution");

    const names = [
      ...new Set([
        ...Object.keys(base.bindings)
          .filter((slot) => slot.startsWith("capability/"))
          .map((slot) => slot.slice("capability/".length)),
        ...opts.capabilities.map((c) => c.name),
      ]),
    ].sort();
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
    // acceptance-evaluator 继承基准槽位（裁判拆分）
    // decision-view：组合图声明受限视图，绑定预注册词表版本（digest 幂等，
    // 与实验冻结内容同版本）；基准已有该槽位则继承
    if (!bindings["decision-view"]) {
      deps.storage.insertArtifact({
        id: "decision-view",
        kind: "decision-view",
        lineageId: EVOLUTION_LINEAGE_ID,
        ownerId: opts.createdBy,
        createdAt: deps.clock.now(),
      });
      bindings["decision-view"] = registerDerivedVersion(deps, {
        slot: "decision-view",
        baseVersion: undefined,
        artifact: deps.storage.getArtifact("decision-view")!,
        content: makeDecisionViewContent(names),
        createdBy: opts.createdBy,
      }).id;
    }

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
      evaluatorVersion: baseEvaluator,
    };
  });
}

/** 读裁判产物内容的 kind 字段（不合法内容如实返回原文标记） */
function parseEvaluatorKind(content: string): string {
  try {
    const parsed = JSON.parse(content) as { kind?: unknown };
    return typeof parsed.kind === "string" ? parsed.kind : "(无 kind)";
  } catch {
    return "(不可解析)";
  }
}

/** 注册派生版本：内容写入 blob，parents 指向基准版本；digest 幂等 */
export function registerDerivedVersion(
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
    scope: `principal:${opts.createdBy}`,
  });
}

/**
 * decision-view 槽位预注册内容（与实验冻结内容一致：同一 canonical 字节 →
 * 同一 digest → 同一版本；策略候选与实验共用该视图词表）。
 * 词表修订 = 新版本 = 新协议记录，不能在看见验证结果后原地改词表。
 */
export const DECISION_VIEW_CONTENT = {
  schemaVersion: 1,
  kind: "decision-view-v1",
  optionDescriptions: {
    "local-process": "统计输入文本的文件数、字节、行、词与 Markdown 标题",
    "capability/changed-file-summary": "按源码、测试、文档、配置与其他类别列出变更文件",
  },
  features: {
    hasStatsIntent: {
      terms: [
        "字数",
        "词数",
        "行数",
        "字节",
        "标题数",
        "统计摘要",
        "文本统计",
        "word count",
        "line count",
        "count words",
        "count lines",
        "byte count",
        "heading count",
        "text statistics",
        "statistics summary",
      ],
    },
    hasChangeIntent: {
      terms: [
        "变更",
        "改动",
        "修改清单",
        "文件分类",
        "分类汇总",
        "源码",
        "配置文件",
        "changed files",
        "classify changes",
        "file categories",
        "categorize files",
        "change summary",
        "modified files",
      ],
    },
  },
  inputViewLimitBytes: 16 * 1024,
} as const;

/**
 * 组合视图内容：特征词表与冻结内容一致（学习语义稳定，不原地改词表）；
 * optionDescriptions 按能力集扩充为新版本（版本化操作，digest 幂等）。
 */
export function makeDecisionViewContent(capabilities: string[]): object {
  const descriptions: Record<string, string> = {
    ...DECISION_VIEW_CONTENT.optionDescriptions,
  };
  for (const name of capabilities) {
    descriptions[`capability/${name}`] ??= `按 ${name} 能力的实现处理任务`;
  }
  return { ...DECISION_VIEW_CONTENT, optionDescriptions: descriptions };
}
