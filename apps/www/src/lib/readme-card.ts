import type { ProfileDailyResponse, ProfileResponse } from "@tokenmaxxing/api-contract";

import {
  assignModelColors,
  OTHER_MODEL_SERIES,
  OTHER_MODEL_SERIES_COLOR,
} from "../components/charts/model-colors";
import { niceMax, round2 } from "../components/charts/scale";
import { bucketSeries, selectModelSeries } from "../components/charts/series";
import { addDays, enumerateDays } from "./dates";
import {
  formatInteger,
  formatMonthDay,
  formatPercent,
  formatTokens,
  formatUsd,
  percentOf,
} from "./format";
import { estimateTextWidth, fitText } from "./text-width";
import { escapeXml } from "./xml";

type Profile = typeof ProfileResponse.Type;
type Daily = typeof ProfileDailyResponse.Type;
type ReadmeCardLayout = "compact" | "full";
type ReadmeCardTheme = "auto" | "dark" | "light";
type Metric = "spend" | "tokens";
type ReadmeCardPlaceholder = "missing" | "unavailable";

interface ReadmeCardOptions {
  hideSpend: boolean;
  layout: ReadmeCardLayout;
  theme: ReadmeCardTheme;
}

interface ReadmeCardData {
  /** `data:` URI; SVGs inside GitHub's `<img>` cannot load remote images. */
  avatarDataUri: string | null;
  /** Daily rows grouped by model for the last {@link README_CARD_DAYS} days. */
  daily: Daily;
  profile: Profile;
}

interface Palette {
  background: string;
  border: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
}

interface Cell {
  label: string;
  value: string;
}

interface ChartSeries {
  color: string;
  model: string;
  total: number;
}

interface ModelChart {
  dates: string[];
  days: Array<Map<string, number>>;
  series: ChartSeries[];
}

/** Geometry of one card layout; `y` offsets are relative to the top of their block. */
interface LayoutSpec {
  avatar: number;
  bars: { gap: number; height: number; top: number };
  brand: number;
  columns: number;
  /** Weekly date ticks under the bars; `null` drops them. */
  dateLabel: { gap: number; size: number } | null;
  header: "inline" | "stacked";
  headerHeight: number;
  label: { size: number; y: number };
  /** Model legend, `gap` below the dates (or the bars) and `bottom` above the card's edge. */
  legend: { bottom: number; gap: number };
  /** Sizes with a `min` shrink toward it before their text is cut short. */
  login: { min: number; size: number };
  rowHeight: number;
  rows: number;
  summary: { size: number; y: number };
  value: { min: number; size: number; y: number };
  /** `width` is the least room the axis labels get; wider labels widen it. */
  yAxis: { fractions: readonly number[]; size: number; width: number };
}

const WIDTH = 600;
const PAD = 20;
const STACKED_MODELS = 5;
const LEGEND_MODELS = 3;
const README_CARD_DAYS = 30;
const BRAND = "tokenmaxxing.sh";
/** Least space between a stat's value and the divider right of it. */
const CELL_GAP = 12;
/** Least space between two texts sharing a line. */
const TEXT_GAP = 16;
const LEGEND_FONT_SIZE = 11;
/** A legend dot and the gap after it. */
const LEGEND_DOT_WIDTH = 14;
const LEGEND_NAME_WIDTH = 150;
const PLACEHOLDER_LOGIN = { min: 11, size: 15 };
/**
 * What a login can look like (the API slugs them to this). The placeholder
 * echoes the URL's login only when it matches, so the card can't be made to
 * carry arbitrary text, or characters XML has no place for.
 */
const LOGIN_SHAPE = /^[\w-]{1,64}$/;

