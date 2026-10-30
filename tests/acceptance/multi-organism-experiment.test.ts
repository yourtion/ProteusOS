import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  runExperiment,
  type RunExperimentOptions,
  type TrialRow,
} from "../../experiments/protocols/runner.ts";
import { generateReport } from "../../experiments/protocols/reporter.ts";
import { openInstance } from "../../src/app/instance.ts";
import { MIGRATIONS } from "../../src/storage/migrations.ts";
import { SqliteDb } from "../../src/storage/sqlite.ts";
import { CAPABILITY_MODULE } from "../fixtures/decision/harness.ts";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

it("same-home experiments keep actor, runs, quotas and report evidence within each organism", async () => {
  const home = tempInstanceRoot();
  const outputA = mkdtempSync(join(tmpdir(), "proteus-exp-owner-a-"));
  const outputB = mkdtempSync(join(tmpdir(), "proteus-exp-owner-b-"));
  const base: RunExperimentOptions = {
    home,
    outDir: outputA,
    datasetDir: join(REPO_ROOT, "tests/fixtures/decision/plumbing"),
    organismId: "exp-org-a",
    actorId: "exp-owner-a",
    experimentId: "same-experiment-id",
    llm: "fake",
    arms: ["L"],
    repeats: 1,
    seed: 42,
    organismCallLimit: 100,
    experimentCallLimit: 40,
    wallClockLimitMs: 60_000,
    capabilityModulePath: CAPABILITY_MODULE,
    withOracle: false,
  };
  expect((await runExperiment(base)).status).toBe("complete");
  expect(
    (
      await runExperiment({
        ...base,
        outDir: outputB,
        organismId: "exp-org-b",
        actorId: "exp-owner-b",
      })
    ).status,
  ).toBe("complete");
  const app = openInstance(home, { organismId: "exp-org-a", actorId: "exp-owner-a" });
  try {
    for (const [dir, organismId, actorId] of [
      [outputA, "exp-org-a", "exp-owner-a"],
      [outputB, "exp-org-b", "exp-owner-b"],
    ]) {
      expect(JSON.parse(readFileSync(join(dir!, "manifest.json"), "utf8"))).toMatchObject({
        organismId,
        actorId,
      });
      const rows = readFileSync(join(dir!, "trials.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as TrialRow);
      expect(rows).toHaveLength(40);
      for (const row of rows) {
        const run = app.storage.getRun(row.runId)!;
        expect(run.organismId).toBe(organismId);
        expect(app.storage.getTask(run.taskId)!.requestedBy).toBe(actorId);
      }
      expect(
        app.storage.countDecisionQuotaCalls({
          organismId: organismId!,
          experimentId: base.experimentId,
        }),
      ).toBe(40);
      expect(
        generateReport({
          dir: dir!,
          storage: app.storage,
          blobs: app.blobs,
          datasetDir: base.datasetDir,
          organismId,
        }).engineering,
      ).toBe("passed");
    }
    app.storage.setDecisionCallLimit(
      { organismId: "exp-org-a", experimentId: base.experimentId },
      1,
      Date.now(),
    );
    expect(
      app.storage.getDecisionCallLimit({
        organismId: "exp-org-b",
        experimentId: base.experimentId,
      }),
    ).toBe(40);
    expect(() =>
      generateReport({
        dir: outputB,
        storage: app.storage,
        datasetDir: null,
        organismId: "exp-org-a",
      }),
    ).toThrow("实验报告属于其他个体");
  } finally {
    app.close();
  }
  const before = readFileSync(join(outputA, "manifest.json"), "utf8");
  expect(
    (await runExperiment({ ...base, organismId: "exp-org-b", actorId: "exp-owner-b" })).status,
  ).toBe("preflight_failed");
  expect(readFileSync(join(outputA, "manifest.json"), "utf8")).toBe(before);
});

it("migrates legacy experiment quotas to the default organism without losing their limits", () => {
  const home = tempInstanceRoot();
  const db = new SqliteDb(join(home, "metadata.sqlite"));
  db.migrate(MIGRATIONS.filter((m) => m.version <= 10));
  db.run(
    "INSERT INTO decision_call_limits VALUES (?, ?, ?)",
    "experiment:legacy-exp",
    7,
    Date.now(),
  );
  db.close();
  const app = openInstance(home);
  try {
    expect(
      app.storage.getDecisionCallLimit({
        organismId: "organism-default",
        experimentId: "legacy-exp",
      }),
    ).toBe(7);
    expect(
      app.storage.getDecisionCallLimit({
        organismId: "another-organism",
        experimentId: "legacy-exp",
      }),
    ).toBeUndefined();
  } finally {
    app.close();
  }
});
