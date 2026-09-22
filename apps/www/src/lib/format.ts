/**
 * The one set of display formatters. Pages, charts, and the OG card all use
 * these so the same number reads the same everywhere. Every formatter pins
 * `en-US` (and UTC for dates) so SSR and hydration render identical strings.
 */

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

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** Whole dollars from $100 up, cents below. */
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

function formatInteger(value: number): string {
  return integer.format(value);
}

/** `value` is already a percentage (0–100). */
function formatPercent(value: number, fractionDigits = 1): string {
  return `${value.toFixed(fractionDigits)}%`;
}

/** Share of `part` in `total` as a percentage, 0 when there is no total. */
function percentOf(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

function formatCompact(value: number): string {
  return compact.format(value);
}

const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthLong = new Intl.DateTimeFormat("en-US", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});
const dayLong = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
});
const dateTimeUtc = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  timeZoneName: "short",
  year: "numeric",
});

/** Opaque YYYY-MM-DD keys render via UTC so no local-tz shifting occurs. */
function formatDay(date: string): string {
  return dayLong.format(new Date(`${date}T00:00:00Z`));
}

/** Short month name for a YYYY-MM (or YYYY-MM-DD) key, e.g. "Jun". */
function formatMonth(month: string): string {
  return monthShort.format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

/** Full month + year, e.g. "June 2026" — used in tooltips. */
function formatMonthLong(month: string): string {
  return monthLong.format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

/** A timestamp in UTC — deterministic across server and browser. */
function formatDateTimeUtc(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? dateTimeUtc.format(time) : iso;
}

export {
  formatCompact,
  formatDateTimeUtc,
  formatDay,
  formatInteger,
  formatMonth,
  formatMonthLong,
  formatPercent,
  formatTokens,
  formatUsd,
  percentOf,
};