const LAYOUTS: Record<ReadmeCardLayout, LayoutSpec> = {
  full: {
    avatar: 40,
    bars: { gap: 3, height: 72, top: 44 },
    brand: 14,
    columns: 3,
    dateLabel: { gap: 15, size: 10 },
    header: "stacked",
    headerHeight: 72,
    label: { size: 10.5, y: 24 },
    legend: { bottom: 18, gap: 24 },
    login: { min: 14, size: 20 },
    rowHeight: 64,
    rows: 2,
    summary: { size: 12, y: 26 },
    value: { min: 13, size: 20, y: 50 },
    yAxis: { fractions: [0, 0.5, 1], size: 9.5, width: 46 },
  },
  compact: {
    avatar: 22,
    bars: { gap: 3, height: 40, top: 28 },
    brand: 11,
    columns: 4,
    dateLabel: null,
    header: "inline",
    headerHeight: 46,
    label: { size: 9.5, y: 18 },
    legend: { bottom: 12, gap: 20 },
    login: { min: 11, size: 15 },
    rowHeight: 48,
    rows: 1,
    summary: { size: 11, y: 18 },
    value: { min: 12, size: 17, y: 38 },
    yAxis: { fractions: [], size: 9.5, width: 0 },
  },
};

// Hex renderings of the styles.css OKLCH tokens.
const LIGHT_PALETTE: Palette = {
  background: "#fcfcfa",
  border: "#e2e1dd",
  foreground: "#16181d",
  muted: "#f2f2ef",
  mutedForeground: "#666970",
};

const DARK_PALETTE: Palette = {
  background: "#0c0d11",
  border: "#24262c",
  foreground: "#e9e8e4",
  muted: "#16181d",
  mutedForeground: "#8c8f97",
};

const PLACEHOLDER_MESSAGES: Record<ReadmeCardPlaceholder, string> = {
  missing: "No public profile on tokenmaxxing.sh yet",
  unavailable: "Stats are temporarily unavailable",
};

/**
 * Bumped when the card's markup changes in a way a cached copy must not
 * outlive; it is part of the route's cache key.
 */
const README_CARD_LAYOUT_VERSION = "1";

/**
 * System fonts, as GitHub's own UI uses: the card matches the README around
 * it and stays small. Embedding the site's Geist would add about 92 KB to
 * every card (an SVG inside GitHub's `<img>` cannot load a remote font).
 */
const SANS_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

function parseReadmeCardOptions(searchParams: URLSearchParams): ReadmeCardOptions {
  const theme = searchParams.get("theme");
  const hidden = (searchParams.get("hide") ?? "").split(",").map((value) => value.trim());

  return {
    hideSpend: hidden.includes("spend"),
    layout: searchParams.get("layout") === "compact" ? "compact" : "full",
    theme: theme === "dark" || theme === "light" ? theme : "auto",
  };
}

function renderReadmeCard(data: ReadmeCardData, options: ReadmeCardOptions): string {
  const layout = LAYOUTS[options.layout];
  const { stats, user } = data.profile;
  const metric: Metric = options.hideSpend ? "tokens" : "spend";
  const chartTop = layout.headerHeight + layout.rowHeight * layout.rows;
  const chart = chartSection(data.daily, metric, layout, chartTop);
  const height = chartTop + chart.height;
  const title = `${user.login} on tokenmaxxing.sh: ${formatTokens(stats.totalTokens)} tokens`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<style>${themeCss(options.theme, layout)}</style>`,
    `<rect class="bg" x="0" y="0" width="${WIDTH}" height="${height}"/>`,
    headerSvg(data, layout),
    ...statCells(stats, options).map((cell, index) => cellSvg(cell, index, layout)),
    gridLines(layout, chartTop),
    chart.markup,
    // Drawn last so the hairline frame sits above the chart and grid.
    `<rect class="frame" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="none"/>`,
    `</svg>`,
  ].join("\n");
}

/** A small card standing in for the real one when there is no profile or the API is down. */
function renderReadmeCardPlaceholder(
  login: string,
  theme: ReadmeCardTheme,
  reason: ReadmeCardPlaceholder,
): string {
  const height = 72;
  const message = PLACEHOLDER_MESSAGES[reason];
  const name = LOGIN_SHAPE.test(login)
    ? fitText(
        login,
        WIDTH - 2 * PAD - estimateTextWidth(BRAND, 14) - TEXT_GAP,
        PLACEHOLDER_LOGIN.size,
        PLACEHOLDER_LOGIN.min,
      )
    : null;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(message)}">`,
    `<style>${themeCss(theme)}</style>`,
    `<rect class="bg" x="0" y="0" width="${WIDTH}" height="${height}"/>`,
    `<rect class="frame" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="none"/>`,
    name === null
      ? ""
      : `<text class="fg" x="${PAD}" y="32" font-size="${name.size}" font-weight="600">${escapeXml(name.text)}</text>`,
    `<text class="muted" x="${PAD}" y="${name === null ? 41 : 51}" font-size="12">${escapeXml(message)}</text>`,
    `<text class="fg" x="${WIDTH - PAD}" y="41" font-size="14" font-weight="600" text-anchor="end">${BRAND}</text>`,
    `</svg>`,
  ].join("\n");
}

