import { loadAppAdapters } from "../adapters.ts";
import { startWorkbench } from "./server.ts";
const adapters = await loadAppAdapters();
const { buildWorkbenchAssets } = await import("./assets.ts");
await buildWorkbenchAssets();
const server = startWorkbench(
  Number(process.env.PROTEUS_WEB_PORT ?? 4310),
  process.env.PROTEUS_HOME ?? ".proteus-web",
  adapters,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void server.shutdown().then(() => process.exit(0));
  });
