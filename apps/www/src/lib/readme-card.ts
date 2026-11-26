import type { ProfileDailyResponse, ProfileResponse } from "@tokenmaxxing/api-contract";

import {
  assignModelColors,
  OTHER_MODEL_SERIES,
  OTHER_MODEL_SERIES_COLOR,
} from "../components/charts/model-colors";
import { niceMax } from "../components/charts/scale";
import { addDays, enumerateDays } from "./dates";
import { formatInteger, formatMonthDay, formatTokens, formatUsd } from "./format";

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

/** Geist Sans as `data:` URIs; without them the card falls back to system fonts. */
interface ReadmeCardFonts {
  regular: string;
  semibold: string;
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
  login: number;
  rowHeight: number;
  rows: number;
  summary: { size: number; y: number };
  value: { size: number; y: number };
  yAxis: { fractions: readonly number[]; width: number };
}

const WIDTH = 600;
const PAD = 20;
const STACKED_MODELS = 5;
const LEGEND_MODELS = 3;
const README_CARD_DAYS = 30;

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
    login: 20,
    rowHeight: 64,
    rows: 2,
    summary: { size: 12, y: 26 },
    value: { size: 20, y: 50 },
    yAxis: { fractions: [0, 0.5, 1], width: 46 },
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
    login: 15,
    rowHeight: 48,
    rows: 1,
    summary: { size: 11, y: 18 },
    value: { size: 17, y: 38 },
    yAxis: { fractions: [], width: 0 },
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

const SANS_STACK =
  "'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function parseReadmeCardOptions(searchParams: URLSearchParams): ReadmeCardOptions {
  const theme = searchParams.get("theme");
  const hidden = (searchParams.get("hide") ?? "").split(",").map((value) => value.trim());

  return {
    hideSpend: hidden.includes("spend"),
    layout: searchParams.get("layout") === "compact" ? "compact" : "full",
    theme: theme === "dark" || theme === "light" ? theme : "auto",
  };
}

function renderReadmeCard(
  data: ReadmeCardData,
  options: ReadmeCardOptions,
  fonts: ReadmeCardFonts | null = null,
): string {
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
    `<style>${themeCss(options.theme, fonts, layout)}</style>`,
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
  fonts: ReadmeCardFonts | null = null,
): string {
  const height = 72;
  const message = PLACEHOLDER_MESSAGES[reason];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(message)}">`,
    `<style>${themeCss(theme, fonts)}</style>`,
    `<rect class="bg" x="0" y="0" width="${WIDTH}" height="${height}"/>`,
    `<rect class="frame" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="none"/>`,
    `<text class="fg" x="${PAD}" y="32" font-size="15" font-weight="600">${escapeXml(truncate(login, 40))}</text>`,
    `<text class="muted" x="${PAD}" y="51" font-size="12">${escapeXml(message)}</text>`,
    `<text class="fg" x="${WIDTH - PAD}" y="41" font-size="14" font-weight="600" text-anchor="end">tokenmaxxing.sh</text>`,
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
      value: stats.topModel === null ? "—" : truncate(stats.topModel.model, 16),
    },
    activeDays,
    { label: "Current streak", value: streak },
    { label: "Longest streak", value: formatInteger(stats.longestStreakDays) },
  ];
}

