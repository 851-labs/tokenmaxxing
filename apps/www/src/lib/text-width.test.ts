import { describe, expect, it } from "vite-plus/test";

import { estimateTextWidth, fitText } from "./text-width";

describe("estimateTextWidth", () => {
  it("scales with the font size and tells narrow glyphs from wide ones", () => {
    expect(estimateTextWidth("claude", 20)).toBe(estimateTextWidth("claude", 10) * 2);
    expect(estimateTextWidth("WWWW", 10)).toBeGreaterThan(estimateTextWidth("iiii", 10) * 3);
    expect(estimateTextWidth("", 10)).toBe(0);
  });

  it("takes a glyph it has no number for as a full em", () => {
    expect(estimateTextWidth("模型", 12)).toBe(24);
    expect(estimateTextWidth("🚀", 12)).toBe(12);
  });
});

describe("fitText", () => {
  it("leaves text that fits alone", () => {
    expect(fitText("opus", 200, 20, 12)).toEqual({ size: 20, text: "opus" });
  });

  it("sets text smaller before cutting it", () => {
    const fitted = fitText("claude-sonnet-5-5", 160, 20, 13);

    expect(fitted.text).toBe("claude-sonnet-5-5");
    expect(fitted.size).toBeLessThan(20);
    expect(fitted.size).toBeGreaterThanOrEqual(13);
    expect(estimateTextWidth(fitted.text, fitted.size)).toBeLessThanOrEqual(160);
  });

  it("cuts with an ellipsis once the smallest size is still too wide", () => {
    const fitted = fitText("W".repeat(60), 160, 20, 13);

    expect(fitted.size).toBe(13);
    expect(fitted.text).toMatch(/^W+…$/);
    expect(estimateTextWidth(fitted.text, fitted.size)).toBeLessThanOrEqual(160);
    // As much of the text as fits: one more glyph would not.
    expect(estimateTextWidth(`W${fitted.text}`, fitted.size)).toBeGreaterThan(160);
  });

  it("cuts without resizing when no smaller size is allowed", () => {
    const fitted = fitText("a-very-long-model-name-indeed", 80, 11);

    expect(fitted.size).toBe(11);
    expect(fitted.text.endsWith("…")).toBe(true);
    expect(estimateTextWidth(fitted.text, 11)).toBeLessThanOrEqual(80);
  });

  it("keeps at least one glyph, and never splits a surrogate pair", () => {
    expect(fitText("🚀🚀🚀", 1, 12).text).toBe("🚀…");
  });
});
