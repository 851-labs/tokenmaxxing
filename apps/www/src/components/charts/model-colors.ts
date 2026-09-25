import { STATS_OTHER_MODEL_KEY } from "@tokenmaxxing/api-contract";

/**
 * A model's chart color is a pure function of its name, so the same model
 * wears the same color on /stats and every profile, on every tab, for every
 * visitor, and a newly appearing model never repaints the others.
 *
 * Each model has a preferred palette slot: a curated one for the models we
 * see most, otherwise an FNV-1a hash of its normalized name. Series that share
 * a chart must still differ, so `assignModelColors` resolves slot collisions
 * among the models charted together: the higher-priority model (curated rank,
 * then name) keeps its slot and the other probes a fixed, hash-independent
 * sequence to the next free one. A model therefore wears its preferred color
 * everywhere except on a page where a higher-priority neighbor claims the same
 * slot; curated slots are chosen so the models that actually co-occur never
 * contend, which confines probing to the long tail.
 */

/**
 * Sixteen colors in OKLCH L 0.50–0.68, C >= 0.10, each at least 3:1 against
 * both the light (#fcfcfa) and dark (#0c0d11) page backgrounds, so marks stay
 * legible in either theme without per-theme variants. Hues alternate between
 * a darker and a lighter step so hue neighbors also differ in lightness; the
 * worst pair is OKLab ΔE 8.3 (normal vision) and 5.7 (deuteranopia). Sixteen
 * slots is the trade-off between fewer near-pairs (12 slots: ΔE 11) and fewer
 * curated models sharing a slot; charts carry at most nine models, and the
 * legend, tooltip and hover highlight name every series, so no pair relies on
 * color alone.
 */
const MODEL_PALETTE = [
  "#c83846", // 0 red
  "#f06400", // 1 orange
  "#865d00", // 2 ochre
  "#779715", // 3 olive
  "#077a45", // 4 forest
  "#0ba760", // 5 green
  "#119180", // 6 teal
  "#0091b7", // 7 cyan
  "#026a9d", // 8 ocean
  "#4078fe", // 9 blue
  "#5454ea", // 10 indigo
  "#8f85ec", // 11 lavender
  "#a936c2", // 12 purple
  "#e351c7", // 13 orchid
  "#9c4579", // 14 plum
  "#fd498e", // 15 pink
] as const;

/**
 * Collision probe stride. Coprime with the palette size, so probing visits
 * every slot, and ~7/16 of the hue wheel per step, so a displaced model lands
 * far from the color it lost.
 */
const PROBE_STRIDE = 7;

const OTHER_MODEL_SERIES = STATS_OTHER_MODEL_KEY;
const OTHER_MODEL_SERIES_COLOR = "#8b919c";

/**
 * Fixed slots for the models seen most across /stats and profiles, in
 * priority order (most charted first); keys are normalized names. Versions of
 * a family get distinct colors rather than shades of one hue: one chart
 * routinely stacks four Claude Opus/Fable versions beside five GPT-5.x/6
 * variants, and shades of a single hue could not be told apart there.
 *
 * Slots were fitted to the top-nine sets of real charts (/stats windows and
 * the top 100 profiles, September 2026), maximizing each chart's closest pair
 * and keeping its four largest series well apart; models that share a slot
 * almost never share a chart. Moving an entry repaints that model everywhere,
 * so append new models rather than reshuffling existing ones.
 */
const CURATED_MODEL_SLOTS: ReadonlyMap<string, number> = new Map([
  ["gpt-5.6-sol", 1],
  ["claude-opus-5", 11],
  ["gpt-6-astra", 10],
  ["claude-fable-5", 2],
  ["claude-fable-5.1", 5],
  ["claude-opus-4.8", 12],
  ["gpt-5.5", 15],
  ["claude-sonnet-5", 13],
  ["gpt-5.6-luna", 14],
  ["claude-opus-5.5", 8],
  ["gpt-5.6-terra", 3],
  ["gpt-5.4", 9],
  ["gpt-6-sol", 7],
  ["claude-opus-4.7", 6],
  ["claude-haiku-4.5", 0],
  ["gpt-5.3-codex", 4],
  ["claude-opus-4.6", 7],
  ["gpt-5", 6],
  ["claude-sonnet-4.6", 4],
  ["gpt-6-luna", 13],
  ["gpt-5.3-codex-spark", 0],
  ["gpt-5.4-mini", 12],
  ["gpt-5.2-codex", 6],
  ["gpt-5.2", 11],
  ["claude-sonnet-4.5", 14],
  ["claude-opus-4.5", 0],
  ["gemini-3-pro-preview", 14],
  ["gemini-3.1-pro-preview", 1],
  ["gemini-3-flash-preview", 11],
  ["glm-5.3", 3],
  ["grok-4.6", 0],
  ["kimi-k3", 14],
  ["deepseek-v4-pro", 14],
  ["deepseek-v4-flash", 11],
]);

