import {
  buildLlmChoiceBody,
  resolveLlmDemosRequest,
} from "../../src/adapters/decision-llm/request.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import {
  isLlmDemosPolicy,
  parseLlmPolicy,
  type DecisionRequest,
  type DecisionResult,
} from "../../src/decision/index.ts";
import type { RunSummary } from "../../src/runtime/types.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  bootExperimentHarness,
  DEV_DATASET,
  experimentSubmission,
} from "../fixtures/decision/harness.ts";
import { llmDemosFixture } from "../fixtures/decision/llm-demos.ts";

/** 使用真实 Adapter 的纯渲染/来源逻辑，只替换网络发送；实际执行仍由本地 worker 完成。 */
class PreparedFixtureProvider extends LlmDecisionProvider {
  bodies: ReturnType<typeof buildLlmChoiceBody>[] = [];
  override async decide(request: DecisionRequest): Promise<DecisionResult> {
    const body = isLlmDemosPolicy(request.policy.content)
      ? resolveLlmDemosRequest(request)
      : buildLlmChoiceBody(parseLlmPolicy(request.policy.content)!, request.view!, request.options);
    this.bodies.push(structuredClone(body));
    return {
      kind: "value",
      value: "local-process",
      provenance: { provider: this.name, policyVersion: request.policy.versionId },
    };
  }
}