/**
 * All-time totals, labelled so they don't read as the chart's last-30-days figures. The compact
 * card's single row drops the top model (too wide) and the longest streak.
 */
function statCells(stats: Profile["stats"], options: ReadmeCardOptions): Cell[] {
  const tokens = { label: "All-time tokens", value: formatTokens(stats.totalTokens) };
  const usage: Cell[] = options.hideSpend
    ? [tokens, { label: "Sessions", value: formatInteger(stats.sessionCount) }]
    : [{ label: "All-time spend", value: formatUsd(stats.spendUsd) }, tokens];
  const activeDays = { label: "Active days", value: formatInteger(stats.activeDays) };
  const streak = formatInteger(stats.currentStreakDays);
  if (options.layout === "compact") {
    return [...usage, activeDays, { label: "Streak", value: streak }];
  }

  return [
    ...usage,
    {
      label: options.hideSpend ? "Top model by spend" : "Top spend model",
      value: stats.topModel === null ? "—" : stats.topModel.model,
    },
    activeDays,
    { label: "Current streak", value: streak },
    { label: "Longest streak", value: formatInteger(stats.longestStreakDays) },
  ];
}

function headerSvg(data: ReadmeCardData, layout: LayoutSpec): string {
  const { stats, user } = data.profile;
  const center = layout.headerHeight / 2;
  // The leaderboard rank covers the last 30 days, unlike the all-time stats beside it.
  const rank =
    stats.leaderboardRank === null ? null : `#${formatInteger(stats.leaderboardRank)} · 30d`;
  const loginX = PAD + layout.avatar + (layout.header === "inline" ? 9 : 12);
  const loginY = round2(center + layout.login.size * 0.36);
  // The login gets the line up to whatever sits right of it, and no more.
  const login = (taken: number) =>
    fitText(
      user.login,
      WIDTH - PAD - taken - TEXT_GAP - loginX,
      layout.login.size,
      layout.login.min,
    );

  if (layout.header === "inline") {
    const rankDx = 6;
    const name = login(
      estimateTextWidth(BRAND, layout.brand) +
        (rank === null ? 0 : rankDx + estimateTextWidth(rank, layout.login.size)),
    );
    const rankSpan =
      rank === null
        ? ""
        : `<tspan class="muted" font-weight="400" dx="${rankDx}">${escapeXml(rank)}</tspan>`;
    return [
      avatarSvg(data.avatarDataUri, layout),
      `<text x="${loginX}" y="${loginY}" font-size="${layout.login.size}"><tspan class="fg" font-size="${name.size}" font-weight="600">${escapeXml(name.text)}</tspan>${rankSpan}</text>`,
      `<text class="muted" x="${WIDTH - PAD}" y="${loginY}" font-size="${layout.brand}" text-anchor="end">${BRAND}</text>`,
    ].join("");
  }

  const rankLabel = rank === null ? null : `Rank ${rank}`;
  const rankSize = 11;
  const name = login(
    Math.max(
      estimateTextWidth(BRAND, layout.brand),
      rankLabel === null ? 0 : estimateTextWidth(rankLabel, rankSize),
    ),
  );
  return [
    avatarSvg(data.avatarDataUri, layout),
    `<text class="fg" x="${loginX}" y="${loginY}" font-size="${name.size}" font-weight="600">${escapeXml(name.text)}</text>`,
    `<text class="fg" x="${WIDTH - PAD}" y="${rankLabel === null ? center + 5 : center - 3}" font-size="${layout.brand}" font-weight="600" text-anchor="end">${BRAND}</text>`,
    rankLabel === null
      ? ""
      : `<text class="muted" x="${WIDTH - PAD}" y="${center + 16}" font-size="${rankSize}" text-anchor="end">${escapeXml(rankLabel)}</text>`,
  ].join("");
}

