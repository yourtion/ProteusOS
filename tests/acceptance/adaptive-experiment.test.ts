import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  adaptiveDevelopmentTasks,
  adaptiveTask,
  adaptiveUnits,
  freezeAdaptivePlan,
  reportAdaptiveExperiment,
  selectAdaptiveChoice,
  type AdaptiveObservation,
} from "../../experiments/protocols/adaptive.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import {
  rehearsalObservations,
  rehearsalPlan,
  rehearsalTask,
} from "../fixtures/adaptive-behavior/rehearsal.ts";
import { bootExperimentHarness, experimentSubmission } from "../fixtures/decision/harness.ts";
import { fixturePath } from "../helpers.ts";

it(
  "三臂 fixture 演练：真实本地 worker、fake 决策、隔离标签、冻结证据与只读复算",
  { timeout: 60_000 },
  async () => {
    const { inst, genomes, fake } = bootExperimentHarness();
    const out = mkdtempSync(join(tmpdir(), "proteus-adaptive-"));
    try {
      fake.resetQueue({ type: "value", value: "local-process" });
      const original = rehearsalPlan().plan;
      const now = Date.now();
      original.developmentClosedAt = now;
      original.frozenAt = now;
      const expectedByCase = new Map<string, string>();
      for (const c of original.cases) {
        const bytes = Buffer.byteLength(rehearsalTask(c.id).inputs[0]!.content);
        const expected = canonicalJson({
          files: [{ path: "file-a.md", bytes, lines: 2, words: 5, headings: 1 }],
          totals: { files: 1, bytes, lines: 2, words: 5, headings: 1 },
        });
        expectedByCase.set(c.id, expected);
        c.evaluatorDigest = digestOf(expected);
      }
      const frozen = freezeAdaptivePlan(original);
      const activeBefore = inst.kernel.getOrganism("organism-default")!.activeGenomeId;
      const loaded: string[] = [];
      adaptiveDevelopmentTasks(frozen, (id) => {
        loaded.push(id);
        return rehearsalTask(id);
      });
      expect(loaded.every((id) => /^(train|search)-/.test(id))).toBe(true);

      const observations: AdaptiveObservation[] = rehearsalObservations(frozen).filter((r) =>
        r.unitId.startsWith("development-"),
      );
      observations.forEach((row, i) =>
        Object.assign(row, { startedAt: now - 50 + i * 10, endedAt: now - 45 + i * 10 }),
      );
      for (const unit of adaptiveUnits(frozen.plan).filter((u) => u.repeat > 0)) {
        // 显式白名单之后，输入目录只写任务文件；gold 在其外并仅交给可信裁判。
        const task = adaptiveTask(frozen, unit.caseId, {
          ...rehearsalTask(unit.caseId),
          expectedChoice: "GOLD_SENTINEL",
          familyId: "PRIVATE_FAMILY",
          split: "formal",
        });
        const taskDir = join(out, `input-${unit.caseId}`);
        mkdirSync(taskDir, { recursive: true });
        for (const file of task.inputs) writeFileSync(join(taskDir, file.name), file.content);
        const expectedFile = join(out, `private-${unit.caseId}.json`);
        const expected = expectedByCase.get(unit.caseId)!;
        expect(digestOf(expected)).toBe(
          frozen.plan.cases.find((c) => c.id === unit.caseId)!.evaluatorDigest,
        );
        writeFileSync(expectedFile, expected);
        const runIds: string[] = [];
        const refs: string[] = [];
        const choices: Array<string | null> = [];
        const accepted: boolean[] = [];
        const startedAt = Date.now();
        // 候选臂仍用现有冻结策略演练管道；未实现编译器，也不宣称编译收益。
        for (let i = 0; i < unit.allowance.modelCalls; i++) {
          const submission = experimentSubmission({
            goal: task.goal,
            inputs: task.inputs.map((file) => join(taskDir, file.name)),
            genomes,
            schema: fixturePath("schemas", "stats-summary.schema.json"),
            expected: expectedFile,
            experimentId: "adaptive-fixture",
          });
          const run = await inst.runtime.submitTask(submission.input, submission.options);
          expect(run.state, JSON.stringify(run.checks)).toBe("succeeded");
          const calls = inst.storage.listDecisionCalls(run.runId);
          expect(calls).toHaveLength(1);
          expect(run.attempts[0]!.evidence).toMatchObject({
            traceStatus: "complete",
            traceCoverage: "lifecycle",
          });
          runIds.push(run.runId);
          refs.push(
            `run:${run.runId}`,
            `decision:${calls[0]!.id}`,
            ...run.attempts.map((a) => `attempt:${a.id}`),
          );
          choices.push(run.decisions[0]?.value ?? null);
          accepted.push(run.state === "succeeded");
        }
        const selected = selectAdaptiveChoice(choices);
        const index = choices.indexOf(selected);
        observations.push({
          unitId: unit.id,
          manifestDigest: frozen.digest,
          source: "fixture",
          startedAt,
          endedAt: Date.now(),
          state: "succeeded",
          accepted: selected !== null && accepted[index]!,
          decision: selected === null ? "model_abstain" : "value",
          misrouted: selected !== "local-process",
          evidenceRefs: refs,
          // fake 未提供 tokens 或费用；执行器用量也不可用，不推断零费用。
          usage: {
            modelCalls: runIds.length,
            inputTokens: null,
            outputTokens: null,
            costAmount: null,
            costCurrency: null,
            priceRef: null,
          },
        });
      }
      const report = reportAdaptiveExperiment(frozen, observations);
      expect(report).toMatchObject({
        engineering: "passed",
        realModel: "not_run",
        benefit: "not_evaluated",
        qualityGate: false,
      });
      expect(report.arms.compiled.formal).toMatchObject({
        families: 2,
        planned: 6,
        successRate: 1,
      });
      expect(report.resources.modelCalls).toEqual({ knownTotal: 64, unknownUnits: 0 });
      expect(report.resources.inputTokens.unknownUnits).toBe(36);
      expect(report.resources.unknownCostUnits).toBe(40);
      expect(fake.capturedRequests).toHaveLength(60);
      expect(JSON.stringify(fake.capturedRequests)).not.toMatch(
        /GOLD_SENTINEL|PRIVATE_FAMILY|private-|expectedChoice|expectedOutput|familyId/,
      );
      expect(inst.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(activeBefore);
      writeFileSync(join(out, "manifest.json"), JSON.stringify(frozen));
      writeFileSync(join(out, "observations.json"), JSON.stringify(observations));
      writeFileSync(join(out, "report.json"), JSON.stringify(report));
      const requestsBefore = fake.capturedRequests.length;
      expect(
        reportAdaptiveExperiment(
          JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")),
          JSON.parse(readFileSync(join(out, "observations.json"), "utf8")),
        ),
      ).toEqual(JSON.parse(readFileSync(join(out, "report.json"), "utf8")));
      expect(fake.capturedRequests).toHaveLength(requestsBefore);
    } finally {
      inst.close();
    }
  },
);
