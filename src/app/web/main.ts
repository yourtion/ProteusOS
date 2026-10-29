import { startWorkbench } from "./server.ts";
const server = startWorkbench(
  Number(process.env.PROTEUS_WEB_PORT ?? 4310),
  process.env.PROTEUS_HOME ?? ".proteus-web",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void server.shutdown().then(() => process.exit(0));
  });
