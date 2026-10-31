import { loadModelAdapter } from "./model-adapter.ts";
import { loadExecutorAdapter } from "./executor-adapter.ts";
import { loadRuntimeAdapter } from "./runtime-adapter.ts";

export interface AdapterOptions {
  modelAdapter?: string;
  executorAdapter?: string;
  executorsConfig?: string;
  runtimeAdapter?: string;
}

/** One composition path for CLI, sharing commands and both Web entry points. */
export async function loadAppAdapters(options: AdapterOptions = {}) {
  const modelAdapter = await loadModelAdapter(options.modelAdapter);
  const executorAdapter = await loadExecutorAdapter(
    options.executorsConfig ?? options.executorAdapter,
  );
  const runtimeAdapter = await loadRuntimeAdapter(options.runtimeAdapter, modelAdapter);
  return { modelAdapter, executorAdapter, runtimeAdapter };
}
