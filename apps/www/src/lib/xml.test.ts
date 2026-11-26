import { describe, expect, it } from "vite-plus/test";

import { escapeXml } from "./xml";

describe("escapeXml", () => {
  it("escapes markup and both quote characters", () => {
    expect(escapeXml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&apos;y&apos;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("drops the characters an XML document cannot carry", () => {
    // A NUL, a backspace, a lone surrogate and U+FFFF would each fail the parse.
    expect(escapeXml("a\u{0}b\u{8}c\u{D800}d\u{FFFF}e")).toBe("abcde");
  });

  it("keeps whitespace, non-Latin text and astral characters", () => {
    expect(escapeXml("tab\there\nモデル 🚀")).toBe("tab\there\nモデル 🚀");
  });
});
