import { z } from "zod";
import {
  buildDecisionViewFromInputs,
  parseChoiceResponse,
  parseDecisionViewContent,
  parseLlmDemosPolicy,
  parseLlmPolicy,
  RESPONSE_SCHEMA_DIGEST_TARGET,
  type DecisionRequest,
} from "../../src/decision/index.ts";
import {
  buildLlmChoiceBody,
  llmPromptDigest,
  prepareLlmDemosRequest,
} from "../../src/adapters/decision-llm/request.ts";
import type { CompileJobRecord } from "../../src/evolution/compile-types.ts";
import type { DecisionCallUsage } from "../../src/decision/call.ts";
import type { StoredExecutionEvidence } from "../../src/runtime/execution-evidence.ts";
import { readExecutionTrace } from "../../src/runtime/execution-evidence.ts";
import { modelFreeUsage } from "../../src/runtime/model-free.ts";
import { normalizeDag, parseGraph, validateDag } from "../../src/runtime/graph.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  adaptiveTask,
  adaptiveUnits,
  freezeAdaptivePlan,
  selectAdaptiveChoice,
  type FrozenAdaptivePlan,
} from "./adaptive.ts";
import { readAdaptiveRunTask, type RunVerificationDeps } from "./run-verification.ts";

export interface ArmEvidenceInput {
  frozen: FrozenAdaptivePlan;
  unitId: string;
  task: unknown;
  snapshots: { base: string; compiled: string };
  backend: NonNullable<CompileJobRecord["backend"]>;
  /** 固定 1/3/1 个槽位；缺测填 null，不允许移除失败或补选最好的一次。 */
  runIds: Array<string | null>;
}

function equal(a: unknown, b: unknown, reason: string) {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`策略臂证据不匹配：${reason}`);
}

