import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ObservedCase } from "./observed-plan.ts";

/** Fixed developer-visible cases; individual family labels describe test scenarios. */
export function reliabilityDataset(): ObservedCase[] {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("./reliability-cases.json", import.meta.url)), "utf8"),
  ) as ObservedCase[];
}
