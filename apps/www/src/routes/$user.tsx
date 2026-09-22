import { useMemo, useState } from "react";
import { LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, stripSearchParams } from "@tanstack/react-router";
import type { ProfileDailyResponse, ProfileDailyRow } from "@tokenmaxxing/api-contract";
import { z } from "zod";

type DailyRow = typeof ProfileDailyRow.Type;
type DailyRange = (typeof ProfileDailyResponse.Type)["range"];

import { Heatmap } from "../components/charts/heatmap";
import { MonthBars } from "../components/charts/month-bars";
import {
  enumerateDays,
  formatTokens,
  formatUsd,
  selectModelSeries,
  seriesColors,
} from "../components/charts/scale";
import { Legend, StackedBars, type StackedDay } from "../components/charts/stacked-bars";
import { WeekdayBars } from "../components/charts/weekday-bars";
import { StatCard } from "../components/stat-card";
import { TimeRangeSelect } from "../components/time-range-select";
import { Avatar } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { isApiError } from "../lib/api";
import {
  chartBuckets,
  chartRange,
  formatDateRange,
  TIME_RANGE_VALUES,
  weekdayIndex,
  type DateRange,
  type TimeRange,
} from "../lib/chart-range";
import { breadcrumbSchema, profilePageSchema } from "../lib/jsonld";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  profileOgDescription,
  profileOgImageUrl,
  profileOgTitle,
  profileUrl,
} from "../lib/og";
import { profileDailyQueryOptions, profileQueryOptions } from "../lib/queries";

const profileSearchSchema = z.object({
  range: z.enum(TIME_RANGE_VALUES).default("3m").catch("3m"),
});

const Route = createFileRoute("/$user")({
  validateSearch: profileSearchSchema,
  search: {
    middlewares: [stripSearchParams({ range: "3m" })],
  },
  loader: async ({ context, params }) => {
    try {
      const [profile, daily] = await Promise.all([
        context.queryClient.ensureQueryData(profileQueryOptions(params.user)),
        context.queryClient.ensureQueryData(profileDailyQueryOptions(params.user)),
      ]);

      return { daily, profile };
    } catch (error) {
      if (isApiError(error, "UserNotFound")) {
        throw notFound();
      }

      throw error;
    }
  },
  head: ({ loaderData }) => {
    if (loaderData === undefined) {
      return {};
    }

    const profile = loaderData.profile;
    const title = profileOgTitle(profile);
    const description = profileOgDescription(profile);
    const image = profileOgImageUrl(profile);
    const url = profileUrl(profile);

    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "profile" },
        { property: "og:url", content: url },
        { property: "og:image", content: image },
        { property: "og:image:width", content: String(OG_IMAGE_WIDTH) },
        { property: "og:image:height", content: String(OG_IMAGE_HEIGHT) },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: image },
      ],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify(profilePageSchema(profile)),
        },
        {
          type: "application/ld+json",
          children: JSON.stringify(breadcrumbSchema(profile.user.login, url)),
        },
      ],
    };
  },
  component: ProfilePage,
});

const countFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function ProfilePage() {
  const { user } = Route.useParams();
  const { range: timeRange } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: profile } = useSuspenseQuery(profileQueryOptions(user));
  const { data: daily } = useSuspenseQuery(profileDailyQueryOptions(user));
  const { stats } = profile;
  const owner = profile.user;

  return (
    <>
      <header className="flex items-center justify-between gap-4 px-4 py-8">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar alt={`${owner.login} avatar`} priority size={56} src={owner.avatarUrl} />
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{owner.login}</h1>
        </div>
        <ProfileShareButton url={profileUrl(profile)} />
      </header>

      {daily.days.length === 0 ? (
        <div className="px-4">
          <Card className="p-6 text-sm text-muted-foreground">
            No usage yet — run <Code>tokenmaxxing sync</Code> to fill this page.
          </Card>
        </div>
      ) : (
        <ProfileDashboard
          onRangeChange={(range) =>
            void navigate({ search: { range }, resetScroll: false, replace: true })
          }
          range={daily.range}
          rows={daily.days}
          stats={stats}
          timeRange={timeRange}
        />
      )}
    </>
  );
}

function ProfileShareButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const copyProfileUrl = async () => {
    if (navigator.clipboard === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      return;
    }
  };

  return (
    <Button
      aria-label={copied ? "Profile link copied" : "Share profile"}
      className="shrink-0"
      onClick={() => void copyProfileUrl()}
      size="sm"
      variant="outline"
    >
      <LinkSimple className="size-4" />
      {copied ? "Copied" : "Share"}
    </Button>
  );
}

interface DashboardStats {
  activeDays: number;
  avgSpendPerActiveDay: number;
  currentStreakDays: number;
  firstDate: string | null;
  lastDate: string | null;
  leaderboardRank: number | null;
  longestStreakDays: number;
  peakDay: { date: string; spendUsd: number } | null;
  sessionCount: number;
  topModel: { model: string; spendUsd: number } | null;
  totalSpendUsd: number;
  totalTokens: number;
}

