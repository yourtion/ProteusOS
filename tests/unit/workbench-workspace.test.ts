import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  applyChangeSet,
  capture,
  changes,
  contextProjection,
  fileBytes,
  materialize,
  readOutput,
  readProject,
} from "../../src/workspace/index.ts";
function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "proteus-workspace-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it("materializes binary inputs, large text and executable modes independently of text projection", () =>
  fixture((root) => {
    const binary = Buffer.alloc(1024 * 1024 + 1);
    writeFileSync(join(root, "evidence.tar.gz"), binary);
    writeFileSync(join(root, "script.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "script.sh"), 0o755);
    writeFileSync(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
    execFileSync("git", ["-C", root, "add", "."]);
    const snapshot = capture(root);
    expect(snapshot.context.find((f) => f.path === "evidence.tar.gz")?.omitted).toBe("binary");
    expect(snapshot.context.find((f) => f.path === "large.txt")?.omitted).toBe("context-budget");
    const out = join(root, "execution");
    materialize(out, snapshot.files);
    expect(readFileSync(join(out, "evidence.tar.gz"))).toEqual(binary);
    expect(statSync(join(out, "script.sh")).mode & 0o777).toBe(0o755);
    expect(changes(snapshot.files, readOutput(out))).toEqual([]);
    writeFileSync(join(out, "evidence.tar.gz"), Buffer.from([255, 0, 1]));
    const diff = changes(snapshot.files, readOutput(out));
    expect(diff).toHaveLength(1);
    expect(diff[0]!.afterFile?.encoding).toBe("base64");
  }));
it("keeps context bounded and preserves exact UTF-8 bytes", () => {
  const files = { "a.ts": "你好", "b.ts": "more" };
  expect(contextProjection(files, 6)[1]!.omitted).toBe("context-budget");
  expect(fileBytes(files["a.ts"]).length).toBe(6);
});
it("rejects execution quota excess, symlinks and restricted output instead of dropping them", () =>
  fixture((root) => {
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(() => readProject(root)).toThrow("8 MiB");
    rmSync(join(root, "huge.bin"));
    writeFileSync(join(root, ".env.generated"), "secret");
    expect(() => readOutput(root)).toThrow("受限文件");
  }));

it("rolls back bytes after a failed receipt and preserves concurrent edits for recovery", () =>
  fixture((root) => {
    writeFileSync(join(root, "a.bin"), Buffer.from([0, 255]));
    writeFileSync(join(root, "b.txt"), "before");
    const snapshot = capture(root);
    const after = {
      ...snapshot.files,
      "a.bin": {
        encoding: "base64" as const,
        data: Buffer.from([0, 128]).toString("base64"),
        mode: 0o644,
      },
      "b.txt": "after",
    };
    const diff = changes(snapshot.files, after);
    const states: string[] = [];
    expect(() =>
      applyChangeSet(root, snapshot.manifest, diff, (state) => {
        states.push(state);
        if (state === "applied") throw new Error("receipt failure");
      }),
    ).toThrow("receipt failure");
    expect(states.at(-1)).toBe("rolled-back");
    expect(readFileSync(join(root, "a.bin"))).toEqual(Buffer.from([0, 255]));
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("before");
    expect(() =>
      applyChangeSet(root, snapshot.manifest, diff, (state) => {
        states.push(state);
        if (state === "applied") {
          writeFileSync(join(root, "a.bin"), "user edit");
          throw new Error("crash");
        }
      }),
    ).toThrow("crash");
    expect(states.at(-1)).toBe("needs-recovery");
    expect(readFileSync(join(root, "a.bin"), "utf8")).toBe("user edit");
  }));
