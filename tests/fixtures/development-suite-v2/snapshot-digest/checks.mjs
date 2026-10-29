import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { snapshotDigest } = await import(pathToFileURL(resolve(process.argv[2])).href);
const results = [];
function check(name, test) {
  try {
    test();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}
const a = [
  { slot: "policy", version: { id: "instance-a-policy-v1", contentDigest: "a".repeat(64) } },
  { slot: "worker", version: { id: "instance-a-worker-v1", contentDigest: "b".repeat(64) } },
];
const b = a.map((x) => ({
  slot: x.slot,
  version: { ...x.version, id: x.version.id.replace("instance-a", "instance-b") },
}));
check("same-content-across-instances", () => assert.equal(snapshotDigest(a), snapshotDigest(b)));
check("binding-order-does-not-matter", () =>
  assert.equal(snapshotDigest(a), snapshotDigest([...a].reverse())),
);
check("changed-content-is-distinct", () =>
  assert.notEqual(
    snapshotDigest(a),
    snapshotDigest([
      { ...a[0], version: { ...a[0].version, contentDigest: "c".repeat(64) } },
      a[1],
    ]),
  ),
);
check("changed-slot-is-distinct", () =>
  assert.notEqual(snapshotDigest(a), snapshotDigest([{ ...a[0], slot: "other" }, a[1]])),
);
check("digest-shape", () => assert.match(snapshotDigest(a), /^[0-9a-f]{64}$/));
const passed = results.every((r) => r.passed);
console.log(JSON.stringify({ passed, results }));
process.exitCode = passed ? 0 : 1;
