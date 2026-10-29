import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { parseCapabilityModule, capabilityModuleDir } = await import(
  pathToFileURL(resolve(process.argv[2])).href
);
const results = [];
function check(name, test) {
  try {
    test();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}
function module(name) {
  return {
    kind: "capability-module-v1",
    name,
    entry: "main.mjs",
    files: [{ path: "main.mjs", content: "export {};" }],
  };
}
check("valid-slugs-still-parse", () => {
  for (const name of ["a", "summary", "changed-file-summary", "a.b_c-1"])
    assert.equal(parseCapabilityModule(module(name)).ok, true);
});
check("path-traversal-name-rejected", () => {
  for (const name of ["../../escape", "../escape", "a/b", "a\\b", ".", ".."])
    assert.equal(parseCapabilityModule(module(name)).ok, false, name);
});
check("nonportable-names-rejected", () => {
  for (const name of ["HasUppercase", "has space", "-leading", "trailing_", "尾部"])
    assert.equal(parseCapabilityModule(module(name)).ok, false, name);
});
check("direct-directory-escape-rejected", () =>
  assert.throws(() => capabilityModuleDir("/virtual/workspace", "../../escape")),
);
check("normal-directory-preserved", () =>
  assert.equal(
    capabilityModuleDir("/virtual/workspace", "summary"),
    "/virtual/workspace/capability/summary",
  ),
);
check("file-traversal-still-rejected", () =>
  assert.equal(
    parseCapabilityModule({
      ...module("summary"),
      entry: "../main.mjs",
      files: [{ path: "../main.mjs", content: "" }],
    }).ok,
    false,
  ),
);
const passed = results.every((r) => r.passed);
console.log(JSON.stringify({ passed, results }));
process.exitCode = passed ? 0 : 1;
