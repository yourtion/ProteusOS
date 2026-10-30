import { openInstance } from "../../experiments/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
import { tempInstanceRoot } from "../helpers.ts";
export function bootSeededInstance(root = tempInstanceRoot()) {
  const app = openInstance(root);
  installSeed({ ...app, clock: { now: Date.now } });
  return app;
}
