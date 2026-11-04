/**
 * The one set of display formatters. Pages, charts, and the OG card all use
 * these so the same number reads the same everywhere. Every formatter pins
 * `en-US` (and UTC for dates) so SSR and hydration render identical strings.
 */

const USD0_OPTIONS = {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
} as const satisfies Intl.NumberFormatOptions;

const USD2_OPTIONS = {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
} as const satisfies Intl.NumberFormatOptions;

const USD_COMPACT_OPTIONS = {
  currency: "USD",
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
  notation: "compact",
  style: "currency",
} as const satisfies Intl.NumberFormatOptions;

const INTEGER_OPTIONS = { maximumFractionDigits: 0 } as const satisfies Intl.NumberFormatOptions;

const usd0 = new Intl.NumberFormat("en-US", USD0_OPTIONS);

const usd2 = new Intl.NumberFormat("en-US", USD2_OPTIONS);

const integer = new Intl.NumberFormat("en-US", INTEGER_OPTIONS);

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

const usdCompact = new Intl.NumberFormat("en-US", USD_COMPACT_OPTIONS);

/**
 * Compact notation tops out at "T", so anything this large (or non-finite)
 * would print as a run of digits and break the layout. Real usage is nowhere
 * near it; such values are fabricated, so they render as a fixed-width cap.
 */
const DISPLAY_CEILING = 1e15;

/** Whole dollars from $100, compact from $1M ("$1.2M"), capped at ">$999T". */
function formatUsd(value: number): string {
  if (Number.isNaN(value)) {
    return "—";
  }
  const magnitude = Math.abs(value);
  if (magnitude >= DISPLAY_CEILING) {
    return value < 0 ? "<-$999T" : ">$999T";
  }
  if (magnitude >= 1e6) {
    return usdCompact.format(value);
  }

  return magnitude >= 100 ? usd0.format(value) : usd2.format(value);
}

function formatTokens(value: number): string {
  if (Number.isNaN(value)) {
    return "—";
  }
  const magnitude = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (magnitude >= DISPLAY_CEILING) {
    return value < 0 ? "<-999T" : ">999T";
  }
  if (magnitude >= 1e12) {
    return `${sign}${(magnitude / 1e12).toFixed(2)}T`;
  }
  if (magnitude >= 1e9) {
    return `${sign}${(magnitude / 1e9).toFixed(2)}B`;
  }
  if (magnitude >= 1e6) {
    return `${sign}${(magnitude / 1e6).toFixed(1)}M`;
  }
  if (magnitude >= 1e3) {
    return `${sign}${(magnitude / 1e3).toFixed(1)}K`;
  }

  return value.toFixed(0);
}

/**
 * A number as an animated display (NumberFlow) renders it: `value` formatted
 * en-US with `format`, between `prefix` and `suffix`. Each `*Display` below
 * mirrors its `format*` twin exactly (format.test.ts holds them equal), and is
 * null where that twin prints a cap or a dash instead of a number.
 *
 * Twins that print with `toFixed` hand over a value already rounded by it:
 * `toFixed` rounds the exact binary value (9.95 → "9.9") while Intl rounds
 * its shortest decimal form (9.95 → "10.0").
 */
interface NumberDisplay {
  /** No scientific or engineering notation: NumberFlow can't animate them. */
  format: Omit<Intl.NumberFormatOptions, "notation"> & { notation?: "compact" | "standard" };
  prefix?: string;
  suffix?: string;
  value: number;
}

/** `value` rounded as `toFixed(digits)` prints it, as a number Intl prints identically. */
function toFixedValue(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  // `toFixed` signs any negative value that rounds to zero (-0.004 → "-0") but
  // never -0 itself; Intl signs exactly -0.
  return rounded === 0 ? (value < 0 ? -0 : 0) : rounded;
}

/** {@link formatUsd} as a {@link NumberDisplay}. */
function usdDisplay(value: number): NumberDisplay | null {
  const magnitude = Math.abs(value);
  if (Number.isNaN(value) || magnitude >= DISPLAY_CEILING) {
    return null;
  }
  const format =
    magnitude >= 1e6 ? USD_COMPACT_OPTIONS : magnitude >= 100 ? USD0_OPTIONS : USD2_OPTIONS;

  return { format, value };
}

/** Units `formatTokens` steps through, largest first. */
const TOKEN_UNITS = [
  { decimals: 2, divisor: 1e12, suffix: "T" },
  { decimals: 2, divisor: 1e9, suffix: "B" },
  { decimals: 1, divisor: 1e6, suffix: "M" },
  { decimals: 1, divisor: 1e3, suffix: "K" },
] as const;

/** {@link formatTokens} as a {@link NumberDisplay}. */
function tokensDisplay(value: number): NumberDisplay | null {
  const magnitude = Math.abs(value);
  if (Number.isNaN(value) || magnitude >= DISPLAY_CEILING) {
    return null;
  }
  const unit = TOKEN_UNITS.find((candidate) => magnitude >= candidate.divisor);
  if (unit === undefined) {
    // `toFixed` prints -0 as "0"; Intl would keep the sign.
    return {
      format: { maximumFractionDigits: 0, useGrouping: false },
      value: toFixedValue(value, 0),
    };
  }

  return {
    format: {
      maximumFractionDigits: unit.decimals,
      minimumFractionDigits: unit.decimals,
      // `toFixed` never groups, so a value just under the next unit reads "1000.0M".
      useGrouping: false,
    },
    suffix: unit.suffix,
    value: toFixedValue(value / unit.divisor, unit.decimals),
  };
}

/** {@link formatInteger} as a {@link NumberDisplay}. */
function integerDisplay(value: number): NumberDisplay | null {
  return Number.isNaN(value) || Math.abs(value) >= DISPLAY_CEILING
    ? null
    : { format: INTEGER_OPTIONS, value };
}

/** {@link formatPercent} (one decimal) as a {@link NumberDisplay}. */
function percentDisplay(value: number): NumberDisplay | null {
  return Number.isFinite(value)
    ? {
        format: { maximumFractionDigits: 1, minimumFractionDigits: 1, useGrouping: false },
        suffix: "%",
        value: toFixedValue(value, 1),
      }
    : null;
}

/** Grouped digits for counts; values past the display ceiling go compact. */
function formatInteger(value: number): string {
  return Math.abs(value) >= DISPLAY_CEILING || Number.isNaN(value)
    ? formatCompact(value)
    : integer.format(value);
}

/** "1 user", "2 users": the formatted count plus the singular or plural noun. */
function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatInteger(value)} ${value === 1 ? singular : plural}`;
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
  if (Number.isNaN(value)) {
    return "—";
  }
  if (Math.abs(value) >= DISPLAY_CEILING) {
    return value < 0 ? "<-999T" : ">999T";
  }

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
const dayShort = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
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

/** An inclusive span of YYYY-MM-DD keys, e.g. "Oct 20 – 22, 2026"; one day reads as `formatDay`. */
function formatDayRange(first: string, last: string): string {
  return first === last
    ? formatDay(first)
    : dayShort.formatRange(new Date(`${first}T00:00:00Z`), new Date(`${last}T00:00:00Z`));
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
  formatCount,
  formatDateTimeUtc,
  formatDay,
  formatDayRange,
  formatInteger,
  formatMonth,
  formatMonthLong,
  formatPercent,
  formatTokens,
  formatUsd,
  integerDisplay,
  percentDisplay,
  percentOf,
  tokensDisplay,
  usdDisplay,
};

export type { NumberDisplay };
