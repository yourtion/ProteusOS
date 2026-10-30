import {
  openInstance as openCoreInstance,
  type AppInstance as CoreInstance,
} from "../src/app/instance.ts";
import { ExperimentStorage } from "./storage.ts";
import { PRINCIPAL_ID, ORGANISM_ID } from "../src/app/seed.ts";
import { v7 as uuidv7 } from "uuid";
import { AdaptiveJournal } from "./protocols/journal.ts";
import { AdaptiveRunSlots } from "./protocols/run-slots.ts";
import { guardObservedRun } from "./protocols/observed.ts";
import { guardDiagnosticRun } from "./protocols/diagnostic.ts";
import { bindCompileDevelopment } from "./protocols/development.ts";
export type AppInstance = CoreInstance<ExperimentStorage> & {
  adaptive: AdaptiveJournal;
  adaptiveRuns: AdaptiveRunSlots;
};
export function openInstance(
  root: string,
  options: Parameters<typeof openCoreInstance>[1] = {},
): AppInstance {
  let instance: AppInstance;
  const core = openCoreInstance(root, {
    ...options,
    storageFactory: (db) => new ExperimentStorage(db),
    runGuard: (run, phase) => {
      options.runGuard?.(run, phase);
      instance.adaptiveRuns.guard(run, phase);
      guardObservedRun(instance, run, phase);
      guardDiagnosticRun(instance, run, phase);
    },
  });
  const { storage, kernel, blobs, runtime, evolution } = core;
  const clock = { now: () => Date.now() };
  const ids = { next: () => uuidv7() };
  const organismId = options.organismId ?? ORGANISM_ID;
  const actorId = options.actorId ?? PRINCIPAL_ID;
  let adaptiveRuns: AdaptiveRunSlots;
  const adaptive = new AdaptiveJournal({
    readRunReceipt: (id, reservationId) => adaptiveRuns.deriveReceipt(id, reservationId),
    kernel,
    storage,
    blobs,
    clock,
    ids,
    organismId,
    actorId,
    bindCompilation: (jobId, frozen) =>
      bindCompileDevelopment(
        { kernel, runtime, evolution, storage, blobs, organismId, actorId },
        jobId,
        frozen,
      ),
  });
  adaptiveRuns = new AdaptiveRunSlots({
    kernel,
    storage,
    blobs,
    clock,
    organismId,
    actorId,
    runtime,
    journal: adaptive,
  });
  instance = { ...core, adaptive, adaptiveRuns };
  return instance;
}
export { buildExecutors, buildDecisions, resolveInstanceRoot } from "../src/app/instance.ts";