function ProfileDashboard({
  onRangeChange,
  range,
  rows,
  stats,
  timeRange,
}: {
  onRangeChange: (value: TimeRange) => void;
  range: DailyRange;
  rows: readonly DailyRow[];
  stats: DashboardStats;
  timeRange: TimeRange;
}) {
  const selected = useMemo(
    () => chartRange(timeRange, range.last, stats.firstDate),
    [timeRange, range.last, stats.firstDate],
  );
  const derived = useMemo(
    () => deriveCharts(rows, selected.range, selected.bucketDays),
    [selected, rows],
  );
  const bucketLabel = selected.bucketDays === 1 ? "Daily" : `${selected.bucketDays}-day`;
  const [hoveredSpendSeries, setHoveredSpendSeries] = useState<string | null>(null);
  const [hoveredTokensSeries, setHoveredTokensSeries] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-px border-y border-border bg-border">
      <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
        <StatCard label="Total spend" value={formatUsd(stats.totalSpendUsd)} />
        <StatCard label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <StatCard label="Sessions" value={formatCount(stats.sessionCount)} />
        <StatCard
          label="Top spend model"
          value={stats.topModel === null ? "—" : stats.topModel.model}
        />
        <StatCard label="Current streak" value={formatCount(stats.currentStreakDays)} />
        <StatCard label="Longest streak" value={formatCount(stats.longestStreakDays)} />
        <StatCard label="Active days" value={formatCount(stats.activeDays)} />
        <StatCard
          label="Leaderboard rank"
          value={stats.leaderboardRank === null ? "—" : `#${formatCount(stats.leaderboardRank)}`}
        />
      </div>

      <section
        aria-label="Chart time range"
        className="flex flex-wrap items-center justify-between gap-3 bg-background px-5 py-4"
      >
        <div>
          <h2 className="text-sm font-medium">Usage over time</h2>
          <p aria-live="polite" className="mt-1 text-xs text-muted-foreground">
            {formatDateRange(selected.range.first, selected.range.last)}
            <span aria-hidden className="px-2">
              ·
            </span>
            {bucketLabel} totals
          </p>
        </div>
        <TimeRangeSelect onChange={onRangeChange} value={timeRange} />
      </section>

      {derived.spendLegend.length === 0 ? (
        <p className="bg-background px-5 py-4 text-sm text-muted-foreground">
          No usage in this period. Try a longer time range.
        </p>
      ) : null}

      <section className="bg-background p-5">
        <h2 className="font-medium">Spend</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`${bucketLabel} spend by model across ${derived.spendDays.length} buckets`}
              days={derived.spendDays}
              highlight={hoveredSpendSeries}
              key={timeRange}
              valueFormatter={formatUsd}
            />
          </div>
          <Legend entries={derived.spendLegend} onHover={setHoveredSpendSeries} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Tokens</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`${bucketLabel} tokens by model across ${derived.tokenDays.length} buckets`}
              days={derived.tokenDays}
              highlight={hoveredTokensSeries}
              key={timeRange}
              valueFormatter={formatTokens}
            />
          </div>
          <Legend entries={derived.tokenLegend} onHover={setHoveredTokensSeries} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Activity Heatmap</h2>
        <div className="mt-4">
          {derived.heatmap !== null ? (
            <Heatmap
              activeRange={selected.range}
              byDate={derived.spendByDate}
              first={derived.heatmap.first}
              last={derived.heatmap.last}
              segmentsByDate={derived.segmentsByDate}
            />
          ) : null}
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Most Active Time</h2>
        <div className="mt-4">
          <WeekdayBars spend={derived.spendByWeekday} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Monthly Spend</h2>
        <div className="mt-4">
          <MonthBars months={derived.months} />
        </div>
      </section>
    </div>
  );
}

