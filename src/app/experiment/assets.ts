import type { ArtifactVersion, Clock, GenomeSnapshot, Kernel } from "../../kernel/index.ts";
import type { CapabilityModule } from "../../runtime/capability.ts";
import type { BlobStore } from "../../storage/blobs.ts";
import { canonicalJson } from "../../storage/blobs.ts";
import type { Storage } from "../../storage/store.ts";
import { HYBRID_EVALUATOR_CONTENT } from "../../evolution/assets.ts";
import { llmChoicePolicyContent, type LlmChoicePolicyContent } from "../../decision/llm-policy.ts";

/**
 * 本体决策实验 v1 的预注册资产（ADR 0007；协议 organism-decision-v1）。
 * 两个稳定选项、固定裁判与 decision-view 词表在此版本化冻结；
 * R/L 两组快照除 decision provider 标识与 routing-policy 闭包外完全相同。
 */

export const PROTOCOL_ID = "organism-decision-v1";

export const STATS_OPTION = "local-process";
export const CHANGE_OPTION = "capability/changed-file-summary";
export const EXPERIMENT_OPTIONS = [STATS_OPTION, CHANGE_OPTION] as const;

export const DECISION_LINEAGE_ID = "lineage-experiment-decision";

/**
 * decision-view 槽位冻结内容：选项描述 + 词法特征词表（开发集确定）+ 输入限制。
 * 词表修订 = 新版本 = 新协议记录，不能在看见验证结果后原地改词表。
 */
