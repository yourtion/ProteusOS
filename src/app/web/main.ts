import { loadExecutorAdapter } from "../executor-adapter.ts";
import { loadModelAdapter } from "../model-adapter.ts";
import { startWorkbench } from "./server.ts";
const modelAdapter = await loadModelAdapter();
const executorAdapter = await loadExecutorAdapter();
const { buildWorkbenchAssets } = await import("./assets.ts");
await buildWorkbenchAssets();
const server = startWorkbench(
  Number(process.env.PROTEUS_WEB_PORT ?? 4310),
  process.env.PROTEUS_HOME ?? ".proteus-web",
  { modelAdapter, executorAdapter },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void server.shutdown().then(() => process.exit(0));
  });