function deriveCharts(allRows: readonly DailyRow[], range: DailyRange, bucketDays = 1) {
  const rows = allRows.filter((row) => row.date >= range.first && row.date <= range.last);
  const colors = seriesColors(allRows);
  const spendSelection = selectModelSeries(rows, (row) => row.costUsd);
  const tokenSelection = selectModelSeries(rows, (row) => row.totalTokens);

  // Per-day totals and per-day raw-model segments.
  const spendByDate = new Map<string, number>();
  const tokenByDate = new Map<string, number>();
  const spendSeriesByDate = new Map<string, Map<string, number>>();
  const tokenSeriesByDate = new Map<string, Map<string, number>>();
  const spendByMonth = new Map<string, number>();
  const seriesByMonth = new Map<string, Map<string, number>>();
  // Spend bucketed by weekday, Monday-first: [0]=Mon … [6]=Sun.
  const spendByWeekday = [0, 0, 0, 0, 0, 0, 0];
  let outputTokens = 0;
  for (const row of rows) {
    outputTokens += row.outputTokens;
    spendByDate.set(row.date, (spendByDate.get(row.date) ?? 0) + row.costUsd);
    tokenByDate.set(row.date, (tokenByDate.get(row.date) ?? 0) + row.totalTokens);
    const weekday = weekdayIndex(row.date);
    spendByWeekday[weekday] = (spendByWeekday[weekday] ?? 0) + row.costUsd;
    const spendModel = spendSelection.label(row.key);
    const spendSeries = spendSeriesByDate.get(row.date) ?? new Map<string, number>();
    spendSeries.set(spendModel, (spendSeries.get(spendModel) ?? 0) + row.costUsd);
    spendSeriesByDate.set(row.date, spendSeries);
    const tokenModel = tokenSelection.label(row.key);
    const tokenSeries = tokenSeriesByDate.get(row.date) ?? new Map<string, number>();
    tokenSeries.set(tokenModel, (tokenSeries.get(tokenModel) ?? 0) + row.totalTokens);
    tokenSeriesByDate.set(row.date, tokenSeries);

    const month = row.date.slice(0, 7);
    spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + row.costUsd);
    const monthSeries = seriesByMonth.get(month) ?? new Map<string, number>();
    monthSeries.set(spendModel, (monthSeries.get(spendModel) ?? 0) + row.costUsd);
    seriesByMonth.set(month, monthSeries);
  }

  const buckets = chartBuckets(range, bucketDays);
  const heatmapRange = {
    first: calendarYearStart(range.first),
    last: calendarYearEnd(range.last),
  };

  const segmentsByDate = new Map(
    [...spendSeriesByDate.entries()].map(([date, seriesValues]) => [
      date,
      spendSelection.order.map((series) => ({
        color: colors.get(series) ?? "#9ca3af",
        series,
        value: seriesValues.get(series) ?? 0,
      })),
    ]),
  );

  const spendDays = buildStackedDays(
    buckets,
    spendSelection.order,
    colors,
    spendSeriesByDate,
    spendByDate,
  );
  const tokenDays = buildStackedDays(
    buckets,
    tokenSelection.order,
    colors,
    tokenSeriesByDate,
    tokenByDate,
  );

  const months = enumerateCalendarMonths(range.first, range.last).map((month) => ({
    month,
    segments: spendSelection.order.map((series) => ({
      color: colors.get(series) ?? "#9ca3af",
      series,
      value: seriesByMonth.get(month)?.get(series) ?? 0,
    })),
    value: spendByMonth.get(month) ?? 0,
  }));

  return {
    heatmap: heatmapRange,
    months,
    outputTokens,
    segmentsByDate,
    spendByDate,
    spendDays,
    spendLegend: buildLegend(spendDays, colors),
    spendByWeekday,
    tokenDays,
    tokenLegend: buildLegend(tokenDays, colors),
  };
}

function buildStackedDays(
  buckets: readonly DateRange[],
  seriesOrder: readonly string[],
  colors: ReadonlyMap<string, string>,
  seriesByDate: ReadonlyMap<string, ReadonlyMap<string, number>>,
  totalsByDate: ReadonlyMap<string, number>,
): StackedDay[] {
  return buckets.map(({ first, last }) => {
    const seriesValues = new Map<string, number>();
    let total = 0;
    for (const date of enumerateDays(first, last)) {
      total += totalsByDate.get(date) ?? 0;
      for (const [series, value] of seriesByDate.get(date) ?? []) {
        seriesValues.set(series, (seriesValues.get(series) ?? 0) + value);
      }
    }
    return {
      date: first,
      endDate: last,
      segments: seriesOrder.map((series) => ({
        color: colors.get(series) ?? "#9ca3af",
        series,
        value: seriesValues?.get(series) ?? 0,
      })),
      total,
    };
  });
}

function buildLegend(days: readonly StackedDay[], colors: ReadonlyMap<string, string>) {
  const valueBySeries = new Map<string, number>();
  let total = 0;
  for (const day of days) {
    for (const segment of day.segments) {
      valueBySeries.set(segment.series, (valueBySeries.get(segment.series) ?? 0) + segment.value);
      total += segment.value;
    }
  }

  return [...colors.keys()]
    .map((series) => ({
      color: colors.get(series) ?? "#9ca3af",
      percent: total > 0 ? ((valueBySeries.get(series) ?? 0) / total) * 100 : 0,
      series,
      value: valueBySeries.get(series) ?? 0,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .map(({ color, percent, series }) => ({ color, percent, series }));
}

function enumerateCalendarMonths(first: string, last: string): string[] {
  return [...new Set(enumerateDays(first, last).map((date) => date.slice(0, 7)))];
}

function calendarYearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

function calendarYearEnd(date: string): string {
  return `${date.slice(0, 4)}-12-31`;
}

export { deriveCharts, Route };
