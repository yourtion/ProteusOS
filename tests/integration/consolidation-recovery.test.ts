import { expect, it } from "vitest";
import { bootSeededInstance } from "../helpers.ts";

it("operator recovery preserves uncertain learning quota and never redispatches interrupted jobs", async () => {
  const app = bootSeededInstance();
  try {
    const { dataset } = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const { job } = app.evolution.submitConsolidationJob({
      datasetId: dataset.id,
      mode: "llm",
      createdBy: "principal-local",
    });
    app.storage.tx(() => {
      app.storage.setLearningCallLimit("organism-default", 1);
      app.storage.updateConsolidationJob(job.id, { state: "running", updatedAt: Date.now() });
      app.storage.insertLearningCall({
        id: "interrupted-model-call",
        organismId: "organism-default",
        jobId: job.id,
        state: "reserved",
        usage: null,
        error: null,
        createdAt: Date.now(),
        endedAt: null,
      });
    });
    expect(app.evolution.recoverConsolidationJobs()).toEqual([{ jobId: job.id, state: "failed" }]);
    expect(app.evolution.consolidationJob(job.id).error).toContain("不自动重发");
    expect(app.storage.learningCalls("organism-default")).toMatchObject([
      { state: "unknown", usage: null },
    ]);
    expect(app.storage.learningCallLimit("organism-default")).toBe(1);
    expect(app.evolution.recoverConsolidationJobs()).toEqual([]);
    expect(await app.evolution.runPendingConsolidationJobs()).toEqual([]);
    expect(app.storage.learningCalls("organism-default")).toHaveLength(1);
  } finally {
    app.close();
  }
});
