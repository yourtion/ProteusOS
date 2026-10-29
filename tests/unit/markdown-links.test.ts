import { expect, it } from "vitest";
import { safeLink } from "../../web/src/markdown-links.ts";
it("permits web links without turning executable or local URLs into anchors", () => {
  expect(safeLink("https://example.com/docs")).toBe("https://example.com/docs");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "//example.com",
    "README.md",
    "\n javascript:alert(1)",
  ])
    expect(safeLink(value)).toBeNull();
});
