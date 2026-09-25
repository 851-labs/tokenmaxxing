import { describe, expect, it } from "vite-plus/test";

import {
  assignModelColors,
  CURATED_MODEL_SLOTS,
  fnv1a,
  MODEL_PALETTE,
  modelColor,
  modelColorKey,
  OTHER_MODEL_SERIES,
  OTHER_MODEL_SERIES_COLOR,
  PROBE_STRIDE,
} from "./model-colors";

/** Page backgrounds behind the charts (`--background`, light and dark). */
const LIGHT_BACKGROUND = "#fcfcfa";
const DARK_BACKGROUND = "#0c0d11";

describe("MODEL_PALETTE", () => {
  it("holds distinct colors legible on both theme backgrounds", () => {
    expect(new Set(MODEL_PALETTE).size).toBe(MODEL_PALETTE.length);
    for (const color of [...MODEL_PALETTE, OTHER_MODEL_SERIES_COLOR]) {
      expect(contrast(color, LIGHT_BACKGROUND), color).toBeGreaterThanOrEqual(3);
      expect(contrast(color, DARK_BACKGROUND), color).toBeGreaterThanOrEqual(3);
    }
  });

  it("has no near-duplicate pairs, including against the Other gray", () => {
    const colors = [...MODEL_PALETTE, OTHER_MODEL_SERIES_COLOR];
    let closest = Number.POSITIVE_INFINITY;
    for (const [index, left] of colors.entries()) {
      for (const right of colors.slice(index + 1)) {
        closest = Math.min(closest, deltaE(left, right));
      }
    }

    expect(closest).toBeGreaterThanOrEqual(8);
  });

  it("probes every slot and pins curated models inside the palette", () => {
    const visited = new Set(
      MODEL_PALETTE.map((_, step) => (step * PROBE_STRIDE) % MODEL_PALETTE.length),
    );

    expect(visited.size).toBe(MODEL_PALETTE.length);
    for (const [key, slot] of CURATED_MODEL_SLOTS) {
      expect(modelColorKey(key), key).toBe(key);
      expect(MODEL_PALETTE[slot], key).toBeDefined();
    }
  });
});