export const DECISION_VIEW_CONTENT = {
  schemaVersion: 1,
  kind: "decision-view-v1",
  optionDescriptions: {
    [STATS_OPTION]: "统计输入文本的文件数、字节、行、词与 Markdown 标题",
    [CHANGE_OPTION]: "按源码、测试、文档、配置与其他类别列出变更文件",
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

/** R 组规则基线策略（rule-choice-v1）：单侧特征命中选择，双侧/零侧 abstain */
export const RULE_CHOICE_POLICY_CONTENT = {
  schemaVersion: 1,
  kind: "rule-choice-v1",
  featureRoutes: [
    { feature: "hasStatsIntent", choose: STATS_OPTION },
    { feature: "hasChangeIntent", choose: CHANGE_OPTION },
  ],
} as const;

/** L 组策略（llm-choice-v1）：冻结提示模板/服务/模型/采样（E4 冻结记录） */
export { llmChoicePolicyContent };

/** 实验执行图：仅 provider 标识随臂变化；能力、执行节点与裁判引用两组相同 */
export function makeExperimentGraphContent(providerName: string): object {
  return {
    schemaVersion: 2,
    kind: "dag-v1",
    nodes: [
      {
        id: "route",
        type: "decision",
        provider: providerName,
        problem: "choice",
        options: [...EXPERIMENT_OPTIONS],
        context: {},
        view: "decision-view-v1",
      },
      { id: "work", type: "execute", executorFrom: "route", dependsOn: ["route"] },
      {
        id: "check",
        type: "verify",
        verifier: "experiment-acceptance",
        inputFrom: "work",
        dependsOn: ["work"],
      },
    ],
  };
}

export const EXPERIMENT_PROVIDERS = {
  rule: "decision-rule",
  llm: "decision-llm",
  oracle: "decision-oracle",
} as const;

export interface ExperimentGenomes {
  rule: { snapshot: GenomeSnapshot; policyVersionId: string };
  llm: { snapshot: GenomeSnapshot; policyVersionId: string };
  oracle?: { snapshot: GenomeSnapshot; policyVersionId: string };
  decisionViewVersionId: string;
  capabilityVersionId: string;
  evaluatorVersionId: string;
  /** 两组快照的绑定差异（报告必须附上以证明比较范围） */
  bindingDiff: Record<string, unknown>;
}

/**
 * 构造 R/L（及可选 oracle）实验快照。全部版本按内容摘要幂等注册；
 * 不触碰 activeGenome（purpose=evaluation 显式提交两组快照）。
 */
export function ensureExperimentGenomes(
  deps: { kernel: Kernel; storage: Storage; blobs: BlobStore; clock: Pick<Clock, "now"> },
  opts: {
    createdBy: string;
    capabilityModule: CapabilityModule;
    llmPolicy?: LlmChoicePolicyContent;
    withOracle?: boolean;
  },
): ExperimentGenomes {
  return deps.storage.tx(() => {
    deps.kernel.createLineage(DECISION_LINEAGE_ID, opts.createdBy, "scope:experiment-decision");
    const now = deps.clock.now();

    const artifactDefs = [
      { id: "experiment-graph", kind: "task-graph" },
      { id: "experiment-policy", kind: "routing-policy" },
      { id: "experiment-acceptance", kind: "acceptance-evaluator" },
      { id: "decision-view", kind: "decision-view" },
      { id: "capability/changed-file-summary", kind: "capability/changed-file-summary" },
    ] as const;
    for (const def of artifactDefs) {
      deps.storage.insertArtifact({
        id: def.id,
        kind: def.kind,
        lineageId: DECISION_LINEAGE_ID,
        ownerId: opts.createdBy,
        createdAt: now,
      });
    }

    const register = (
      artifactId: string,
      content: unknown,
      parents: string[] = [],
    ): ArtifactVersion => {
      const artifact = deps.storage.getArtifact(artifactId)!;
      const { digest, ref } = deps.blobs.write(canonicalJson(content));
      return deps.kernel.registerVersion({
        artifact,
        schemaVersion: 2,
        contentDigest: digest,
        contentRef: ref,
        parents,
        dependencies: [],
        createdBy: opts.createdBy,
      });
    };

    const viewVersion = register("decision-view", DECISION_VIEW_CONTENT);
    const evaluatorVersion = register("experiment-acceptance", HYBRID_EVALUATOR_CONTENT);
    const capabilityVersion = register("capability/changed-file-summary", opts.capabilityModule);

    const ruleGraph = register(
      "experiment-graph",
      makeExperimentGraphContent(EXPERIMENT_PROVIDERS.rule),
    );
    const rulePolicy = register("experiment-policy", RULE_CHOICE_POLICY_CONTENT);
    const llmGraph = register(
      "experiment-graph",
      makeExperimentGraphContent(EXPERIMENT_PROVIDERS.llm),
    );
    const llmPolicyVersion = register("experiment-policy", llmChoicePolicyContent(opts.llmPolicy));

    const rule = deps.kernel.createSnapshot(
      {
        "task-graph": ruleGraph.id,
        "routing-policy": rulePolicy.id,
        "acceptance-evaluator": evaluatorVersion.id,
        "decision-view": viewVersion.id,
        "capability/changed-file-summary": capabilityVersion.id,
      },
      opts.createdBy,
    );
    const llm = deps.kernel.createSnapshot(
      {
        "task-graph": llmGraph.id,
        "routing-policy": llmPolicyVersion.id,
        "acceptance-evaluator": evaluatorVersion.id,
        "decision-view": viewVersion.id,
        "capability/changed-file-summary": capabilityVersion.id,
      },
      opts.createdBy,
    );
    let oracle: ExperimentGenomes["oracle"];
    if (opts.withOracle) {
      // Oracle 预检：测试专用 forced-choice provider，复用 R 组策略闭包
      const oracleGraph = register(
        "experiment-graph",
        makeExperimentGraphContent(EXPERIMENT_PROVIDERS.oracle),
      );
      oracle = {
        snapshot: deps.kernel.createSnapshot(
          {
            "task-graph": oracleGraph.id,
            "routing-policy": rulePolicy.id,
            "acceptance-evaluator": evaluatorVersion.id,
            "decision-view": viewVersion.id,
            "capability/changed-file-summary": capabilityVersion.id,
          },
          opts.createdBy,
        ),
        policyVersionId: rulePolicy.id,
      };
    }

    return {
      rule: { snapshot: rule, policyVersionId: rulePolicy.id },
      llm: { snapshot: llm, policyVersionId: llmPolicyVersion.id },
      ...(oracle ? { oracle } : {}),
      decisionViewVersionId: viewVersion.id,
      capabilityVersionId: capabilityVersion.id,
      evaluatorVersionId: evaluatorVersion.id,
      bindingDiff: {
        allowedDifferences: ["task-graph.decision.provider", "routing-policy 版本闭包"],
        ruleSnapshot: {
          id: rule.id,
          digest: rule.digest,
          provider: EXPERIMENT_PROVIDERS.rule,
          policyVersionId: rulePolicy.id,
        },
        llmSnapshot: {
          id: llm.id,
          digest: llm.digest,
          provider: EXPERIMENT_PROVIDERS.llm,
          policyVersionId: llmPolicyVersion.id,
        },
        sharedVersions: {
          acceptanceEvaluator: evaluatorVersion.id,
          decisionView: viewVersion.id,
          capability: capabilityVersion.id,
        },
      },
    };
  });
}
