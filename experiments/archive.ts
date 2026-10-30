import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export interface ArchiveRecord {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  sourcePath: string;
  sourceCommit: string;
}
export function verifyArchive(path: string, expected: Pick<ArchiveRecord, "bytes" | "sha256">) {
  const data = readFileSync(path);
  if (
    data.length !== expected.bytes ||
    createHash("sha256").update(data).digest("hex") !== expected.sha256
  )
    throw new Error("archive checksum mismatch");
}
export function archivePath(id: string, root = process.env.PROTEUS_EVIDENCE_ROOT) {
  if (!root) throw new Error("Set PROTEUS_EVIDENCE_ROOT to an external evidence directory");
  const records = JSON.parse(
    readFileSync(new URL("../docs/experiments/archives.json", import.meta.url), "utf8"),
  ) as ArchiveRecord[];
  const entry = records.find((r) => r.id === id);
  if (!entry || !/^[a-z0-9-]+$/.test(entry.id) || entry.file !== "evidence.tar.gz")
    throw new Error("unknown archive");
  const path = join(resolve(root), entry.id, entry.file);
  verifyArchive(path, entry);
  return path;
}
export function extractArchive(
  path: string,
  expected: Pick<ArchiveRecord, "bytes" | "sha256">,
  output: string,
) {
  verifyArchive(path, expected);
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error("archive output already exists");
  const staging = mkdtempSync(join(dirname(destination), ".proteus-extract-"));
  try {
    execFileSync(
      "python3",
      [fileURLToPath(new URL("./extract-archive.py", import.meta.url)), path, staging],
      { timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
