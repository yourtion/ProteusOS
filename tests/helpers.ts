import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openInstance, type AppInstance } from "../src/app/instance.ts";
import { installSeed, canonicalJson } from "../src/app/seed.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures/stats", import.meta.url));
export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

export function tempInstanceRoot(): string {
  return mkdtempSync(join(tmpdir(), "proteos-test-"));
}

/** 建临时实例并安装 seed（每次调用都是干净实例） */
export function bootSeededInstance(root: string = tempInstanceRoot()): AppInstance {
  const inst = openInstance(root);
  installSeed({
    kernel: inst.kernel,
    storage: inst.storage,
    blobs: inst.blobs,
    clock: { now: Date.now },
  });
  return inst;
}

/** 以当前快照为基准注册新版本并 CAS 安装为默认（测试用自定义图/策略/验收器） */
export function installCustomGenome(
  inst: AppInstance,
  overrides: { graph?: object; policy?: object; evaluator?: object },
): void {
  const organism = inst.kernel.getOrganism("organism-default")!;
  const { snapshot, versions } = inst.kernel.resolveSnapshot(organism.activeGenomeId!);
  inst.storage.tx(() => {
    const bindings = { ...snapshot.bindings };
    const slots: Array<["task-graph" | "routing-policy", object | undefined]> = [
      ["task-graph", overrides.graph],
      ["routing-policy", overrides.policy],
    ];
    for (const [slot, content] of slots) {
      if (!content) continue;
      const current = versions.get(slot)!;
      const artifact = inst.storage.getArtifact(current.artifactId)!;
      const { digest, ref } = inst.blobs.write(canonicalJson(content));
      const version = inst.kernel.registerVersion({
        artifact,
        schemaVersion: 2,
        contentDigest: digest,
        contentRef: ref,
        parents: [current.id],
        dependencies: [],
        createdBy: "test",
      });
      bindings[slot] = version.id;
    }
    if (overrides.evaluator) {
      // 新验收器 artifact（kind = acceptance-evaluator 槽位）
      inst.storage.insertArtifact({
        id: "coding-acceptance",
        kind: "acceptance-evaluator",
        lineageId: "lineage-seed",
        ownerId: "principal-local",
        createdAt: Date.now(),
      });
      const artifact = inst.storage.getArtifact("coding-acceptance")!;
      const { digest, ref } = inst.blobs.write(canonicalJson(overrides.evaluator));
      const version = inst.kernel.registerVersion({
        artifact,
        schemaVersion: 2,
        contentDigest: digest,
        contentRef: ref,
        parents: [],
        dependencies: [],
        createdBy: "test",
      });
      bindings["acceptance-evaluator"] = version.id;
    }
    const next = inst.kernel.createSnapshot(bindings, "test");
    const fresh = inst.kernel.getOrganism("organism-default")!;
    const result = inst.kernel.installAsActive("organism-default", next.id, fresh.revision);
    if (!result.ok) throw new Error("测试装配 CAS 冲突");
  });
}