const opened: AppInstance[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function fixture() {
  const h = bootExperimentHarness();
  h.inst.close();
  const provider = new PreparedFixtureProvider({
    apiKey: "NEVER_PERSIST_KEY",
    baseUrl: "https://fixture.invalid",
  });
  const app = openInstance(h.root, { decisions: new Map([["decision-llm", provider]]) });
  opened.push(app);
  const policy = llmDemosFixture({
    base: h.genomes.llm.policyVersionId,
    view: h.genomes.decisionViewVersionId,
  });
  const install = (content: unknown) => {
    const blob = app.blobs.write(canonicalJson(content));
    const version = app.kernel.registerVersion({
      artifact: app.storage.getArtifact("experiment-policy")!,
      schemaVersion: 1,
      contentDigest: blob.digest,
      contentRef: blob.ref,
      parents: [h.genomes.llm.policyVersionId],
      dependencies: [h.genomes.llm.policyVersionId, h.genomes.decisionViewVersionId],
      createdBy: "principal-local",
      scope: "principal:principal-local",
    });
    const snapshot = app.kernel.createSnapshot(
      { ...h.genomes.llm.snapshot.bindings, "routing-policy": version.id },
      "principal-local",
    );
    return { version, snapshot };
  };
  const { version, snapshot } = install(policy);
  const submission = experimentSubmission({
    goal: "统计输入文本的词数和行数",
    inputs: [
      join(DEV_DATASET, "bundles", "b01"),
      join(DEV_DATASET, "changed-files", "b01", "changed-files.json"),
    ],
    genomes: h.genomes,
    schema: join(DEV_DATASET, "schemas", "stats-summary.schema.json"),
    expected: join(DEV_DATASET, "expected", "dev-expl-01.json"),
  });
  const submit = () =>
    app.runtime.submitTask(submission.input, { ...submission.options, snapshotId: snapshot.id });
  return { app, provider, root: h.root, policy, install, submit, submission, snapshot, version };
}

function rewind(app: AppInstance, run: RunSummary, state: "prepared" | "started") {
  const call = app.storage.listDecisionCalls(run.runId)[0]!;
  const db = new DatabaseSync(join(app.root, "metadata.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      "UPDATE decision_calls SET state = ?, sent = ?, started_at = NULL, response_ref = NULL, response_digest = NULL, ended_at = NULL, duration_ms = NULL WHERE id = ?",
    ).run(state, state === "started" ? 1 : 0, call.id);
    db.prepare(
      "DELETE FROM events WHERE run_id = ? AND type NOT IN ('run.created', 'decision.prepared')",
    ).run(run.runId);
    db.prepare(
      "DELETE FROM attempts WHERE process_id IN (SELECT id FROM processes WHERE run_id = ?)",
    ).run(run.runId);
    db.prepare("DELETE FROM outbox WHERE run_id = ?").run(run.runId);
    db.prepare("DELETE FROM processes WHERE run_id = ?").run(run.runId);
    db.prepare("DELETE FROM experiences WHERE run_id = ?").run(run.runId);
    db.prepare("UPDATE runs SET state = 'running', failure_reason = NULL WHERE id = ?").run(
      run.runId,
    );
  } finally {
    db.close();
  }
  return call;
}

function reopen(root: string, baseUrl = "https://fixture.invalid") {
  const index = opened.findIndex((app) => app.root === root);
  opened.splice(index, 1)[0]!.close();
  const provider = new PreparedFixtureProvider({ apiKey: "NEW_KEY_NOT_IN_PAYLOAD", baseUrl });
  const app = openInstance(root, { decisions: new Map([["decision-llm", provider]]) });
  opened.push(app);
  return { app, provider };
}

describe("可编译策略：持久化、重启和旧快照兼容", () => {
  it.each(["value", "abstain", "invalid_output"] as const)(
    "%s 的服务结束证据与结案原子持久化，重开不推断或重发",
    async (kind) => {
      const h = fixture();
      const raw =
        kind === "value"
          ? '{"kind":"value","value":"local-process"}'
          : kind === "abstain"
            ? "null"
            : "{bad";
      const serviceResponse = {
        version: "llm-service-response-v1" as const,
        stopReason: kind === "invalid_output" ? "max_tokens" : "end_turn",
        contentBlockTypes: ["text"],
        textBytes: Buffer.byteLength(raw, "utf8"),
      };
      h.provider.decide = async (request) => {
        const common = {
          raw,
          provenance: { provider: "decision-llm", policyVersion: request.policy.versionId },
          evidence: { servedModel: "served-model", serviceResponse },
        };
        if (kind === "value") return { ...common, kind, value: "local-process" };
        if (kind === "abstain") return { ...common, kind, reason: "no task", raw: "null" };
        return { ...common, kind, detail: "incomplete", raw: "{bad" };
      };
      const run = await h.submit();
      const call = h.app.storage.listDecisionCalls(run.runId)[0]!;
      const events = h.app.storage.runEventsByType(run.runId, "decision.response_evidence");
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        decisionId: call.id,
        serviceResponse,
        servedModel: "served-model",
      });
      const fresh = reopen(h.root);
      expect(fresh.app.storage.runEventsByType(run.runId, "decision.response_evidence")).toEqual(
        events,
      );
      expect(fresh.app.runtime.getRunSummary(run.runId).state).toBe(run.state);
      expect(fresh.provider.bodies).toHaveLength(0);
    },
  );

  it("真实策略版本/依赖/快照闭环；保存完整模型正文且不改变 active", async () => {
    const h = fixture();
    const active = h.app.kernel.getOrganism("organism-default")!.activeGenomeId;
    const run = await h.submit();
    expect(run.state).toBe("succeeded");
    const call = h.app.storage.listDecisionCalls(run.runId)[0]!;
    const raw = h.app.blobs.read(call.requestRef!);
    const stored = JSON.parse(raw) as { prepared: DecisionRequest["prepared"] };
    expect(digestOf(raw)).toBe(call.requestDigest);
    expect(stored.prepared!.body).toEqual(h.provider.bodies[0]);
    expect(raw).not.toMatch(/PRIVATE_|NEVER_PERSIST/);
    expect(call.policyVersionId).toBe(h.version.id);
    expect(call.provenance.viewVersionId).toBe(h.policy.fixed.decisionView.versionId);
    expect(h.app.kernel.resolveVersionClosure([h.version.id]).size).toBe(3);
    expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(active);
    expect(run.attempts).toHaveLength(1);
  });

  it("prepared 重启首次发送沿用原 ID/正文/额度；旧 v1 快照仍使用原布局", async () => {
    const h = fixture();
    const run = await h.submit();
    const call = rewind(h.app, run, "prepared");
    const body = h.provider.bodies[0];
    const fresh = reopen(h.root);
    const resumed = await fresh.app.runtime.executeRun(run.runId);
    expect(resumed.state).toBe("succeeded");
    expect(fresh.provider.bodies).toEqual([body]);
    expect(fresh.app.storage.listDecisionCalls(run.runId)).toMatchObject([
      { id: call.id, state: "value", requestDigest: call.requestDigest },
    ]);
    expect(fresh.app.storage.countDecisionQuotaCalls({ organismId: "organism-default" })).toBe(1);
    const legacy = await fresh.app.runtime.submitTask(h.submission.input, h.submission.options);
    expect(legacy.state).toBe("succeeded");
    const oldCall = fresh.app.storage.listDecisionCalls(legacy.runId)[0]!;
    expect(JSON.parse(fresh.app.blobs.read(oldCall.requestRef!)).prepared).toBeUndefined();
    expect(fresh.provider.bodies[1]!.messages).toEqual([
      { role: "user", content: "请给出决策 JSON。" },
    ]);
    const legacyBody = fresh.provider.bodies[1]!;
    const legacyCall = rewind(fresh.app, legacy, "prepared");
    const oldReopened = reopen(h.root);
    expect((await oldReopened.app.runtime.executeRun(legacy.runId)).state).toBe("succeeded");
    expect(oldReopened.provider.bodies).toEqual([legacyBody]);
    expect(oldReopened.app.storage.listDecisionCalls(legacy.runId)).toMatchObject([
      { id: legacyCall.id, requestDigest: legacyCall.requestDigest, state: "value" },
    ]);
  });

  it("started/unknown 重启不重发；已完成 Run 恢复不调用模型或重复 worker", async () => {
    const h = fixture();
    const completed = await h.submit();
    const pending = await h.submit();
    const call = rewind(h.app, pending, "started");
    // 模拟节点与 Attempt 已完成、Run 终态尚未提交的崩溃窗口。
    const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
    db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(completed.runId);
    db.close();
    const fresh = reopen(h.root);
    expect((await fresh.app.runtime.executeRun(completed.runId)).state).toBe("succeeded");
    expect(fresh.provider.bodies).toHaveLength(0);
    expect(fresh.app.runtime.getRunSummary(completed.runId).attempts).toHaveLength(1);
    const recovery = await fresh.app.runtime.recoverRun(pending.runId);
    expect(recovery[0]!.action).toBe("waiting_decision");
    expect((await fresh.app.runtime.executeRun(pending.runId)).state).toBe("waiting");
    expect(fresh.app.storage.getDecisionCall(call.id)!.state).toBe("unknown");
    expect(fresh.provider.bodies).toHaveLength(0);
  });

  it("正文被换成另一份有效 blob 仍拒绝恢复；不会以重渲染替代缺失正文", async () => {
    for (const missing of [false, true]) {
      const h = fixture();
      const run = await h.submit();
      const call = rewind(h.app, run, "prepared");
      const stored = JSON.parse(h.app.blobs.read(call.requestRef!));
      if (missing) delete stored.prepared;
      else stored.prepared.body.messages = [];
      const replacement = h.app.blobs.write(canonicalJson(stored));
      const db = new DatabaseSync(join(h.root, "metadata.sqlite"));
      db.prepare("UPDATE decision_calls SET request_ref = ?, request_digest = ? WHERE id = ?").run(
        replacement.ref,
        replacement.digest,
        call.id,
      );
      db.close();
      const fresh = reopen(h.root);
      const result = await fresh.app.runtime.executeRun(run.runId);
      expect(result.failureReason).toBe("decision_request_drift");
      expect(fresh.provider.bodies).toHaveLength(0);
    }
  });

  it("prepared 恢复端点漂移被拒绝；新调用视图不符在额度预留之前拒绝", async () => {
    const h = fixture();
    const run = await h.submit();
    rewind(h.app, run, "prepared");
    const fresh = reopen(h.root, "https://changed-fixture.invalid");
    expect((await fresh.app.runtime.executeRun(run.runId)).failureReason).toBe(
      "decision_request_drift",
    );
    expect(fresh.provider.bodies).toHaveLength(0);
    const mismatch = fixture();
    const wrong = llmDemosFixture({
      base: mismatch.policy.fixed.basePolicy.versionId,
      view: "wrong-view-version",
    });
    const installed = mismatch.install(wrong);
    const rejected = await mismatch.app.runtime.submitTask(mismatch.submission.input, {
      ...mismatch.submission.options,
      snapshotId: installed.snapshot.id,
    });
    expect(rejected.failureReason).toBe("decision_request_invalid");
    expect(mismatch.app.storage.listDecisionCalls(rejected.runId)).toHaveLength(0);
    expect(mismatch.provider.bodies).toHaveLength(0);
  });
});
