import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const target = process.argv[2];
if (!target) throw new Error("Usage: node checks.mjs /absolute/path/to/src/evolution/assets.ts");
const { ensureCapabilityGenome, makeCapabilityGraphContent, makeCapabilityPolicyContent } =
  await import(pathToFileURL(target).href);
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

// All domain ports below are deterministic in-memory values. No filesystem storage is used.
function compose(existing, added) {
  let seq = 0;
  const artifacts = new Map(),
    versions = new Map(),
    contents = new Map(),
    snapshots = new Map();
  const core = ["task-graph", "routing-policy", "acceptance-evaluator"];
  const baseBindings = {};
  for (const slot of [
    ...core,
    ...existing.map((name) => `capability/${name}`),
    "private-metadata",
  ]) {
    const artifact = {
      id: slot,
      kind: slot,
      lineageId: "lineage-base",
      ownerId: "owner",
      createdAt: 1,
    };
    artifacts.set(slot, artifact);
    const version = {
      id: `base:${slot}`,
      artifactId: slot,
      contentDigest: "a".repeat(64),
      contentRef: `base/${slot}`,
      parents: [],
      dependencies: [],
      schemaVersion: 1,
      createdBy: "owner",
      createdAt: 1,
    };
    versions.set(version.id, version);
    baseBindings[slot] = version.id;
  }
  snapshots.set("base", {
    id: "base",
    bindings: baseBindings,
    digest: "b".repeat(64),
    createdAt: 1,
    createdBy: "owner",
  });
  const deps = {
    clock: { now: () => 2 },
    blobs: {
      write: (content) => {
        const digest = createHash("sha256").update(content).digest("hex");
        contents.set(digest, JSON.parse(content));
        return { digest, ref: digest };
      },
    },
    storage: {
      tx: (fn) => fn(),
      insertArtifact: (artifact) => artifacts.set(artifact.id, artifact),
      getArtifact: (id) => artifacts.get(id),
    },
    kernel: {
      createLineage: () => {},
      resolveSnapshot: (id) => {
        const snapshot = snapshots.get(id);
        assert.ok(snapshot);
        return {
          snapshot,
          versions: new Map(
            Object.entries(snapshot.bindings).map(([slot, id]) => [slot, versions.get(id)]),
          ),
        };
      },
      registerVersion: (input) => {
        const version = {
          ...input,
          artifactId: input.artifact.id,
          id: `derived:${++seq}`,
          createdAt: 2,
        };
        versions.set(version.id, version);
        return version;
      },
      createSnapshot: (bindings) => {
        const snapshot = {
          id: `snapshot:${++seq}`,
          bindings: { ...bindings },
          digest: "c".repeat(64),
          createdBy: "owner",
          createdAt: 2,
        };
        snapshots.set(snapshot.id, snapshot);
        return snapshot;
      },
    },
  };
  const result = ensureCapabilityGenome(deps, {
    baseSnapshotId: "base",
    capabilities: added.map((name) => ({
      name,
      module: {
        kind: "capability-module-v1",
        name,
        entry: `src/${name}.mjs`,
        files: [
          { path: `src/${name}.mjs`, content: "export const execute = () => ({ ok: true });" },
        ],
      },
    })),
    createdBy: "owner",
  });
  const contentOf = (slot) => contents.get(result.versions.get(slot).contentRef);
  return {
    result,
    graph: contentOf("task-graph"),
    policy: contentOf("routing-policy"),
    baseBindings,
    snapshots,
    versions,
  };
}
function options(value) {
  return value.graph.nodes.find((node) => node.id === "route").options;
}
function choices(value) {
  return value.policy.routes.map((route) => route.choose);
}
check("regression: first capability keeps local-process fallback and graph dependencies", () => {
  const value = compose([], ["summarize"]);
  assert.deepEqual(options(value), ["local-process", "capability/summarize"]);
  assert.deepEqual(choices(value), ["capability/summarize", "local-process"]);
  assert.deepEqual(value.graph.nodes.find((node) => node.id === "work").dependsOn, ["route"]);
  assert.equal(
    value.result.snapshot.bindings["private-metadata"],
    value.baseBindings["private-metadata"],
  );
});
check("bug: second capability retains both prior and new routes", () => {
  const value = compose(["summarize"], ["translate"]);
  assert.deepEqual(options(value), [
    "local-process",
    "capability/summarize",
    "capability/translate",
  ]);
  assert.deepEqual(choices(value), [
    "capability/summarize",
    "capability/translate",
    "local-process",
  ]);
  assert.equal(
    value.result.snapshot.bindings["capability/summarize"],
    value.baseBindings["capability/summarize"],
  );
  assert.ok(value.result.snapshot.bindings["capability/translate"]);
});
check("bug: composing without an increment keeps prior routes usable", () => {
  const value = compose(["translate", "summarize"], []);
  assert.deepEqual(options(value), [
    "local-process",
    "capability/summarize",
    "capability/translate",
  ]);
  assert.deepEqual(choices(value), [
    "capability/summarize",
    "capability/translate",
    "local-process",
  ]);
});
check("bug: replacing an existing capability does not duplicate or reorder routes", () => {
  const value = compose(["zeta", "alpha"], ["zeta", "beta"]);
  assert.deepEqual(options(value), [
    "local-process",
    "capability/alpha",
    "capability/beta",
    "capability/zeta",
  ]);
  assert.equal(new Set(choices(value)).size, choices(value).length);
  assert.notEqual(
    value.result.snapshot.bindings["capability/zeta"],
    value.baseBindings["capability/zeta"],
  );
});
check("regression: graph and policy templates preserve empty capability fallback", () => {
  assert.deepEqual(makeCapabilityGraphContent([]).nodes[0].options, ["local-process"]);
  assert.deepEqual(makeCapabilityPolicyContent([]).routes, [
    { when: { nodeType: "execute" }, choose: "local-process" },
  ]);
});
const summary = {
  passed: results.every((r) => r.passed),
  failed: results.filter((r) => !r.passed).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed ? 1 : 0;
