import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stageHarness, STAGE_SCENARIOS } from "../fixtures/adaptive-behavior/stage-harness.ts";

it.each(STAGE_SCENARIOS)(
  "编译→来源绑定→三臂→原始结案→清理复算：%s",
  { timeout: 60000 },
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "proteus-stage-"));
    const h = await stageHarness(root, scenario);
    try {
      let failure: unknown;
      try {
        await h.run();
      } catch (error) {
        failure = error;
      }
      const report = h.app.adaptive.report(h.job.id);
      expect(h.app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(h.activeBefore);
      expect(h.app.evolution.validationSet(h.validationSetId).usageCount).toBe(0);
      expect(report.report).toMatchObject({
        realModel: "not_run",
        benefit: "not_evaluated",
        formalEvaluation: "not_run",
      });
      expect(JSON.stringify(h.provider.bodies)).not.toMatch(
        /PUBLIC_FIXTURE_ROUTE_LABELS|expectedChoice|private-expected|stage-formal-family|stage-regression-family/,
      );
      if (scenario === "interrupted") {
        expect(String(failure)).toContain("interrupted");
        expect(report.job.state).toBe("failed");
        expect(report.report.engineering).toBe("incomplete");
        expect(report.observations.at(-1)!.state).toBe("unknown");
        expect(report.evidence!.runtimeResources.modelCalls.knownTotal).toBe(
          h.provider.bodies.length,
        );
        expect(h.provider.bodies).toHaveLength(7);
      } else {
        expect(failure).toBeUndefined();
        expect(report.job.state).toBe("completed");
        expect(report.report.engineering).toBe("passed");
        expect(report.report.evidenceVerification).toBe(
          "persisted-development-and-runtime-records",
        );
        expect(report.evidence!.receipts).toHaveLength(36);
        expect(report.evidence!.runtimeResources.modelCalls).toEqual({
          knownTotal: 60,
          unknownItems: 60,
        });
        expect(h.provider.bodies).toHaveLength(60);
        expect(report.report.arms.compiled.formal.successRate).toBe(1);
        expect(report.report.arms.single.formal.successRate).toBe(
          scenario === "no-improvement" ? 1 : 0,
        );
        expect(report.report.qualityGate).toBe(scenario === "improvement");
        expect(report.report.arms.compiled.regression.successRate).toBe(
          scenario === "regression" ? 0 : 1,
        );
        if (scenario === "regression") expect(report.report.criticalFailures).toHaveLength(6);
      }
      const sent = h.provider.requests.length;
      await h.run();
      expect(h.provider.requests).toHaveLength(sent);
      const replay = h.cleanAndReplay();
      expect(replay.after).toEqual(replay.before);
    } finally {
      h.app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
