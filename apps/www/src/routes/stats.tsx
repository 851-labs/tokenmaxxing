import { useEffect, useMemo, useState } from "react";
import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type {
  StatsDailyModelPoint,
  StatsRankedMetric,
  StatsResponse,
  StatsTotals,
} from "@tokenmaxxing/api-contract";

import {
  enumerateDays,
  formatTokens,
  formatUsd,
  selectModelSeries,
  seriesColors,
} from "../components/charts/scale";
import { Legend, StackedBars, type StackedDay } from "../components/charts/stacked-bars";
import { StatCard } from "../components/stat-card";
import { Tabs } from "../components/ui/tabs";
import { statsQueryOptions } from "../lib/queries";
import { z } from "zod";

type Stats = typeof StatsResponse.Type;
type Totals = typeof StatsTotals.Type;
type DailyModelPoint = typeof StatsDailyModelPoint.Type;
type RankedMetric = typeof StatsRankedMetric.Type;
interface SelectedStats {
  chartLastDate: string | null;
  dailyByModel: DailyModelPoint[];
  label: string;
  modelsBySpend: readonly RankedMetric[];
  modelsByTokens: readonly RankedMetric[];
  sources: readonly RankedMetric[];
  totals: Totals;
}

const STATS_WINDOW_VALUES = ["30d", "2026"] as const;
const statsSearchSchema = z.object({
  window: z.enum(STATS_WINDOW_VALUES).default("30d").catch("30d"),
});

type StatsSearch = z.infer<typeof statsSearchSchema>;
type StatsWindow = StatsSearch["window"];
type ChartMode = "absolute" | "share";

const DEFAULT_STATS_SEARCH = {
  window: "30d",
} as const satisfies StatsSearch;

