import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 按内容摘要寻址的不可变 blob 存储。
 * 先写临时对象，校验摘要后原子落位；已存在同摘要内容直接复用。
 */
export class BlobStore {
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(root: string, tmpDir: string) {
    this.root = root;
    this.tmpDir = tmpDir;
  }

  write(content: string): { digest: string; ref: string } {
    const digest = digestOf(content);
    const shard = digest.slice(0, 2);
    const ref = `${shard}/${digest}`;
    const finalPath = join(this.root, ref);
    if (existsSync(finalPath)) return { digest, ref };

    mkdirSync(join(this.root, shard), { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    const tmpPath = join(this.tmpDir, `${digest}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmpPath, content, "utf8");

    const written = readFileSync(tmpPath, "utf8");
    if (digestOf(written) !== digest) {
      throw new Error("blob 写入后摘要校验失败，拒绝落位");
    }
    renameSync(tmpPath, finalPath);
    return { digest, ref };
  }

  read(ref: string): string {
    return readFileSync(join(this.root, ref), "utf8");
  }

  has(ref: string): boolean {
    return existsSync(join(this.root, ref));
  }
}

export function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 稳定序列化：键排序，保证同内容同摘要（版本与快照幂等的基石） */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
