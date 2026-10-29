// Frozen external acceptance checks. The implementation under test is the only argument.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { validateSchema } = await import(pathToFileURL(resolve(process.argv[2])).href);
const results = [];
function check(name, verify) {
  try {
    verify();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, detail: String(error) });
  }
}

for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
  check(`missing-required-${name}`, () => {
    const errors = validateSchema(JSON.parse("{}"), { type: "object", required: [name] });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, `$.${name}`);
  });
}
check("optional-inherited-property-is-absent", () => {
  assert.deepEqual(validateSchema({}, { properties: { toString: { type: "string" } } }), []);
});
check("custom-inherited-required-property-is-absent", () => {
  assert.equal(validateSchema(Object.create({ result: "ok" }), { required: ["result"] }).length, 1);
});
check("custom-inherited-optional-property-is-absent", () => {
  assert.deepEqual(
    validateSchema(Object.create({ result: 123 }), { properties: { result: { type: "string" } } }),
    [],
  );
});
check("own-special-names-are-valid", () => {
  const value = JSON.parse(
    '{"constructor":"a","toString":"b","__proto__":"c","hasOwnProperty":"d"}',
  );
  const properties = Object.fromEntries(
    Object.keys(value).map((name) => [name, { type: "string" }]),
  );
  assert.deepEqual(
    validateSchema(value, {
      type: "object",
      required: Object.keys(value),
      properties,
      additionalProperties: false,
    }),
    [],
  );
});
check("own-special-name-still-checks-type", () => {
  assert.equal(
    validateSchema(JSON.parse('{"constructor":2}'), {
      properties: { constructor: { type: "string" } },
    }).length,
    1,
  );
});
check("null-prototype-object", () => {
  const value = Object.assign(Object.create(null), { result: "ok" });
  assert.deepEqual(
    validateSchema(value, {
      type: "object",
      required: ["result"],
      properties: { result: { type: "string" } },
    }),
    [],
  );
});
check("nested-missing-inherited-name", () => {
  const errors = validateSchema(
    { child: {} },
    { properties: { child: { required: ["toString"] } } },
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "$.child.toString");
});
check("existing-subset-regression", () => {
  const schema = {
    type: "object",
    required: ["values"],
    properties: {
      values: { type: "array", minItems: 1, items: { type: "integer", minimum: 0, enum: [0, 1] } },
    },
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema({ values: [0, 1] }, schema), []);
  for (const value of [
    {},
    { values: [] },
    { values: [-1] },
    { values: [2] },
    { values: [0.5] },
    { values: [0], extra: true },
  ]) {
    assert.ok(validateSchema(value, schema).length > 0);
  }
});
console.log(JSON.stringify({ passed: results.every((r) => r.passed), results }, null, 2));
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