function headerSvg(data: ReadmeCardData, layout: LayoutSpec): string {
  const { stats, user } = data.profile;
  const center = layout.headerHeight / 2;
  const rank = stats.leaderboardRank === null ? null : `#${formatInteger(stats.leaderboardRank)}`;
  const loginX = PAD + layout.avatar + (layout.header === "inline" ? 9 : 12);
  const loginY = fixed(center + layout.login * 0.36);

  if (layout.header === "inline") {
    const rankSpan =
      rank === null
        ? ""
        : `<tspan class="muted" font-weight="400" dx="6">${escapeXml(rank)}</tspan>`;
    return [
      avatarSvg(data.avatarDataUri, layout),
      `<text x="${loginX}" y="${loginY}" font-size="${layout.login}"><tspan class="fg" font-weight="600">${escapeXml(truncate(user.login, 32))}</tspan>${rankSpan}</text>`,
      `<text class="muted" x="${WIDTH - PAD}" y="${loginY}" font-size="${layout.brand}" text-anchor="end">tokenmaxxing.sh</text>`,
    ].join("");
  }

  return [
    avatarSvg(data.avatarDataUri, layout),
    `<text class="fg" x="${loginX}" y="${loginY}" font-size="${layout.login}" font-weight="600">${escapeXml(truncate(user.login, 28))}</text>`,
    `<text class="fg" x="${WIDTH - PAD}" y="${rank === null ? center + 5 : center - 3}" font-size="${layout.brand}" font-weight="600" text-anchor="end">tokenmaxxing.sh</text>`,
    rank === null
      ? ""
      : `<text class="muted" x="${WIDTH - PAD}" y="${center + 16}" font-size="11" text-anchor="end">Leaderboard ${escapeXml(rank)}</text>`,
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
  const x = (WIDTH / layout.columns) * (index % layout.columns) + PAD;
  const y = layout.headerHeight + layout.rowHeight * Math.floor(index / layout.columns);

  return [
    `<text class="muted label" x="${fixed(x)}" y="${y + layout.label.y}">${escapeXml(cell.label)}</text>`,
    `<text class="fg" x="${fixed(x)}" y="${y + layout.value.y}" font-size="${layout.value.size}" font-weight="600" letter-spacing="-0.3">${escapeXml(cell.value)}</text>`,
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

/** Per-day totals for the top models (the rest folded into "Other"), oldest day first. */
function modelChart(daily: Daily, metric: Metric): ModelChart {
  const dates = trailingDays(daily.range.lastDate, README_CARD_DAYS);
  const inRange = new Set(dates);
  const totals = new Map<string, number>();
  for (const row of daily.days) {
    if (inRange.has(row.date)) {
      totals.set(row.key, (totals.get(row.key) ?? 0) + rowValue(row, metric));
    }
  }

  const ranked = [...totals].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1]);
  const fold = ranked.length > STACKED_MODELS;
  const named = ranked.slice(0, fold ? STACKED_MODELS - 1 : STACKED_MODELS).map(([model]) => model);
  const namedSet = new Set(named);
  const colors = assignModelColors([named]);
  const keyOf = (model: string) => (namedSet.has(model) ? model : OTHER_MODEL_SERIES);

  const byDate = new Map(dates.map((date) => [date, new Map<string, number>()]));
  for (const row of daily.days) {
    const day = byDate.get(row.date);
    if (day !== undefined) {
      const key = keyOf(row.key);
      day.set(key, (day.get(key) ?? 0) + rowValue(row, metric));
    }
  }

  const series: ChartSeries[] = named.map((model) => ({
    color: colors.get(model) ?? OTHER_MODEL_SERIES_COLOR,
    model,
    total: totals.get(model) ?? 0,
  }));
  if (fold) {
    const otherTotal = ranked.slice(named.length).reduce((sum, [, total]) => sum + total, 0);
    series.push({ color: OTHER_MODEL_SERIES_COLOR, model: OTHER_MODEL_SERIES, total: otherTotal });
  }

  return { dates, days: dates.map((date) => byDate.get(date) ?? new Map()), series };
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
  const plotLeft = PAD + layout.yAxis.width;
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
      `<rect class="track" x="${fixed(barX(index))}" y="${barTop}" width="${fixed(barWidth)}" height="${barHeight}"/>`,
  );
  const gridlines = layout.yAxis.fractions.map((fraction) => {
    const y = fixed(baseline - fraction * barHeight) + 0.5;
    const line = `<line class="rule" x1="${plotLeft}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}"/>`;
    const label = peak === 0 && fraction > 0 ? "" : formatMetric(axisMax * fraction, metric);
    return `${line}<text class="muted" x="${plotLeft - 6}" y="${fixed(y + 3)}" font-size="9.5" text-anchor="end">${escapeXml(label)}</text>`;
  });
  const bars = chart.days.flatMap((day, index) => {
    let barY = baseline;
    return chart.series.flatMap((series) => {
      const value = day.get(series.model) ?? 0;
      if (value <= 0) {
        return [];
      }
      const height = Math.max(1, scale(value));
      barY -= height;
      return [
        `<rect x="${fixed(barX(index))}" y="${fixed(barY)}" width="${fixed(barWidth)}" height="${fixed(height)}" fill="${series.color}"/>`,
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
          const center = fixed(barX(index) + barWidth / 2);
          return [
            `<line class="rule" x1="${center}" y1="${baseline}" x2="${center}" y2="${baseline + 3}"/>`,
            `<text class="muted" x="${center}" y="${axisY}" font-size="${dateLabel.size}" text-anchor="middle">${escapeXml(formatMonthDay(date))}</text>`,
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
    return `<text class="muted" x="${PAD}" y="${y}" font-size="11">No usage in the last ${README_CARD_DAYS} days</text>`;
  }

  const entries: string[] = [];
  let x = PAD;
  for (const entry of series.slice(0, LEGEND_MODELS)) {
    const name = entry.model === OTHER_MODEL_SERIES ? "Other" : truncate(entry.model, 22);
    const share = `${((entry.total / total) * 100).toFixed(1)}%`;
    // Geist's average glyph is ~0.6em; close enough to keep entries apart and inside the card.
    const width = 14 + (name.length + share.length) * 6.4 + 5;
    if (x + width > WIDTH - PAD) {
      break;
    }
    entries.push(
      `<circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${entry.color}"/>`,
      `<text x="${x + 14}" y="${y}" font-size="11"><tspan class="fg">${escapeXml(name)}</tspan><tspan class="muted" dx="5">${share}</tspan></text>`,
    );
    x += width + 20;
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

function fixed(value: number): number {
  return Math.round(value * 100) / 100;
}

// Two embedded weights keep the card small; labels (500) render with the 600 file.
function themeCss(
  theme: ReadmeCardTheme,
  fonts: ReadmeCardFonts | null,
  layout?: LayoutSpec,
): string {
  const fontFaces =
    fonts === null
      ? ""
      : `@font-face{font-family:'Geist Sans';font-weight:100 499;src:url(${fonts.regular}) format('woff2')}` +
        `@font-face{font-family:'Geist Sans';font-weight:500 900;src:url(${fonts.semibold}) format('woff2')}`;
  const label =
    layout === undefined
      ? ""
      : `.label{font-size:${layout.label.size}px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase}`;
  const base = `${fontFaces}text{font-family:${SANS_STACK}}${label}`;
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export {
  modelChart,
  parseReadmeCardOptions,
  README_CARD_DAYS,
  WIDTH as README_CARD_WIDTH,
  renderReadmeCard,
  renderReadmeCardPlaceholder,
};

export type {
  ReadmeCardData,
  ReadmeCardFonts,
  ReadmeCardLayout,
  ReadmeCardOptions,
  ReadmeCardPlaceholder,
  ReadmeCardTheme,
};
