import {
  buildLlmChoiceBody,
  prepareLlmDemosRequest,
  resolveLlmDemosRequest,
} from "../../src/adapters/decision-llm/request.ts";
import { describe, expect, it } from "vitest";
import {
  assertLlmDemoParametersOnly,
  isLlmDemosPolicy,
  LLM_SELECTED_DEMO_LIMIT,
  parseLlmDemosPolicy,
  withLlmDemoParameters,
} from "../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { llmDemosFixture, llmDemosRequest } from "../fixtures/decision/llm-demos.ts";

function rehash(policy: ReturnType<typeof llmDemosFixture>) {
  policy.pool.digest = digestOf(canonicalJson(policy.pool.demonstrations));
  for (const source of [policy.fixed.basePolicy, policy.fixed.decisionView])
    source.contentDigest = digestOf(canonicalJson(source.content));
  return policy;
}

describe("llm-choice-demos-v1：受控策略参数", () => {
  it.each([{ demoIds: [] }, { demoIds: ["stats", "changes"] }])(
    "v2 在最后 user 呈现当前视图，v1 的正文保持原样：$demoIds",
    ({ demoIds }) => {
      const request = llmDemosRequest();
      const old = withLlmDemoParameters(llmDemosFixture(), demoIds);
      request.policy.content = old;
      const legacy = prepareLlmDemosRequest(request);
      const legacyBody = legacy.body as ReturnType<typeof buildLlmChoiceBody>;
      const modern = withLlmDemoParameters(
        llmDemosFixture({ requestFormat: "current-user-v2" }),
        demoIds,
      );
      request.policy.content = modern;
      const prepared = prepareLlmDemosRequest(request);
      const preparedBody = prepared.body as ReturnType<typeof buildLlmChoiceBody>;
      expect(prepared.format).toBe("anthropic-choice-demos-request-v2");
      expect(legacy.format).toBe("anthropic-choice-demos-request-v1");
      expect(prepared.body.system).toBe(legacy.body.system);
      expect(preparedBody.messages.at(-1)).toEqual({
        role: "user",
        content: `${canonicalJson(request.view)}\n请给出决策 JSON。`,
      });
      expect(legacyBody.messages.at(-1)).toEqual({ role: "user", content: "请给出决策 JSON。" });
      expect(preparedBody.messages.slice(0, -1)).toEqual(legacyBody.messages.slice(0, -1));
      expect(modern.fixed).toEqual(old.fixed);
      expect(modern.pool).toEqual(old.pool);
      expect(isLlmDemosPolicy(modern)).toBe(true);
      expect(parseLlmDemosPolicy(JSON.parse(canonicalJson(modern)))).toEqual(modern);
      expect(() => assertLlmDemoParametersOnly(old, modern)).toThrow(/只允许/);
      expect(() =>
        assertLlmDemoParametersOnly(modern, withLlmDemoParameters(modern, [])),
      ).not.toThrow();
      expect(() => parseLlmDemosPolicy({ ...modern, schemaVersion: 1 })).toThrow(/格式/);
      expect(canonicalJson(prepared)).not.toMatch(/PRIVATE_|source-run|source-decision/);
    },
  );

  it("选择/顺序改变内容身份，固定组件和池不变；独立解析不会共享可变引用", () => {
    const base = llmDemosFixture();
    const reversed = withLlmDemoParameters(base, ["changes", "stats"]);
    expect(reversed.fixed).toEqual(base.fixed);
    expect(reversed.pool).toEqual(base.pool);
    expect(digestOf(canonicalJson(reversed))).not.toBe(digestOf(canonicalJson(base)));
    expect(() => assertLlmDemoParametersOnly(base, reversed)).not.toThrow();
    reversed.parameters.demoIds.pop();
    expect(base.parameters.demoIds).toEqual(["stats", "changes"]);
    expect(parseLlmDemosPolicy(JSON.parse(canonicalJson(base)))).toEqual(base);
    expect(isLlmDemosPolicy(null)).toBe(false);
  });

  it("空示例请求逐字等价旧模型请求；弃权示例仍使用原响应合同", () => {
    const request = llmDemosRequest();
    const policy = withLlmDemoParameters(request.policy.content, []);
    request.policy.content = policy;
    expect(prepareLlmDemosRequest(request).body).toEqual(
      buildLlmChoiceBody(policy.fixed.basePolicy.content, request.view!, request.options),
    );
    request.policy.content = withLlmDemoParameters(policy, ["ambiguous"]);
    expect(prepareLlmDemosRequest(request).body.messages).toContainEqual({
      role: "assistant",
      content: canonicalJson({ kind: "abstain", reason: "当前只能选择一种能力" }),
    });
  });

  it("拒绝未知/重复示例、超量参数、池摘要漂移和未许可来源", () => {
    expect(() => withLlmDemoParameters(llmDemosFixture(), ["missing"])).toThrow(/未知/);
    expect(() => withLlmDemoParameters(llmDemosFixture(), ["stats", "stats"])).toThrow(/重复/);
    expect(() =>
      withLlmDemoParameters(llmDemosFixture(), Array(LLM_SELECTED_DEMO_LIMIT + 1).fill("stats")),
    ).toThrow();
    for (const split of ["search", "formal", "regression"]) {
      const raw = llmDemosFixture() as unknown as {
        pool: { demonstrations: Array<{ source: { split: string } }> };
      };
      raw.pool.demonstrations[0]!.source.split = split;
      expect(() => parseLlmDemosPolicy(raw)).toThrow(/格式/);
    }
    const bad = llmDemosFixture();
    bad.pool.demonstrations[0]!.view.goal += "changed";
    expect(() => parseLlmDemosPolicy(bad)).toThrow(/池摘要/);
    expect(() => parseLlmDemosPolicy(rehash(bad))).toThrow(/特征|来源摘要/);
  });

  it("不能把指令、模型、视图、schema 或池变化伪装成示例参数优化", () => {
    const base = llmDemosFixture();
    for (const edit of [
      (p: typeof base) => {
        p.fixed.basePolicy.content.model = "other-model";
      },
      (p: typeof base) => {
        p.fixed.basePolicy.content.promptTemplate += "新指令";
      },
      (p: typeof base) => {
        p.fixed.decisionView.versionId = "other-view";
      },
      (p: typeof base) => {
        p.pool.demonstrations[0]!.source.verificationRef = "other-verification";
      },
    ]) {
      const changed = structuredClone(base);
      edit(changed);
      rehash(changed);
      expect(() => assertLlmDemoParametersOnly(base, changed)).toThrow(/只允许/);
    }
    const schema = structuredClone(base);
    schema.fixed.basePolicy.content.responseSchema.accept.push("new-format");
    expect(() => parseLlmDemosPolicy(rehash(schema))).toThrow(/schema/);
  });

  it("严格视图/响应拒绝标签、越界选项、假特征与错误描述", () => {
    const base = llmDemosFixture();
    for (const edit of [
      (p: typeof base) => {
        Object.assign(p.pool.demonstrations[0]!.view, { expectedChoice: "SECRET" });
      },
      (p: typeof base) => {
        p.pool.demonstrations[0]!.view.features.hasStatsIntent = false;
      },
      (p: typeof base) => {
        p.pool.demonstrations[0]!.view.options[0]!.description = "fake";
      },
      (p: typeof base) => {
        p.pool.demonstrations[0]!.response = { kind: "value", value: "unknown" };
      },
      (p: typeof base) => {
        p.pool.demonstrations[0]!.response = { kind: "abstain", reason: "a".repeat(513) };
      },
      (p: typeof base) => {
        Object.assign(p.pool.demonstrations[0]!.response, { confidence: 1 });
      },
    ]) {
      const changed = structuredClone(base);
      edit(changed);
      for (const demo of changed.pool.demonstrations) {
        demo.source.viewDigest = digestOf(canonicalJson(demo.view));
        demo.source.responseDigest = digestOf(canonicalJson(demo.response));
      }
      expect(() => parseLlmDemosPolicy(rehash(changed))).toThrow();
    }
  });

  it("相同视图不能以换 ID 重复作为示例；组件内容必须匹配摘要", () => {
    const policy = llmDemosFixture();
    const duplicate = structuredClone(policy.pool.demonstrations[0]!);
    duplicate.id = "renamed";
    policy.pool.demonstrations.push(duplicate);
    expect(() => parseLlmDemosPolicy(rehash(policy))).toThrow(/重复/);
    const changed = llmDemosFixture();
    changed.fixed.basePolicy.content.model = "changed";
    expect(() => parseLlmDemosPolicy(changed)).toThrow(/组件内容摘要/);
  });
});