function avatarSvg(dataUri: string | null, layout: LayoutSpec): string {
  const size = layout.avatar;
  const y = (layout.headerHeight - size) / 2;
  if (dataUri === null) {
    return `<rect class="muted-bg" x="${PAD}" y="${y}" width="${size}" height="${size}"/>`;
  }

  return `<image x="${PAD}" y="${y}" width="${size}" height="${size}" href="${escapeXml(dataUri)}" preserveAspectRatio="xMidYMid slice"/>`;
}

function cellSvg(cell: Cell, index: number, layout: LayoutSpec): string {
  const column = WIDTH / layout.columns;
  const x = column * (index % layout.columns) + PAD;
  const y = layout.headerHeight + layout.rowHeight * Math.floor(index / layout.columns);
  // A long model name is set smaller, then cut, before it reaches the next
  // cell's divider or, in the last column, the card's padding.
  const lastColumn = index % layout.columns === layout.columns - 1;
  const room = column - PAD - (lastColumn ? PAD : CELL_GAP);
  const value = fitText(cell.value, room, layout.value.size, layout.value.min);

  return [
    `<text class="muted label" x="${round2(x)}" y="${y + layout.label.y}">${escapeXml(cell.label)}</text>`,
    `<text class="fg" x="${round2(x)}" y="${y + layout.value.y}" font-size="${value.size}" font-weight="600" letter-spacing="-0.3">${escapeXml(value.text)}</text>`,
  ].join("");
}

// The site's hairline grid: full-width rules plus column dividers inside the stats rows.
function gridLines(layout: LayoutSpec, chartTop: number): string {
  const rules = Array.from({ length: layout.rows + 1 }, (_, row) => {
    const y = layout.headerHeight + layout.rowHeight * row + 0.5;
    return `<line class="rule" x1="0" y1="${y}" x2="${WIDTH}" y2="${y}"/>`;
  });
  const columns = Array.from({ length: layout.columns - 1 }, (_, index) => {
    const x = Math.round((WIDTH / layout.columns) * (index + 1)) + 0.5;
    return `<line class="rule" x1="${x}" y1="${layout.headerHeight}" x2="${x}" y2="${chartTop}"/>`;
  });

  return [...rules, ...columns].join("");
}

/** "LAST 30 DAYS ........ $8,742 total | $312 avg/active day | $461 peak" */
function summarySvg(values: number[], metric: Metric, layout: LayoutSpec, top: number): string {
  const total = sum(values);
  const activeDays = values.filter((value) => value > 0).length;
  const separator = `<tspan class="sep" dx="8">|</tspan>`;
  const part = (value: number, label: string, dx = 8) =>
    `<tspan class="fg" font-weight="600" dx="${dx}">${escapeXml(formatMetric(value, metric))}</tspan><tspan class="muted" dx="4">${label}</tspan>`;
  const summary =
    total <= 0
      ? `<tspan class="muted">No usage</tspan>`
      : [
          part(total, "total", 0),
          separator,
          part(total / activeDays, "avg/active day"),
          separator,
          part(Math.max(...values), "peak"),
        ].join("");
  const y = top + layout.summary.y;

  return [
    `<text class="muted label" x="${PAD}" y="${y}">Last ${README_CARD_DAYS} days</text>`,
    `<text x="${WIDTH - PAD}" y="${y}" font-size="${layout.summary.size}" text-anchor="end">${summary}</text>`,
  ].join("");
}

/**
 * Per-day totals for the top models (the rest folded into "Other"), oldest
 * day first. Ranking, folding and colors come from the site's chart helpers,
 * so the card stacks models the way the profile page does.
 */