const WINDOWS: { label: string; value: StatsWindow }[] = [
  { label: "30 days", value: "30d" },
  { label: "2026", value: "2026" },
];
const CHART_MODES: { label: string; value: ChartMode }[] = [
  { label: "Usage", value: "absolute" },
  { label: "Share", value: "share" },
];
const Route = createFileRoute("/stats")({
  validateSearch: statsSearchSchema,
  search: {
    middlewares: [stripSearchParams<StatsSearch>(DEFAULT_STATS_SEARCH)],
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statsQueryOptions);
  },
  head: () => ({
    meta: [
      { title: "Stats - tokenmaxxing.sh" },
      {
        name: "description",
        content:
          "Aggregate tokenmaxxing stats across tracked LLM agent spend, token volume, models, sources, and public leaderboard users.",
      },
      { property: "og:title", content: "tokenmaxxing.sh stats" },
      {
        property: "og:description",
        content:
          "Aggregate tracked spend, token volume, popular models, and public leaderboard stats.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: StatsPage,
});

const integerNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function StatsPage() {
  const { window } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(statsQueryOptions);
  const [chartMaxDate, setChartMaxDate] = useState(() => data.generatedAt.slice(0, 10));
  useEffect(() => {
    setChartMaxDate(localDateKey(new Date()));
  }, []);
  const selected = selectedStats(data, window, chartMaxDate);
  const cacheReadShare =
    selected.totals.totalTokens === 0
      ? 0
      : (selected.totals.cacheReadTokens / selected.totals.totalTokens) * 100;

  return (
    <>
      <header className="px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Aggregate leaderboard telemetry
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">tokenmaxxing stats</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Public totals across synced LLM agent usage. Spend is an API-equivalent estimate for
              comparison, not billing reconciliation.
            </p>
          </div>
          <Tabs
            onChange={(value) =>
              navigate({
                resetScroll: false,
                search: { window: value },
              })
            }
            options={WINDOWS}
            value={window}
          />
        </div>
      </header>

      <main className="grid grid-cols-1 gap-px border-y border-border bg-border">
        <StatsSummary
          cacheReadShare={cacheReadShare}
          label={selected.label}
          totals={selected.totals}
        />
        <TrendSection selected={selected} />
        <ModelSection selected={selected} />
        <SourceSection selected={selected} />
      </main>
    </>
  );
}

function StatsSummary({
  cacheReadShare,
  label,
  totals,
}: {
  cacheReadShare: number;
  label: string;
  totals: Totals;
}) {
  return (
    <section className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
      <StatCard label={`${label} spend`} value={formatUsd(totals.totalSpendUsd)} />
      <StatCard label={`${label} tokens`} value={formatTokens(totals.totalTokens)} />
      <StatCard label="Users" value={integerNumber.format(totals.userCount)} />
      <StatCard label="Devices" value={integerNumber.format(totals.deviceCount)} />
      <StatCard label="Input tokens" value={formatTokens(totals.inputTokens)} />
      <StatCard label="Output tokens" value={formatTokens(totals.outputTokens)} />
      <StatCard label="Cache-read share" value={`${cacheReadShare.toFixed(1)}%`} />
      <StatCard label="Usage range" value={formatRange(totals)} />
    </section>
  );
}

function TrendSection({ selected }: { selected: SelectedStats }) {
  const derived = useMemo(
    () =>
      deriveAggregateCharts(
        selected.dailyByModel,
        selected.totals.firstDate,
        selected.chartLastDate,
      ),
    [selected.chartLastDate, selected.dailyByModel, selected.totals.firstDate],
  );
  const [hoveredSpendSeries, setHoveredSpendSeries] = useState<string | null>(null);
  const [hoveredTokensSeries, setHoveredTokensSeries] = useState<string | null>(null);
  const [hoveredSessionsSeries, setHoveredSessionsSeries] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<ChartMode>("absolute");

  return (
    <>
      <section className="flex justify-end bg-background p-5 pb-0">
        <Tabs onChange={setChartMode} options={CHART_MODES} value={chartMode} />
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Daily Spend</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`Aggregate daily spend by model across ${derived.spendDays.length} days`}
              days={derived.spendDays}
              highlight={hoveredSpendSeries}
              mode={chartMode}
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
              ariaLabel={`Aggregate daily tokens by model across ${derived.tokenDays.length} days`}
              days={derived.tokenDays}
              highlight={hoveredTokensSeries}
              mode={chartMode}
              valueFormatter={formatTokens}
            />
          </div>
          <Legend entries={derived.tokenLegend} onHover={setHoveredTokensSeries} />
        </div>
      </section>

      <section className="bg-background p-5">
        <h2 className="font-medium">Daily Sessions</h2>
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <StackedBars
              ariaLabel={`Aggregate daily sessions by model across ${derived.sessionDays.length} days`}
              days={derived.sessionDays}
              highlight={hoveredSessionsSeries}
              mode={chartMode}
              valueFormatter={formatCount}
            />
          </div>
          <Legend entries={derived.sessionLegend} onHover={setHoveredSessionsSeries} />
        </div>
      </section>
    </>
  );
}

function ModelSection({ selected }: { selected: SelectedStats }) {
  return (
    <section className="grid grid-cols-1 gap-px bg-border xl:grid-cols-2">
      <RankPanel
        entries={selected.modelsByTokens}
        metric="tokens"
        title={`Popular models ${selected.label}`}
      />
      <RankPanel
        entries={selected.modelsBySpend}
        metric="spend"
        title={`Top spend models ${selected.label}`}
      />
    </section>
  );
}

function SourceSection({ selected }: { selected: SelectedStats }) {
  return (
    <section className="grid grid-cols-1 gap-px bg-border xl:grid-cols-2">
      <RankPanel entries={selected.sources} metric="tokens" title={`Sources ${selected.label}`} />
    </section>
  );
}

function RankPanel({
  entries,
  metric,
  title,
}: {
  entries: readonly RankedMetric[];
  metric: "spend" | "tokens";
  title: string;
}) {
  const total = entries.reduce(
    (sum, row) => sum + (metric === "spend" ? row.spendUsd : row.totalTokens),
    0,
  );

  return (
    <div className="bg-background p-5">
      <h2 className="font-medium">{title}</h2>
      <div className="mt-4 divide-y divide-border border-y border-border">
        {entries.slice(0, 6).map((entry, index) => {
          const value = metric === "spend" ? entry.spendUsd : entry.totalTokens;
          const percent = total === 0 ? 0 : (value / total) * 100;

          return (
            <div
              className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 py-3"
              key={entry.key}
            >
              <span className="text-sm text-muted-foreground">{index + 1}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{entry.key}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {integerNumber.format(entry.userCount)} users · {percent.toFixed(1)}% of shown
                </p>
              </div>
              <span className="text-sm font-semibold">
                {metric === "spend" ? formatUsd(value) : formatTokens(value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function selectedStats(data: Stats, window: StatsWindow, chartMaxDate: string): SelectedStats {
  if (window === "2026") {
    return {
      chartLastDate: clampChartLastDate(data.year2026.lastDate, chartMaxDate),
      dailyByModel: data.dailyByModel.filter(
        (row) => row.date >= data.year2026Since && row.date <= chartMaxDate,
      ),
      label: "2026",
      modelsBySpend: data.topModels.year2026BySpend,
      modelsByTokens: data.topModels.year2026ByTokens,
      sources: data.sources.year2026,
      totals: data.year2026,
    };
  }

  return {
    chartLastDate: clampChartLastDate(data.last30d.lastDate, chartMaxDate),
    dailyByModel: data.dailyByModel.filter(
      (row) => row.date >= data.last30dSince && row.date <= chartMaxDate,
    ),
    label: "30d",
    modelsBySpend: data.topModels.last30dBySpend,
    modelsByTokens: data.topModels.last30dByTokens,
    sources: data.sources.last30d,
    totals: data.last30d,
  };
}

function clampChartLastDate(lastDate: string | null, maxDate: string): string | null {
  if (lastDate === null) {
    return null;
  }

  return lastDate > maxDate ? maxDate : lastDate;
}

function deriveAggregateCharts(
  rows: readonly DailyModelPoint[],
  first: string | null,
  last: string | null,
) {
  const colors = seriesColors(rows);
  const spendSelection = selectModelSeries(rows, (row) => row.costUsd);
  const tokenSelection = selectModelSeries(rows, (row) => row.totalTokens);
  const sessionSelection = selectModelSeries(rows, (row) => row.rowCount);
  const spendByDate = new Map<string, number>();
  const tokenByDate = new Map<string, number>();
  const sessionByDate = new Map<string, number>();
  const spendSeriesByDate = new Map<string, Map<string, number>>();
  const tokenSeriesByDate = new Map<string, Map<string, number>>();
  const sessionSeriesByDate = new Map<string, Map<string, number>>();

  for (const row of rows) {
    spendByDate.set(row.date, (spendByDate.get(row.date) ?? 0) + row.costUsd);
    tokenByDate.set(row.date, (tokenByDate.get(row.date) ?? 0) + row.totalTokens);
    sessionByDate.set(row.date, (sessionByDate.get(row.date) ?? 0) + row.rowCount);

    const spendModel = spendSelection.label(row.key);
    const spendSeries = spendSeriesByDate.get(row.date) ?? new Map<string, number>();
    spendSeries.set(spendModel, (spendSeries.get(spendModel) ?? 0) + row.costUsd);
    spendSeriesByDate.set(row.date, spendSeries);

    const tokenModel = tokenSelection.label(row.key);
    const tokenSeries = tokenSeriesByDate.get(row.date) ?? new Map<string, number>();
    tokenSeries.set(tokenModel, (tokenSeries.get(tokenModel) ?? 0) + row.totalTokens);
    tokenSeriesByDate.set(row.date, tokenSeries);

    const sessionModel = sessionSelection.label(row.key);
    const sessionSeries = sessionSeriesByDate.get(row.date) ?? new Map<string, number>();
    sessionSeries.set(sessionModel, (sessionSeries.get(sessionModel) ?? 0) + row.rowCount);
    sessionSeriesByDate.set(row.date, sessionSeries);
  }

  const days = first === null || last === null ? [] : enumerateDays(first, last);
  const spendDays = buildStackedDays(
    days,
    spendSelection.order,
    colors,
    spendSeriesByDate,
    spendByDate,
  );
  const tokenDays = buildStackedDays(
    days,
    tokenSelection.order,
    colors,
    tokenSeriesByDate,
    tokenByDate,
  );
  const sessionDays = buildStackedDays(
    days,
    sessionSelection.order,
    colors,
    sessionSeriesByDate,
    sessionByDate,
  );

  return {
    sessionDays,
    sessionLegend: buildLegend(sessionDays, colors),
    spendDays,
    spendLegend: buildLegend(spendDays, colors),
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

  const entries = [...colors.keys()]
    .map((series) => ({
      color: colors.get(series) ?? "#9ca3af",
      percent: total > 0 ? ((valueBySeries.get(series) ?? 0) / total) * 100 : 0,
      series,
      value: valueBySeries.get(series) ?? 0,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  return entries.map(({ color, percent, series }) => ({ color, percent, series }));
}

function formatRange(totals: Totals): string {
  return totals.firstDate === null || totals.lastDate === null
    ? "No usage yet"
    : `${totals.firstDate} to ${totals.lastDate}`;
}

function formatCount(value: number): string {
  return integerNumber.format(value);
}

function localDateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

export { Route };