describe("modelColorKey", () => {
  it("folds provider paths, date stamps, variant tags and version separators", () => {
    expect(modelColorKey("claude-opus-4-5")).toBe("claude-opus-4.5");
    expect(modelColorKey("claude-opus-4-5-20251101")).toBe("claude-opus-4.5");
    expect(modelColorKey("anthropic/claude-opus-4.5")).toBe("claude-opus-4.5");
    expect(modelColorKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5");
    expect(modelColorKey("accounts/fireworks/models/kimi-k3")).toBe("kimi-k3");
    expect(modelColorKey("upstage/solar-pro4:free")).toBe("solar-pro4");
    expect(modelColorKey("claude-opus-5-fast")).toBe("claude-opus-5");
    expect(modelColorKey("cu/claude-fable-5-thinking-medium")).toBe("claude-fable-5");
    expect(modelColorKey("claude-bccf-route-pro-primary-sol[1m]")).toBe(
      "claude-bccf-route-pro-primary-sol",
    );
    expect(modelColorKey("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(modelColorKey("MiniMax-M2.7")).toBe("minimax-m2.7");
  });
});

describe("fnv1a", () => {
  it("matches the reference 32-bit FNV-1a vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("modelColor", () => {
  it("pins curated models to fixed colors", () => {
    expect(modelColor("claude-opus-5")).toBe("#a936c2");
    expect(modelColor("gpt-5.6-sol")).toBe("#f06400");
    expect(modelColor("gpt-6-astra")).toBe("#077a45");
    expect(modelColor("claude-fable-5")).toBe("#8f85ec");
  });

  it("gives name variants of one model the same color", () => {
    expect(modelColor("anthropic/claude-opus-4.5")).toBe(modelColor("claude-opus-4-5-20251101"));
    expect(modelColor("claude-opus-5-fast")).toBe(modelColor("claude-opus-5"));
  });

  it("hashes unknown models to a stable palette color", () => {
    const color = modelColor("some-future-model-9");

    expect(MODEL_PALETTE).toContain(color);
    expect(modelColor("some-future-model-9")).toBe(color);
    expect(color).toBe(MODEL_PALETTE[fnv1a("some-future-model-9") % MODEL_PALETTE.length]);
  });

  it("keeps Other gray", () => {
    expect(modelColor(OTHER_MODEL_SERIES)).toBe(OTHER_MODEL_SERIES_COLOR);
  });
});

describe("assignModelColors", () => {
  const popular = ["gpt-6-astra", "gpt-5.6-sol", "claude-opus-5", "claude-fable-5.1"];

  it("gives each model its preferred color when nothing collides", () => {
    const colors = assignModelColors([[...popular, OTHER_MODEL_SERIES]]);

    for (const model of popular) {
      expect(colors.get(model)).toBe(modelColor(model));
    }
    expect(colors.get(OTHER_MODEL_SERIES)).toBe(OTHER_MODEL_SERIES_COLOR);
  });

  it("ignores dataset order and which other models are present", () => {
    const forward = assignModelColors([popular]);
    const reversed = assignModelColors([[...popular].reverse()]);
    const subset = assignModelColors([["claude-opus-5"]]);

    expect(reversed).toEqual(forward);
    expect(subset.get("claude-opus-5")).toBe(forward.get("claude-opus-5"));
  });

  it("does not repaint existing models when a new one appears", () => {
    const newcomer = unknownModelAvoiding(popular.map(modelColor));
    const before = assignModelColors([popular]);
    const after = assignModelColors([[newcomer, ...popular]]);

    for (const model of popular) {
      expect(after.get(model)).toBe(before.get(model));
    }
    expect(after.get(newcomer)).toBe(modelColor(newcomer));
  });

  it("keeps a curated model's color when an unknown model hashes onto it", () => {
    const intruder = unknownModelWithColor(modelColor("claude-opus-5"));
    const colors = assignModelColors([[intruder, "claude-opus-5"]]);

    expect(colors.get("claude-opus-5")).toBe(modelColor("claude-opus-5"));
    expect(colors.get(intruder)).not.toBe(modelColor("claude-opus-5"));
  });

  it("separates colliding models only when they share a chart", () => {
    const [first, second] = collidingUnknownModels();

    const together = assignModelColors([[second, first]]);
    const apart = assignModelColors([[first], [second]]);

    expect(together.get(first)).toBe(modelColor(first));
    expect(together.get(second)).not.toBe(together.get(first));
    expect(apart.get(first)).toBe(modelColor(first));
    expect(apart.get(second)).toBe(modelColor(second));
  });

  it("uses one color per model across a page's charts", () => {
    const [first, second] = collidingUnknownModels();

    const colors = assignModelColors([
      [first, "claude-opus-5"],
      [second, first],
    ]);

    expect(colors.get(first)).toBe(modelColor(first));
    expect(colors.get(second)).not.toBe(colors.get(first));
  });

  it("keeps every series in a chart distinct past twelve models", () => {
    const models = Array.from({ length: MODEL_PALETTE.length }, (_, index) => `model-${index}`);
    const colors = assignModelColors([models]);

    expect(new Set(models.map((model) => colors.get(model))).size).toBe(models.length);
  });

  it("keeps the curated models that chart together distinct", () => {
    // The /stats last-30-days and year-to-date top nine at the time of writing.
    const last30d = [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5-5",
      "gpt-5.6-luna",
      "claude-sonnet-5",
      "claude-opus-4-8",
    ];
    const ytd = [
      "gpt-5.6-sol",
      "gpt-5.5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-5",
      "gpt-6-astra",
      "gpt-5.4",
      "claude-fable-5-1",
      "claude-opus-4-7",
    ];

    for (const chart of [last30d, ytd]) {
      expect(new Set(chart.map(modelColor)).size).toBe(chart.length);
    }
  });
});

/** First generated unknown model whose preferred color is `color`. */
function unknownModelWithColor(color: string): string {
  return findModel((model) => modelColor(model) === color);
}

/** First generated unknown model whose preferred color is none of `colors`. */
function unknownModelAvoiding(colors: readonly string[]): string {
  return findModel((model) => !colors.includes(modelColor(model)));
}

/** Two generated unknown models that prefer the same slot, in priority order. */
function collidingUnknownModels(): [string, string] {
  const seen = new Map<string, string>();
  const second = findModel((model) => {
    const color = modelColor(model);
    if (seen.has(color)) {
      return true;
    }
    seen.set(color, model);
    return false;
  });
  const first = seen.get(modelColor(second)) ?? "";

  return first < second ? [first, second] : [second, first];
}

function findModel(matches: (model: string) => boolean): string {
  for (let index = 0; index < 1_000; index += 1) {
    const model = `unknown-model-${index}`;
    if (matches(model)) {
      return model;
    }
  }
  throw new Error("no generated model matched");
}

function linearChannels(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };

  return [channel(1), channel(3), channel(5)];
}

/** WCAG 2 contrast ratio. */
function contrast(left: string, right: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = linearChannels(hex);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);

  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/** Euclidean OKLab distance ×100. */
function deltaE(left: string, right: string): number {
  const oklab = (hex: string) => {
    const [red, green, blue] = linearChannels(hex);
    const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
    const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
    const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [a, b] = [oklab(left), oklab(right)];

  return 100 * Math.hypot(...a.map((value, index) => value - (b[index] ?? 0)));
}