function modelChart(daily: Daily, metric: Metric): ModelChart {
  const dates = trailingDays(daily.range.lastDate, README_CARD_DAYS);
  const inRange = new Set(dates);
  const value = (row: Daily["days"][number]) => rowValue(row, metric);
  const rows = daily.days.filter((row) => inRange.has(row.date) && value(row) > 0);
  const selection = selectModelSeries(rows, value, STACKED_MODELS);
  const byDate = bucketSeries(rows, selection, value);
  const byModel = bucketSeries(rows, selection, value, () => "all").values.get("all");
  const colors = assignModelColors([selection.order]);

  return {
    dates,
    days: dates.map((date) => byDate.values.get(date) ?? new Map<string, number>()),
    series: selection.order.map((model) => ({
      color: colors.get(model) ?? OTHER_MODEL_SERIES_COLOR,
      model,
      total: byModel?.get(model) ?? 0,
    })),
  };
}

/** Daily bars stacked by model, with the layout's axis and date ticks, and a model legend. */
function chartSection(
  daily: Daily,
  metric: Metric,
  layout: LayoutSpec,
  top: number,
): { height: number; markup: string } {
  const chart = modelChart(daily, metric);
  const totals = chart.days.map((day) => sum(day.values()));
  const peak = Math.max(0, ...totals);
  // Without a labelled axis there's no need for round gridlines, so the peak day fills the plot.
  const axisMax = layout.yAxis.width > 0 ? niceMax(peak) : peak > 0 ? peak : 1;
  const axisGap = 6;
  const axisLabels = layout.yAxis.fractions.map((fraction) =>
    peak === 0 && fraction > 0 ? "" : formatMetric(axisMax * fraction, metric),
  );
  // The plot starts right of the widest axis label, so none reaches the card's padding.
  const axisWidth = Math.max(
    layout.yAxis.width,
    ...axisLabels.map((label) => Math.ceil(estimateTextWidth(label, layout.yAxis.size)) + axisGap),
  );
  const plotLeft = PAD + axisWidth;
  const step = (WIDTH - PAD - plotLeft + layout.bars.gap) / chart.days.length;
  const barWidth = step - layout.bars.gap;
  const barTop = top + layout.bars.top;
  const barHeight = layout.bars.height;
  const baseline = barTop + barHeight;
  const scale = (value: number) => (value / axisMax) * barHeight;
  const barX = (index: number) => plotLeft + index * step;

  // A full-height track per day keeps empty days visible as their own slot.
  const tracks = chart.days.map(
    (_, index) =>
      `<rect class="track" x="${round2(barX(index))}" y="${barTop}" width="${round2(barWidth)}" height="${barHeight}"/>`,
  );
  const gridlines = layout.yAxis.fractions.map((fraction, index) => {
    const y = round2(baseline - fraction * barHeight) + 0.5;
    const line = `<line class="rule" x1="${plotLeft}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}"/>`;
    return `${line}<text class="muted" x="${plotLeft - axisGap}" y="${round2(y + 3)}" font-size="${layout.yAxis.size}" text-anchor="end">${escapeXml(axisLabels[index] ?? "")}</text>`;
  });
  const bars = chart.days.flatMap((day, index) => {
    let barY = baseline;
    return chart.series.flatMap((series) => {
      const value = day.get(series.model) ?? 0;
      if (value <= 0) {
        return [];
      }
      // Every model keeps at least 1px, but the stack never rises past the
      // plot: on the peak day the smallest segments give way instead.
      const height = Math.min(Math.max(1, scale(value)), barY - barTop);
      if (height <= 0) {
        return [];
      }
      barY -= height;
      return [
        `<rect x="${round2(barX(index))}" y="${round2(barY)}" width="${round2(barWidth)}" height="${round2(height)}" fill="${series.color}"/>`,
      ];
    });
  });
  // Weekly date labels counted back from the last day, so the newest day is always labelled.
  const { dateLabel } = layout;
  const axisY = dateLabel === null ? baseline : baseline + dateLabel.gap;
  const dateLabels =
    dateLabel === null
      ? []
      : chart.dates.flatMap((date, index) => {
          if ((chart.dates.length - 1 - index) % 7 !== 0) {
            return [];
          }
          const center = round2(barX(index) + barWidth / 2);
          // The newest day's label ends with its bar: centred, it would run into the padding.
          const newest = index === chart.dates.length - 1;
          const label = newest
            ? `x="${WIDTH - PAD}" text-anchor="end"`
            : `x="${center}" text-anchor="middle"`;
          return [
            `<line class="rule" x1="${center}" y1="${baseline}" x2="${center}" y2="${baseline + 3}"/>`,
            `<text class="muted" ${label} y="${axisY}" font-size="${dateLabel.size}">${escapeXml(formatMonthDay(date))}</text>`,
          ];
        });
  const legendY = axisY + layout.legend.gap;

  return {
    height: legendY + layout.legend.bottom - top,
    markup: [
      summarySvg(totals, metric, layout, top),
      ...tracks,
      ...gridlines,
      ...bars,
      ...dateLabels,
      legendSvg(chart.series, sum(totals), legendY),
    ].join(""),
  };
}

