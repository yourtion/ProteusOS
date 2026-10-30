import { readFileSync } from "node:fs";
import { archivePath, extractArchive, type ArchiveRecord } from "../experiments/archive.ts";
const records = JSON.parse(
  readFileSync(new URL("../docs/experiments/archives.json", import.meta.url), "utf8"),
) as ArchiveRecord[];
const args = process.argv.slice(2);
if (args.length === 0) {
  for (const record of records) archivePath(record.id);
  console.log(`Verified ${records.length} external archives`);
} else if (args.length === 3 && args[0] === "--extract") {
  const record = records.find((r) => r.id === args[1]);
  if (!record) throw new Error("unknown archive");
  extractArchive(archivePath(record.id), record, args[2]!);
  console.log(`Extracted verified archive ${record.id}`);
} else throw new Error("Usage: verify-archives.ts [--extract ID NEW_DIRECTORY]");
