import { describe, expect, it } from "vite-plus/test";

import { hiddenWhenNarrow } from "./axis";
import { columnAt } from "./scale";

describe("hiddenWhenNarrow", () => {
  it("keeps every label when few fit", () => {
    expect([0, 1, 2, 3, 4, 5].map((index) => hiddenWhenNarrow(index, 6))).toEqual(
      Array(6).fill(false),
    );
  });

  it("keeps every n-th label of a long axis", () => {
    const shown = Array.from({ length: 9 }, (_, index) => index).filter(
      (index) => !hiddenWhenNarrow(index, 9),
    );

    expect(shown).toEqual([0, 2, 4, 6, 8]);
  });
});

describe("columnAt", () => {
  it("maps a pointer fraction to its column, clamped to the plot", () => {
    expect(columnAt(0, 30)).toBe(0);
    expect(columnAt(0.5, 30)).toBe(15);
    expect(columnAt(1, 30)).toBe(29);
    expect(columnAt(-0.2, 30)).toBe(0);
  });
});