function legendSvg(series: ChartSeries[], total: number, y: number): string {
  if (total <= 0) {
    return `<text class="muted" x="${PAD}" y="${y}" font-size="${LEGEND_FONT_SIZE}">No usage in the last ${README_CARD_DAYS} days</text>`;
  }

  const entries: string[] = [];
  let x = PAD;
  for (const entry of series.slice(0, LEGEND_MODELS)) {
    const name =
      entry.model === OTHER_MODEL_SERIES
        ? "Other"
        : fitText(entry.model, LEGEND_NAME_WIDTH, LEGEND_FONT_SIZE).text;
    const share = formatPercent(percentOf(entry.total, total));
    const shareDx = 5;
    // The widths are upper bounds, so entries stay apart and inside the card
    // in any system font. A name too long for the space left is skipped, so a
    // shorter one after it can still be listed.
    const width = Math.ceil(
      LEGEND_DOT_WIDTH + estimateTextWidth(name + share, LEGEND_FONT_SIZE) + shareDx,
    );
    if (x + width > WIDTH - PAD) {
      continue;
    }
    entries.push(
      `<circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${entry.color}"/>`,
      `<text x="${x + LEGEND_DOT_WIDTH}" y="${y}" font-size="${LEGEND_FONT_SIZE}"><tspan class="fg">${escapeXml(name)}</tspan><tspan class="muted" dx="${shareDx}">${share}</tspan></text>`,
    );
    x += width + TEXT_GAP;
  }

  return entries.join("");
}

function rowValue(row: Daily["days"][number], metric: Metric): number {
  return metric === "spend" ? row.spendUsd : row.totalTokens;
}

function formatMetric(value: number, metric: Metric): string {
  if (value === 0) {
    return metric === "spend" ? "$0" : "0";
  }
  return metric === "spend" ? formatUsd(value) : formatTokens(value);
}

function trailingDays(last: string, count: number): string[] {
  return enumerateDays(addDays(last, -(count - 1)), last);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function themeCss(theme: ReadmeCardTheme, layout?: LayoutSpec): string {
  const label =
    layout === undefined
      ? ""
      : `.label{font-size:${layout.label.size}px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase}`;
  const base = `text{font-family:${SANS_STACK}}${label}`;
  if (theme === "light") {
    return base + paletteCss(LIGHT_PALETTE);
  }
  if (theme === "dark") {
    return base + paletteCss(DARK_PALETTE);
  }

  return `${base}${paletteCss(LIGHT_PALETTE)}@media (prefers-color-scheme: dark){${paletteCss(DARK_PALETTE)}}`;
}

function paletteCss(palette: Palette): string {
  return [
    `.bg{fill:${palette.background}}`,
    `.fg{fill:${palette.foreground}}`,
    `.muted{fill:${palette.mutedForeground}}`,
    `.muted-bg,.track{fill:${palette.muted}}`,
    `.rule,.frame{stroke:${palette.border}}`,
    `.sep{fill:${palette.border}}`,
  ].join("");
}

export {
  modelChart,
  parseReadmeCardOptions,
  README_CARD_DAYS,
  README_CARD_LAYOUT_VERSION,
  WIDTH as README_CARD_WIDTH,
  renderReadmeCard,
  renderReadmeCardPlaceholder,
};

export type {
  ReadmeCardData,
  ReadmeCardLayout,
  ReadmeCardOptions,
  ReadmeCardPlaceholder,
  ReadmeCardTheme,
};
