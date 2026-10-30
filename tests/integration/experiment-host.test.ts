import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openInstance as productInstance } from "../../src/app/instance.ts";
import { openInstance as experimentInstance } from "../../experiments/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
it("requires explicit host constraints when admitting or resuming a grouped Run", async () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-host-contract-"));
  let app = experimentInstance(root);
  try {
    installSeed({ ...app, clock: { now: Date.now } });
    const inputs = join(root, "materials");
    mkdirSync(inputs);
    writeFileSync(join(inputs, "note.md"), "hello\n");
    const task = {
      requestedBy: "principal-local",
      goal: "stats",
      inputs: [inputs],
      budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
      acceptance: {
        outputSchema: fileURLToPath(
          new URL("../../src/resources/stats-summary.schema.json", import.meta.url),
        ),
        verifier: "stats-acceptance",
      },
    };
    const receipt = app.runtime.admitTask(task, { experimentId: "fixture-host" });
    app.close();
    const product = productInstance(root);
    try {
      expect(() => product.runtime.admitTask(task, { experimentId: "fixture-host" })).toThrow(
        "constraints",
      );
      await expect(product.runtime.executeRun(receipt.runId)).rejects.toThrow("constraints");
      expect(product.storage.getRun(receipt.runId)?.state).toBe("pending");
    } finally {
      product.close();
    }
    app = experimentInstance(root);
    expect((await app.runtime.executeRun(receipt.runId)).state).toBe("succeeded");
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
