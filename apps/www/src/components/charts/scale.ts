import type { ProfileDailyRow } from "@tokenmaxxing/api-contract";

type DailyRow = typeof ProfileDailyRow.Type;

/**
 * Shared chart math: linear scales, model-series bucketing, and number
 * formatting. Charts are pure SVG; everything here is deterministic and
 * unit-testable.
 */

/** Shared bar-chart geometry so the charts can't drift apart. */
const CHART_WIDTH = 940;
/** Left gutter (px) reserved for the value-axis labels. */
const CHART_AXIS = 44;
/** Gridline count; `CHART_TICKS + 1` lines render, including the baseline. */
const CHART_TICKS = 4;

function linearScale(domainMax: number, rangeMax: number) {
  const safeMax = domainMax <= 0 ? 1 : domainMax;

  return (value: number) => (value / safeMax) * rangeMax;
}

/**
 * Slot width and bar width shared by the vertical bar charts. `fill` is the
 * fraction of the slot the bar occupies, capped at `cap` and floored at `floor`.
 */
function barLayout(count: number, fill: number, cap: number, floor = 0) {
  const slot = (CHART_WIDTH - CHART_AXIS) / Math.max(count, 1);
  const barWidth = Math.max(Math.min(slot * fill, cap), floor);

  return { barWidth, slot };
}

/** "Nice" axis max so gridlines land on round numbers. */
function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

  return niceFraction * 10 ** exponent;
}

const CLAUDE_MODEL_LINES = {
  fable: "Claude Fable",
  haiku: "Claude Haiku",
  mythos: "Claude Mythos",
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
} as const;

const CLAUDE_SERIES_ORDER = [
  "Claude Fable",
  "Claude Mythos",
  "Claude Opus",
  "Claude Sonnet",
  "Claude Haiku",
] as const;

const MODEL_SERIES_RULES: readonly [RegExp, string][] = [
  [/^gpt-5\.6(?:$|-sol(?:$|-))/i, "GPT-5.6 Sol"],
  [/^gpt-5\.6-terra(?:$|-)/i, "GPT-5.6 Terra"],
  [/^gpt-5\.6-luna(?:$|-)/i, "GPT-5.6 Luna"],
  [/^gpt-5\.5/i, "GPT-5.5"],
  [/^gpt-5\.4/i, "GPT-5.4"],
  [/^gpt-5/i, "GPT-5"],
  [/^gpt/i, "GPT"],
  [/codex/i, "GPT Codex"],
  [/gemini/i, "Gemini"],
  [/^o[0-9]/i, "OpenAI o-series"],
];

const MODEL_SERIES_ORDER = [
  "GPT-5.6 Sol",
  "GPT-5.6 Terra",
  "GPT-5.6 Luna",
  "GPT-5.5",
  "GPT-5.4",
  "GPT-5",
  "GPT",
  "GPT Codex",
  "OpenAI o-series",
  ...CLAUDE_SERIES_ORDER,
  "Gemini",
  "Other",
] as const;

function modelSeriesLabel(model: string): string {
  const claude = claudeSeriesLabel(model);
  if (claude !== null) {
    return claude;
  }

  for (const [pattern, series] of MODEL_SERIES_RULES) {
    if (pattern.test(model)) {
      return series;
    }
  }

  return "Other";
}

function claudeSeriesLabel(model: string): string | null {
  const match = /^claude-([a-z]+)(?:-(\d+)(?:-(\d+))?)?/i.exec(model);
  if (match === null) {
    return null;
  }

  const line = match[1]?.toLowerCase();
  const base =
    line === undefined ? undefined : CLAUDE_MODEL_LINES[line as keyof typeof CLAUDE_MODEL_LINES];
  if (base === undefined) {
    return "Other";
  }

  const major = match[2];
  if (major === undefined) {
    return base;
  }

  const minor = match[3];
  return minor === undefined ? `${base} ${major}` : `${base} ${major}.${minor}`;
}