const CURATED_PRIORITY: ReadonlyMap<string, number> = new Map(
  [...CURATED_MODEL_SLOTS.keys()].map((key, index) => [key, index]),
);

/** Trailing date stamps and speed/effort tags, which don't make a new model. */
const VARIANT_SUFFIX = /-(?:\d{8}|fast|thinking|low|medium|high|xhigh|max)$/;

/**
 * The identity a color follows: lowercase, without a provider or router path
 * (`anthropic/…`, `accounts/fireworks/models/…`), a `:free`-style tag, a
 * bracketed context tag (`[1m]`), a trailing date stamp, or a speed/effort
 * suffix; and with dashes between version digits written as dots, so
 * `anthropic/claude-opus-4-5-20251101` and `claude-opus-4.5` share a color.
 */
function modelColorKey(model: string): string {
  let key = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "");
  key = key.slice(key.lastIndexOf("/") + 1).replace(/:.*$/, "");
  let previous: string;
  do {
    previous = key;
    key = key.replace(VARIANT_SUFFIX, "");
  } while (key !== previous);

  return key.replace(/(\d)-(?=\d)/g, "$1.");
}

/** 32-bit FNV-1a over UTF-16 code units: stable across runtimes and releases. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function preferredModelSlot(model: string): number {
  const key = modelColorKey(model);

  return CURATED_MODEL_SLOTS.get(key) ?? fnv1a(key) % MODEL_PALETTE.length;
}

/** Curated models by rank, then everything else; ties break on the raw name. */
function compareModelPriority(left: string, right: string): number {
  const leftRank = CURATED_PRIORITY.get(modelColorKey(left)) ?? Number.POSITIVE_INFINITY;
  const rightRank = CURATED_PRIORITY.get(modelColorKey(right)) ?? Number.POSITIVE_INFINITY;
  if (leftRank !== rightRank) {
    return leftRank < rightRank ? -1 : 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

function slotColor(slot: number): string {
  return MODEL_PALETTE[slot] ?? OTHER_MODEL_SERIES_COLOR;
}

/** A model's preferred color, ignoring what it is charted beside. */
function modelColor(model: string): string {
  return model === OTHER_MODEL_SERIES
    ? OTHER_MODEL_SERIES_COLOR
    : slotColor(preferredModelSlot(model));
}

/**
 * Colors for every model in `charts`, where each entry lists the series of
 * one chart on the page. Models charted together never share a color (while
 * a chart holds no more models than the palette has slots); one map serves
 * the whole page, so a model keeps one color across its charts. "Other" is
 * always gray.
 */
function assignModelColors(charts: Iterable<Iterable<string>>): Map<string, string> {
  const neighbors = new Map<string, Set<string>>();
  for (const chart of charts) {
    const models = [...new Set(chart)].filter((model) => model !== OTHER_MODEL_SERIES);
    for (const model of models) {
      const set = neighbors.get(model) ?? new Set<string>();
      for (const other of models) {
        if (other !== model) {
          set.add(other);
        }
      }
      neighbors.set(model, set);
    }
  }

  const slots = new Map<string, number>();
  for (const model of [...neighbors.keys()].sort(compareModelPriority)) {
    const taken = new Set<number>();
    for (const neighbor of neighbors.get(model) ?? []) {
      const slot = slots.get(neighbor);
      if (slot !== undefined) {
        taken.add(slot);
      }
    }
    const preferred = preferredModelSlot(model);
    let slot = preferred;
    for (let step = 0; step < MODEL_PALETTE.length; step += 1) {
      const candidate = (preferred + step * PROBE_STRIDE) % MODEL_PALETTE.length;
      if (!taken.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    slots.set(model, slot);
  }

  const colors = new Map([...slots].map(([model, slot]) => [model, slotColor(slot)]));
  colors.set(OTHER_MODEL_SERIES, OTHER_MODEL_SERIES_COLOR);

  return colors;
}

export {
  assignModelColors,
  CURATED_MODEL_SLOTS,
  fnv1a,
  MODEL_PALETTE,
  modelColor,
  modelColorKey,
  OTHER_MODEL_SERIES,
  OTHER_MODEL_SERIES_COLOR,
  PROBE_STRIDE,
};