describe("请求可重建、可验证且有界", () => {
  it("完整请求重建幂等，仅发送所选示例内容，不发送来源/标签元数据", () => {
    const request = llmDemosRequest();
    const prepared = prepareLlmDemosRequest(request);
    request.prepared = JSON.parse(canonicalJson(prepared));
    expect(resolveLlmDemosRequest(request)).toEqual(prepared.body);
    expect(prepareLlmDemosRequest(request)).toEqual(prepared);
    expect(canonicalJson(prepared)).not.toMatch(
      /PRIVATE_|verificationRef|familyId|caseId|datasetId|source-decision|source-run/,
    );
    const policy = parseLlmDemosPolicy(request.policy.content);
    const body = resolveLlmDemosRequest(request);
    expect(body.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[0]!.content).toBe(canonicalJson(policy.pool.demonstrations[0]!.view));
    expect(canonicalJson(prepared)).not.toContain("当前只能选择一种能力");
    request.prepared!.body.model = "tampered";
    expect(() => resolveLlmDemosRequest(request)).toThrow(/冻结模型请求/);
  });

  it("实际请求必须匹配冻结问题/选项/视图版本与描述；超限不截断", () => {
    for (const edit of [
      (r: ReturnType<typeof llmDemosRequest>) => {
        r.problem = "rank";
      },
      (r: ReturnType<typeof llmDemosRequest>) => {
        r.options.reverse();
      },
      (r: ReturnType<typeof llmDemosRequest>) => {
        delete r.viewSource;
      },
      (r: ReturnType<typeof llmDemosRequest>) => {
        r.viewSource!.versionId = "drift";
      },
      (r: ReturnType<typeof llmDemosRequest>) => {
        r.view!.options[0]!.description = "fake";
      },
      (r: ReturnType<typeof llmDemosRequest>) => {
        r.view!.goal = "统计字数".repeat(5000);
      },
    ]) {
      const request = llmDemosRequest();
      edit(request);
      expect(() => prepareLlmDemosRequest(request)).toThrow();
    }
    const request = llmDemosRequest();
    const policy = parseLlmDemosPolicy(request.policy.content);
    policy.fixed.basePolicy.content.promptTemplate += "界".repeat(25_000);
    request.policy.content = rehash(policy);
    expect(() => prepareLlmDemosRequest(request)).toThrow(/64 KiB/);
  });
});