/** Fixed palette tuned to read on both themes. */
const MODEL_SERIES_COLORS = {
  "Claude Fable": "#38bdf8",
  "Claude Haiku": "#ec4899",
  "Claude Mythos": "#a855f7",
  "Claude Opus": "#eab308",
  "Claude Sonnet": "#14b8a6",
  Gemini: "#ef4444",
  GPT: "#6366f1",
  "GPT Codex": "#0ea5e9",
  "GPT-5": "#8b5cf6",
  "GPT-5.4": "#22c55e",
  "GPT-5.5": "#f97316",
  "GPT-5.6 Luna": "#06b6d4",
  "GPT-5.6 Sol": "#e11d48",
  "GPT-5.6 Terra": "#ca8a04",
  "OpenAI o-series": "#84cc16",
  Other: "#9ca3af",
} as const satisfies Record<string, string>;

const DYNAMIC_SERIES_COLORS = [
  "#f59e0b",
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#0891b2",
  "#ea580c",
  "#db2777",
  "#65a30d",
  "#7c3aed",
  "#0d9488",
  "#475569",
] as const;

/** Stable series -> color assignment in canonical model-series order. */
function seriesColors(rows: readonly DailyRow[]): Map<string, string> {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(modelSeriesLabel(row.key));
  }

  const colors = new Map<string, string>();
  let dynamicIndex = 0;
  for (const series of [...seen].sort(compareModelSeriesLabels)) {
    const staticColor = MODEL_SERIES_COLORS[series as keyof typeof MODEL_SERIES_COLORS];
    if (staticColor !== undefined) {
      colors.set(series, staticColor);
    } else {
      colors.set(
        series,
        DYNAMIC_SERIES_COLORS[dynamicIndex % DYNAMIC_SERIES_COLORS.length] ??
          MODEL_SERIES_COLORS.Other,
      );
      dynamicIndex += 1;
    }
  }

  return colors;
}

function compareModelSeriesLabels(a: string, b: string): number {
  const left = modelSeriesSortKey(a);
  const right = modelSeriesSortKey(b);

  return (
    left.group - right.group ||
    left.version - right.version ||
    left.label.localeCompare(right.label)
  );
}

function modelSeriesSortKey(label: string) {
  for (const [group, base] of MODEL_SERIES_ORDER.entries()) {
    if (label === base) {
      return { group, label, version: Number.MAX_SAFE_INTEGER };
    }
    if (CLAUDE_SERIES_ORDER.includes(base as (typeof CLAUDE_SERIES_ORDER)[number])) {
      const version = claudeLabelVersion(label, base);
      if (version !== null) {
        return { group, label, version: -version };
      }
    }
  }

  return { group: MODEL_SERIES_ORDER.length, label, version: 0 };
}

function claudeLabelVersion(label: string, base: string): number | null {
  const version = new RegExp(`^${escapeRegExp(base)} (\\d+)(?:\\.(\\d+))?$`).exec(label);
  if (version === null) {
    return null;
  }

  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);

  return major * 1_000 + minor;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const usd0 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const usd2 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

function formatUsd(value: number): string {
  return value >= 100 ? usd0.format(value) : usd2.format(value);
}

function formatTokens(value: number): string {
  if (value >= 1e12) {
    return `${(value / 1e12).toFixed(2)}T`;
  }
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }

  return value.toFixed(0);
}

const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthLongLabel = new Intl.DateTimeFormat("en-US", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});
const dayLabel = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
});

/** Opaque YYYY-MM-DD keys render via UTC so no local-tz shifting occurs. */
function formatDay(date: string): string {
  return dayLabel.format(new Date(`${date}T00:00:00Z`));
}

function formatMonth(month: string): string {
  return monthLabel.format(new Date(`${month}-01T00:00:00Z`));
}

/** Full month + year, e.g. "June 2026" — used in tooltips. */
function formatMonthLong(month: string): string {
  return monthLongLabel.format(new Date(`${month}-01T00:00:00Z`));
}

/** Every YYYY-MM-DD between two inclusive bounds (pure string walking). */
function enumerateDays(first: string, last: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}

export {
  barLayout,
  CHART_AXIS,
  CHART_TICKS,
  CHART_WIDTH,
  enumerateDays,
  formatDay,
  formatMonth,
  formatMonthLong,
  formatTokens,
  formatUsd,
  linearScale,
  modelSeriesLabel,
  niceMax,
  seriesColors,
};
