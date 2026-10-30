import { expect, it } from "vitest";
import { reliabilityDataset } from "../../experiments/protocols/reliability-data.ts";
import { diagnosticDataset } from "../../experiments/protocols/diagnostic-data.ts";

it("新资料按场景冻结且不重复此前开发目标", () => {
  const cases = reliabilityDataset();
  const prior = new Set(
    [...diagnosticDataset("matrix"), ...diagnosticDataset("confirmation")].map((c) => c.task.goal),
  );
  expect(cases).toHaveLength(20);
  expect(new Set(cases.map((c) => c.id)).size).toBe(20);
  expect(new Set(cases.map((c) => c.task.goal)).size).toBe(20);
  expect(cases.every((c) => !prior.has(c.task.goal) && c.split === "search")).toBe(true);
  const families = new Set(cases.map((c) => c.familyId));
  expect(families.size).toBe(10);
  expect([...families].every((f) => cases.filter((c) => c.familyId === f).length === 2)).toBe(true);
  expect(cases.filter((c) => c.expectedChoice === "local-process")).toHaveLength(10);
  expect(cases.filter((c) => c.critical).length).toBeGreaterThanOrEqual(4);
});
