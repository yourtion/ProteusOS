import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords } from "../../src/wordcount.mjs";

test("countWords 按空白切分", () => {
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("  a  b c "), 3);
  assert.equal(countWords("中文 与 English 混排"), 4);
});

test("空串返回 0", () => {
  assert.equal(countWords(""), 0);
});
