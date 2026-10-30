import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const violations = [];
function record(file, rule, target) {
  violations.push(`${file} | ${rule} | ${target}`);
}
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      visit(path);
      continue;
    }
    if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
    const file = relative(root, path).replaceAll("\\", "/");
    const source = readFileSync(path, "utf8");
    const experiment = file.startsWith("src/app/experiment/");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = relative(root, resolve(dirname(path), specifier)).replaceAll("\\", "/");
      if (/^(tests|docs|experiments)\//.test(target)) record(file, "source-import", target);
      if (!experiment && target.startsWith("src/app/experiment/"))
        record(file, "experiment-import", target);
      if (
        /^src\/(kernel|runtime|decision|evolution|federation)\//.test(file) &&
        target.startsWith("src/app/")
      )
        record(file, "core-imports-app", target);
    }
    // Literal resource URLs are checked in addition to module imports. Arbitrary
    // computed fs access still needs the product-only smoke check.
    for (const match of source.matchAll(
      /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url/g,
    )) {
      const target = relative(root, resolve(dirname(path), match[1])).replaceAll("\\", "/");
      if (/^(tests|docs|experiments)\//.test(target)) record(file, "source-resource", target);
    }
  }
}
visit(resolve(root, "src"));
const actual = [...new Set(violations)].sort();
const exceptions = JSON.parse(
  readFileSync(new URL("./boundary-exceptions.json", import.meta.url), "utf8"),
);
const expected = Object.keys(exceptions).sort();
const added = actual.filter((entry) => !expected.includes(entry));
const removed = expected.filter((entry) => !actual.includes(entry));
if (added.length || removed.length) {
  for (const entry of added) console.error(`Forbidden dependency: ${entry}`);
  for (const entry of removed) console.error(`Remove resolved exception: ${entry}`);
  process.exitCode = 1;
} else
  console.log(`Dependency boundaries passed (${expected.length} tracked migration exceptions).`);