const fullValueSchema = z.strictObject({
  kind: z.literal("value"),
  value: z.string(),
  provenance: z.strictObject({ provider: z.string(), policyVersion: z.string() }),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
const backendSchema = z.strictObject({
  mode: z.enum(["fixture", "real"]),
  version: z.string().min(1),
  provider: z.string().min(1),
  adapter: z.string().min(1),
  serviceId: z.string().nullable(),
});
const usageSchema = z
  .strictObject({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costAmount: z.number().finite().nonnegative().nullable(),
    costCurrency: z.string().min(1).nullable(),
    priceRef: z.string().min(1).nullable(),
  })
  .nullable();
const refusalSchema = z.union([
  z.strictObject({ stopReason: z.literal("refusal"), refusal: z.literal(true) }),
  z.strictObject({ stop_reason: z.literal("refusal") }),
]);

/** 汇总全部调用/执行的已知部分；缺少执行器模型调用次数，不能生成完整预算证明。 */
function resources(
  items: Array<{
    ref: string;
    kind: "decision" | "execution";
    modelCalls: number | null;
    usage: DecisionCallUsage | null;
  }>,
) {
  for (const item of items) usageSchema.parse(item.usage);
  const sum = (values: Array<number | null | undefined>) => ({
    knownTotal: values.some((v) => v != null)
      ? values.reduce<number>((n, v) => n + (v ?? 0), 0)
      : null,
    unknownItems: values.filter((v) => v == null).length,
  });
  const currencies = [
    ...new Set(items.map((i) => i.usage?.costCurrency).filter((c): c is string => !!c)),
  ].sort();
  return {
    items,
    modelCalls: sum(items.map((i) => i.modelCalls)),
    inputTokens: sum(items.map((i) => i.usage?.inputTokens)),
    outputTokens: sum(items.map((i) => i.usage?.outputTokens)),
    knownCosts: currencies.map((currency) => {
      const known = items.filter(
        (i) => i.usage?.costCurrency === currency && i.usage.costAmount != null && i.usage.priceRef,
      );
      return {
        currency,
        amount: known.reduce((n, i) => n + i.usage!.costAmount!, 0),
        priceRefs: [...new Set(known.map((i) => i.usage!.priceRef!))].sort(),
      };
    }),
    unknownCostItems: items.filter(
      (i) => i.usage?.costAmount == null || !i.usage.costCurrency || !i.usage.priceRef,
    ).length,
  };
}

/** 只读复算一个正式单元；尚无预派发绑定、运行顺序与真实来源证明，不创建 Evaluation。 */
export function auditAdaptiveArm(deps: RunVerificationDeps, input: ArmEvidenceInput) {
  return deps.storage.tx(() => readAdaptiveArm(deps, input));
}

/** @internal 调用者持有 Storage.tx，供持久化槽位核验组合。 */
export function readAdaptiveArm(deps: RunVerificationDeps, input: ArmEvidenceInput) {
  deps.kernel.assertOrganismAccess(deps.organismId, deps.actorId);
  const backend = backendSchema.parse(input.backend);
  const frozen = freezeAdaptivePlan(input.frozen.plan);
  equal(frozen.digest, input.frozen.digest, "冻结清单");
  const unit = adaptiveUnits(frozen.plan).find((u) => u.id === input.unitId && u.repeat > 0);
  if (!unit) throw new Error("未知正式执行单元");
  const task = adaptiveTask(frozen, unit.caseId, input.task);
  const slots = unit.arm === "budget-matched" ? 3 : 1;
  if (input.runIds.length !== slots || unit.allowance.modelCalls !== slots)
    throw new Error("策略臂须固定 1/3/1 个执行槽位，缺测必须显式为 null");
  const present = input.runIds.filter((id): id is string => id !== null);
  if (new Set(present).size !== present.length) throw new Error("同一 Run 不能重复占用槽位");
  const read = (ref: string, digest: string) => {
    const raw = deps.blobs.read(ref);
    if (digestOf(raw) !== digest) throw new Error("策略臂 blob 摘要漂移");
    return raw;
  };
  const profile = (id: string) => {
    const resolved = deps.kernel.resolveSnapshot(id);
    if (resolved.snapshot.createdAt > frozen.plan.frozenAt) throw new Error("策略快照晚于清单冻结");
    for (const version of resolved.versions.values()) {
      deps.kernel.assertVersionAccess(version.id, deps.actorId);
      read(version.contentRef, version.contentDigest);
    }
    const slot = (name: string) => {
      const version = resolved.versions.get(name);
      if (!version) throw new Error(`策略快照缺少 ${name}`);
      return {
        version,
        content: JSON.parse(read(version.contentRef, version.contentDigest)) as unknown,
      };
    };
    return {
      ...resolved,
      policy: slot("routing-policy"),
      graph: slot("task-graph"),
      judge: slot("acceptance-evaluator"),
      view: slot("decision-view"),
    };
  };
  const base = profile(input.snapshots.base);
  const compiled = profile(input.snapshots.compiled);
  const withoutPolicy = (bindings: Record<string, string>) =>
    Object.fromEntries(Object.entries(bindings).filter(([key]) => key !== "routing-policy"));
  equal(
    withoutPolicy(base.snapshot.bindings),
    withoutPolicy(compiled.snapshot.bindings),
    "快照仅允许策略不同",
  );
  equal(
    [base.policy.version.contentDigest, compiled.policy.version.contentDigest],
    [frozen.plan.policies.baseDigest, frozen.plan.policies.candidateDigest],
    "基线/候选策略摘要",
  );
  const demos = parseLlmDemosPolicy(compiled.policy.content);
  equal(
    demos.fixed.basePolicy,
    {
      versionId: base.policy.version.id,
      contentDigest: base.policy.version.contentDigest,
      content: base.policy.content,
    },
    "候选冻结基线",
  );
  equal(
    demos.fixed.decisionView,
    {
      versionId: base.view.version.id,
      contentDigest: base.view.version.contentDigest,
      content: base.view.content,
    },
    "候选冻结视图",
  );
  const policy = parseLlmPolicy(base.policy.content);
  if (!policy) throw new Error("策略臂基线必须为 llm-choice-v1");
  equal(
    [
      policy.model,
      digestOf(policy.promptTemplate),
      digestOf(RESPONSE_SCHEMA_DIGEST_TARGET),
      base.graph.version.contentDigest,
      base.judge.version.contentDigest,
      base.view.version.contentDigest,
    ],
    [
      frozen.plan.fixed.model,
      frozen.plan.fixed.instructionDigest,
      frozen.plan.fixed.schemaDigest,
      frozen.plan.fixed.graphDigest,
      frozen.plan.fixed.judgeDigest,
      frozen.plan.fixed.viewDigest,
    ],
    "固定模型/指令/schema/图/裁判/视图",
  );
  equal(digestOf(canonicalJson(backend)), frozen.plan.fixed.adapterDigest, "冻结后端描述");
  equal(backend.mode, frozen.plan.mode, "后端声明模式");
  const graph = normalizeDag(
    parseGraph(read(base.graph.version.contentRef, base.graph.version.contentDigest)),
  );
  validateDag(graph);
  const decision = graph.nodes.find((n) => n.type === "decision")!;
  const work = graph.nodes.find((n) => n.type === "execute")!;
  const verify = graph.nodes.find((n) => n.type === "verify")!;
  if (
    graph.nodes.length !== 3 ||
    !decision ||
    !work ||
    !verify ||
    decision.view !== "decision-view-v1" ||
    work.executorFrom !== decision.id ||
    verify.inputFrom !== work.id
  )
    throw new Error("首轮策略臂只支持一个 choice/execute/verify 的冻结图");
  equal(decision.options, demos.fixed.options, "冻结 choice 选项");
  equal(decision.provider, backend.provider, "冻结 Provider");
  const view = buildDecisionViewFromInputs({
    content: parseDecisionViewContent(base.view.content),
    goal: task.goal,
    options: decision.options!,
    inputs: task.inputs.map((file) => ({
      name: file.name,
      bytes: Buffer.byteLength(file.content, "utf8"),
    })),
  });
  const expected = unit.arm === "compiled" ? compiled : base;
  const metering: Parameters<typeof resources>[0] = [];
  const proofs: Array<{
    runId: string;
    callId: string;
    choice: string | null;
    decisionState: string;
    decisionOutcome: string;
    task: ReturnType<typeof readAdaptiveRunTask>;
  } | null> = [];
  let previousEnd: number | null = null;
  for (const id of input.runIds) {
    if (id === null) {
      proofs.push(null);
      continue;
    }
    const bound = readAdaptiveRunTask(deps, id, { frozen, caseId: unit.caseId, task });
    const run = deps.storage.getRun(id)!;
    equal(run.snapshotId, expected.snapshot.id, "Run 策略臂快照");
    equal(run.evaluatorVersionId ?? base.judge.version.id, base.judge.version.id, "固定裁判版本");
    if (previousEnd !== null && run.createdAt < previousEnd)
      throw new Error("Run 顺序倒置或并发，不能复算顺序投票");
    previousEnd = run.updatedAt;
    const calls = deps.storage.listDecisionCalls(id);
    if (calls.length !== 1)
      throw new Error("策略臂 Run 必须包含唯一 DecisionCall，不能遗漏额外调用");
    const call = calls[0]!;
    equal(
      [
        call.runId,
        call.nodeId,
        call.snapshotId,
        call.policyVersionId,
        call.viewVersionId,
        call.provider,
        call.experimentId,
      ],
      [
        id,
        decision.id,
        run.snapshotId,
        expected.policy.version.id,
        base.view.version.id,
        decision.provider,
        run.experimentId,
      ],
      "DecisionCall 归属",
    );
    if (call.kind !== "model" || ["prepared", "started"].includes(call.state))
      throw new Error("DecisionCall 尚未形成可复算的远端调用终态");
    if (!call.requestRef || !call.requestDigest) throw new Error("DecisionCall 请求缺失");
    const request: DecisionRequest = {
      problem: "choice",
      options: decision.options!,
      view,
      context: decision.context ?? {},
      policy: { versionId: expected.policy.version.id, content: expected.policy.content },
      deadlineMs: 1,
      remainingAttempts: 1,
      viewSource: {
        versionId: base.view.version.id,
        contentDigest: base.view.version.contentDigest,
      },
    };
    const prepared = unit.arm === "compiled" ? prepareLlmDemosRequest(request) : undefined;
    equal(
      JSON.parse(read(call.requestRef, call.requestDigest)),
      {
        problem: "choice",
        options: decision.options,
        view,
        context: decision.context ?? {},
        ...(prepared ? { prepared, viewSource: request.viewSource } : {}),
      },
      "原始请求/冻结任务视图/正文",
    );
    const body = prepared ? prepared.body : buildLlmChoiceBody(policy, view, decision.options!);
    equal(
      [
        call.provenance.provider,
        call.provenance.policyVersionId,
        call.provenance.viewVersionId,
        call.provenance.adapter,
        call.provenance.serviceId,
        call.provenance.requestedModel,
        call.provenance.sampling,
        call.provenance.promptDigest,
        call.provenance.responseSchemaDigest,
      ],
      [
        decision.provider,
        expected.policy.version.id,
        base.view.version.id,
        backend.adapter,
        backend.serviceId,
        policy.model,
        policy.sampling,
        prepared
          ? llmPromptDigest(body as ReturnType<typeof buildLlmChoiceBody>)
          : digestOf(body.system as string),
        digestOf(RESPONSE_SCHEMA_DIGEST_TARGET),
      ],
      "调用来源/模型/采样/提示",
    );
    if (
      call.createdAt < run.createdAt ||
      call.createdAt > run.updatedAt ||
      (call.endedAt !== null && call.endedAt > run.updatedAt)
    )
      throw new Error("DecisionCall 时间不属于 Run");
    let value: string | null = null;
    let decisionOutcome: string = call.state;
    if ((call.responseRef === null) !== (call.responseDigest === null))
      throw new Error("DecisionCall 响应引用不完整");
    const recorded = deps.storage.runEventsByType(id, "decision.recorded");
    if (call.state !== "value" && recorded.length) throw new Error("失败调用不能有成功选择事件");
    if (
      ["value", "abstain", "invalid_output", "timeout", "transport_error"].includes(call.state) &&
      !call.sent
    )
      throw new Error("调用终态与发送记录冲突");
    const response =
      call.responseRef && call.responseDigest ? read(call.responseRef, call.responseDigest) : null;
    if (call.state === "value") {
      if (response === null || !call.sent) throw new Error("value 调用缺少已发送的原始响应");
      const full = fullValueSchema.safeParse(JSON.parse(response));
      const choice = full.success
        ? parseChoiceResponse(
            canonicalJson({ kind: "value", value: full.data.value }),
            decision.options!,
          )
        : parseChoiceResponse(response, decision.options!);
      if (choice.kind !== "value") throw new Error("DecisionCall value 与原始响应不一致");
      if (full.success)
        equal(
          full.data.provenance,
          { provider: call.provider, policyVersion: call.policyVersionId },
          "完整响应来源",
        );
      value = choice.value;
      const events = recorded;
      if (events.length !== 1) throw new Error("选择事件缺失或歧义");
      const event = events[0]!;
      equal(
        [
          event.runId,
          event.streamId,
          event.payload["decisionId"],
          event.payload["nodeId"],
          event.payload["value"],
          event.payload["provider"],
          event.payload["policyVersion"],
        ],
        [id, `run-${id}`, call.id, decision.id, value, call.provider, call.policyVersionId],
        "选择事件与原始响应",
      );
    } else if (call.state === "abstain") {
      if (response === null) throw new Error("弃权调用缺少原始响应");
      const parsed = parseChoiceResponse(response, decision.options!);
      const refusal = JSON.parse(response) as Record<string, unknown>;
      if (parsed.kind !== "abstain" && !refusalSchema.safeParse(refusal).success)
        throw new Error("弃权终态与原始响应不一致");
      decisionOutcome = parsed.kind === "abstain" ? "model_abstain" : "service_refusal";
    } else if (call.state === "invalid_output") {
      if (response === null || parseChoiceResponse(response, decision.options!).kind !== "invalid")
        throw new Error("非法输出终态与原始响应不一致");
    } else if (call.state === "transport_error") {
      if (
        response === null ||
        typeof (JSON.parse(response) as { error?: unknown }).error !== "string"
      )
        throw new Error("传输失败缺少原始错误证据");
    } else if (response !== null) {
      throw new Error("超时/取消/unknown 不能借迟到正文改写终态");
    }
    metering.push({
      ref: `decision:${call.id}`,
      kind: "decision",
      modelCalls: call.sent ? 1 : 0,
      usage: call.usage,
    });
    const attempts = deps.storage.listProcesses(id).flatMap((p) => {
      if (p.nodeId !== work.id) throw new Error("策略臂出现额外执行节点");
      return deps.storage.listAttempts(p.id);
    });
    const events = deps.storage.runEventsByType(id, "attempt.evidence.recorded");
    if (call.state !== "value" && attempts.length)
      throw new Error("非 value 决策不能派发执行 Attempt");
    for (const attempt of attempts) {
      const evidence = events.find((e) => e.attemptId === attempt.id)?.payload["evidence"] as
        | StoredExecutionEvidence
        | undefined;
      if (value !== null && evidence) equal(evidence.executor, value, "选择与实际执行器");
      if (evidence) readExecutionTrace(evidence, deps.blobs);
      const bounded = modelFreeUsage(evidence, deps.blobs);
      metering.push({
        ref: `attempt:${attempt.id}`,
        kind: "execution",
        modelCalls: bounded?.modelCalls ?? null,
        usage: bounded?.usage ?? evidence?.usage ?? null,
      });
    }
    // 投票只看决策与执行状态，不读取 JSON passed 或私有 gold。
    const choice = value !== null && attempts.at(-1)?.state === "succeeded" ? value : null;
    proofs.push({
      runId: id,
      callId: call.id,
      choice,
      decisionState: call.state,
      decisionOutcome,
      task: bound,
    });
  }
  const missing = proofs.flatMap((proof, index) => (proof === null ? [index] : []));
  const choices = proofs.map((proof) => proof?.choice ?? null);
  const selectedChoice = selectAdaptiveChoice(choices);
  const selectedIndex = choices.indexOf(selectedChoice);
  const selected = selectedChoice === null ? null : proofs[selectedIndex]!;
  const result = {
    version: "adaptive-arm-audit-v1" as const,
    scope: "recorded-policy-choice-and-supplied-order" as const,
    manifestDigest: frozen.digest,
    unit,
    snapshots: input.snapshots,
    backend,
    proofs,
    missing,
    choices,
    selectedChoice,
    selectedIndex,
    selectedRunId: selected?.runId ?? null,
    selectedAcceptance: selected?.task.verifiedAcceptance ?? false,
    selection: "plurality-first-tie-no-gold-v1" as const,
    status: missing.length
      ? ("incomplete" as const)
      : proofs.some((p) => p?.task.status !== "verified")
        ? ("unavailable" as const)
        : ("verified" as const),
    resources: resources(metering),
    registrationVerification: "not_verified" as const,
    orderVerification: "not_verified" as const,
    environmentVerification: "not_verified" as const,
    toolsVerification: "snapshot-equality-only" as const,
    sourceModeVerification: "unavailable" as const,
    costVerification: "partial" as const,
    formalEvaluation: "not_run" as const,
  };
  return { ...result, digest: digestOf(canonicalJson(result)) };
}
