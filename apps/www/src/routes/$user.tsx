import { useMemo, useState } from "react";
import { LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ProfileDailyResponse, ProfileDailyRow } from "@tokenmaxxing/api-contract";

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
import { Avatar } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { isApiError } from "../lib/api";
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

const Route = createFileRoute("/$user")({
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
        <ProfileDashboard range={daily.range} rows={daily.days} stats={stats} />
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
  longestStreakDays: number;
  peakDay: { date: string; spendUsd: number } | null;
  sessionCount: number;
  topModel: { model: string; spendUsd: number } | null;
  totalSpendUsd: number;
  totalTokens: number;
}

function ProfileDashboard({
  range,
  rows,
  stats,
}: {
  range: DailyRange;
  rows: readonly DailyRow[];
  stats: DashboardStats;
}) {
  const derived = useMemo(() => deriveCharts(rows, range), [range, rows]);
  const [hoveredSpendSeries, setHoveredSpendSeries] = useState<string | null>(null);
  const [hoveredTokensSeries, setHoveredTokensSeries] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-px border-y border-border bg-border">
      <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
        <StatCard label="Total spend" value={formatUsd(stats.totalSpendUsd)} />
        <StatCard label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <StatCard label="Sessions" value={formatCount(stats.sessionCount)} />
        <div aria-hidden="true" className="order-last bg-background" />
        <StatCard
          label="Top spend model"
          value={stats.topModel === null ? "—" : stats.topModel.model}
        />
        <StatCard label="Current streak" value={formatCount(stats.currentStreakDays)} />
        <StatCard label="Longest streak" value={formatCount(stats.longestStreakDays)} />
        <StatCard label="Active days" value={formatCount(stats.activeDays)} />
      </div>

      <section className="bg-background p-5">
        <h2 className="font-medium">Daily Spend</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`Daily spend by model across ${derived.spendDays.length} days`}
              days={derived.spendDays}
              highlight={hoveredSpendSeries}
              valueFormatter={formatUsd}
            />
          </div>
          <Legend entries={derived.spendLegend} onHover={setHoveredSpendSeries} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Daily Tokens</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`Daily tokens by model across ${derived.tokenDays.length} days`}
              days={derived.tokenDays}
              highlight={hoveredTokensSeries}
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

function deriveCharts(rows: readonly DailyRow[], range: DailyRange) {
  const colors = seriesColors(rows);
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
    // getUTCDay() is Sunday-first; shift to Monday-first. UTC avoids tz drift.
    const weekday = (new Date(`${row.date}T00:00:00Z`).getUTCDay() + 6) % 7;
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

  const allDays = enumerateDays(range.first, range.last);
  const heatmapRange = {
    first: calendarYearStart(range.last),
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

  const chartedDays = allDays;
  const spendDays = buildStackedDays(
    chartedDays,
    spendSelection.order,
    colors,
    spendSeriesByDate,
    spendByDate,
  );
  const tokenDays = buildStackedDays(
    chartedDays,
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
  days: readonly string[],
  seriesOrder: readonly string[],
  colors: ReadonlyMap<string, string>,
  seriesByDate: ReadonlyMap<string, ReadonlyMap<string, number>>,
  totalsByDate: ReadonlyMap<string, number>,
): StackedDay[] {
  return days.map((date) => {
    const seriesValues = seriesByDate.get(date);
    return {
      date,
      segments: seriesOrder.map((series) => ({
        color: colors.get(series) ?? "#9ca3af",
        series,
        value: seriesValues?.get(series) ?? 0,
      })),
      total: totalsByDate.get(date) ?? 0,
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
  const out: string[] = [];
  const cursor = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${last.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return out;
}

function calendarYearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

function calendarYearEnd(date: string): string {
  return `${date.slice(0, 4)}-12-31`;
}

export { deriveCharts, Route };
