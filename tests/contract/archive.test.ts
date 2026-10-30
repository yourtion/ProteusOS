import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractArchive } from "../../experiments/archive.ts";
it("checks archive hashes and rejects link members before publishing any output", () => {
  const root = mkdtempSync(join(tmpdir(), "proteus-archive-test-"));
  try {
    const inputs = join(root, "inputs");
    mkdirSync(inputs);
    writeFileSync(join(inputs, "report.json"), "{}");
    const archive = join(root, "archive.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", inputs, "."]);
    const identity = () => {
      const bytes = readFileSync(archive);
      return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    expect(() =>
      extractArchive(archive, { ...identity(), sha256: "0".repeat(64) }, join(root, "bad")),
    ).toThrow("checksum");
    extractArchive(archive, identity(), join(root, "good"));
    expect(readFileSync(join(root, "good/report.json"), "utf8")).toBe("{}");
    symlinkSync("../outside", join(inputs, "link"));
    execFileSync("tar", ["-czf", archive, "-C", inputs, "."]);
    expect(() => extractArchive(archive, identity(), join(root, "unsafe"))).toThrow();
    expect(existsSync(join(root, "unsafe"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
