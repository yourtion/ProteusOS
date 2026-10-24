import type { RunSummary } from "../runtime/types.ts";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionView,
  DecisionCallUsage,
  PreparedDecisionRequest,
  LlmDemosPolicyContent,
} from "../decision/index.ts";

/** 受信宿主必须保证这些上界；缺省不可用，不能用估算冒充硬上限。 */
export interface CompileBackend {
  mode: "fixture" | "real";
  version: string;
  provider: DecisionProvider;
  bounds(request: DecisionRequest): { inputTokens: number; outputTokens: number } | null;
}
export interface CompileCaseRecord {
  id: string;
  organismId: string;
  datasetId: string;
  experienceId: string;
  runId: string;
  decisionId: string;
  policyVersionId: string;
  caseId: string;
  familyId: string;
  split: "train" | "search";
  permission: "synthetic" | "permitted";
  expectedChoice: string;
  view: DecisionView;
  requestDigest: string;
  responseDigest: string;
  taskDigest: string;
  sourceDigest: string;
  metering: {
    kind: "local" | "model";
    sent: boolean;
    usage: DecisionCallUsage | null;
    durationMs: number;
    executions: RunSummary["attempts"];
  };
  verifiedBy: string;
  createdAt: number;
  digest: string;
}
export interface CompileBudget {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  wallClockMs: number;
  callTimeoutMs: number;
}
export interface CompilePlan {
  version: "policy-compile-v1";
  baseSnapshotId: string;
  baseRevision: number;
  validationSetId: string;
  validationPlanDigest: string;
  train: CompileCaseRecord[];
  search: CompileCaseRecord[];
  initialPolicy: LlmDemosPolicyContent;
  parameterSets: string[][];
  budget: CompileBudget;
  thresholds: { minAccuracy: number; minImprovement: number };
  requestedBy: string;
  sourceUsage: { modelCalls: number; inputTokens: number; outputTokens: number };
}
export type CompileJobState = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface CompileJobRecord {
  id: string;
  organismId: string;
  planDigest: string;
  planRef: string;
  backend: {
    mode: "fixture" | "real";
    version: string;
    provider: string;
    adapter: string;
    serviceId: string | null;
  } | null;
  state: CompileJobState;
  cancelRequested: boolean;
  candidateId: string | null;
  reportRef: string | null;
  error: string | null;
  requestedBy: string;
  createdAt: number;
  startedAt: number | null;
  deadlineAt: number | null;
}
export interface CompileTrial {
  id: string;
  jobId: string;
  ordinal: number;
  configuration: number;
  caseId: string;
  familyId: string;
  policyVersionId: string;
  callId: string;
  requestRef: string;
  requestDigest: string;
  prepared: PreparedDecisionRequest;
  backendVersion: string;
  provenance: ReturnType<NonNullable<DecisionProvider["callProvenance"]>>;
  reservation: { inputTokens: number; outputTokens: number };
  state: "prepared" | "started" | "completed" | "unknown";
  responseRef: string | null;
  responseDigest: string | null;
  servedModel: string | null;
  outcome:
    | "value"
    | "model_abstain"
    | "service_refusal"
    | "abstain_origin_unavailable"
    | "invalid_output"
    | "transport_error"
    | "timeout"
    | "cancelled"
    | "unknown"
    | null;
  correct: boolean | null;
  usage: DecisionCallUsage | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}
export interface CompileReport {
  version: "compile-report-v1";
  executionMode: "fixture" | "real" | null;
  jobId: string;
  planDigest: string;
  state: CompileJobState;
  candidateId: string | null;
  error: string | null;
  selection: "family-accuracy-then-fewer-demos-then-plan-order";
  winner: number | null;
  configurations: Array<{
    demoIds: string[];
    planned: number;
    completed: number;
    families: number;
    accuracy: number;
  }>;
  sourceCases: Array<{
    id: string;
    digest: string;
    runId: string;
    decisionId: string;
    split: "train" | "search";
  }>;
  trials: CompileTrial[];
  resources: {
    scope: "source-decision-calls-and-compiler-calls";
    source: CompilePlan["sourceUsage"];
    sourceExecutions: Array<{
      runId: string;
      durationMs: number;
      attempts: RunSummary["attempts"];
    }>;
    unknownExecutionCostAttempts: number;
    reserved: { calls: number; inputTokens: number; outputTokens: number };
    knownInputTokens: number;
    knownOutputTokens: number;
    unknownTokenCalls: number;
    knownCosts: Array<{ currency: string; amount: number; priceRefs: string[] }>;
    unknownCostCalls: number;
  };
  formalEvaluation: "not_run";
  adoption: "requires-adaptive-formal-evaluation-and-operator-promotion";
}
export type CompileReply = DecisionResult;
