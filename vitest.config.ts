import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never load a real user adapter implicitly during tests or child CLI runs.
    env: { PROTEUS_LOCAL_DIR: join(tmpdir(), `proteus-tests-local-${randomUUID()}`) },
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
