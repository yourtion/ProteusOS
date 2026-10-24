import {
  buildDecisionView,
  createLlmDemosPolicy,
  FROZEN_LLM_POLICY,
  parseDecisionViewContent,
  type DecisionRequest,
  type LlmDemonstration,
} from "../../../src/decision/index.ts";
import { DECISION_VIEW_CONTENT } from "../../../src/app/experiment/assets.ts";
import { canonicalJson, digestOf } from "../../../src/storage/blobs.ts";

export function llmDemosFixture(ids: { base?: string; view?: string } = {}) {
  const base = {
    schemaVersion: 1 as const,
    ...structuredClone(FROZEN_LLM_POLICY),
    service: "anthropic-messages" as const,
  };
  const content = parseDecisionViewContent(structuredClone(DECISION_VIEW_CONTENT));
  const options = ["local-process", "capability/changed-file-summary"];
  const demos: LlmDemonstration[] = [
    {
      id: "stats",
      goal: "统计输入文本的词数与行数",
      response: { kind: "value", value: "local-process" },
    },
    {
      id: "changes",
      goal: "按源码、测试与文档分类这些改动文件",
      response: { kind: "value", value: "capability/changed-file-summary" },
    },
    {
      id: "ambiguous",
      goal: "同时给出文本统计摘要和改动文件分类",
      response: { kind: "abstain", reason: "当前只能选择一种能力" },
    },
  ].map((item, i) => {
    const view = buildDecisionView({ content, goal: item.goal, options, taskInputs: [] });
    const response = item.response as LlmDemonstration["response"];
    return {
      id: item.id,
      view,
      response,
      source: {
        purpose: "development",
        split: "train",
        permission: "synthetic",
        datasetId: "PRIVATE_TRAIN_DATASET",
        caseId: `PRIVATE_CASE_${i}`,
        familyId: `PRIVATE_FAMILY_${i}`,
        runId: `source-run-${i}`,
        decisionId: `source-decision-${i}`,
        verificationRef: `PRIVATE_VERIFICATION_${i}`,
        viewDigest: digestOf(canonicalJson(view)),
        responseDigest: digestOf(canonicalJson(response)),
      },
    };
  });
  const policy = createLlmDemosPolicy({
    basePolicy: {
      versionId: ids.base ?? "base-policy-version",
      contentDigest: digestOf(canonicalJson(base)),
      content: base,
    },
    decisionView: {
      versionId: ids.view ?? "view-version",
      contentDigest: digestOf(canonicalJson(content)),
      content,
    },
    options,
    demonstrations: demos,
    demoIds: ["stats", "changes"],
  });
  return policy;
}

export function llmDemosRequest(): DecisionRequest {
  const policy = llmDemosFixture();
  return {
    problem: "choice",
    options: [...policy.fixed.options],
    context: {},
    policy: { versionId: "demo-policy-version", content: policy },
    deadlineMs: 15_000,
    remainingAttempts: 1,
    viewSource: {
      versionId: policy.fixed.decisionView.versionId,
      contentDigest: policy.fixed.decisionView.contentDigest,
    },
    view: buildDecisionView({
      content: policy.fixed.decisionView.content,
      goal: "请统计这一批文本的词数",
      options: policy.fixed.options,
      taskInputs: [],
    }),
  };
}
