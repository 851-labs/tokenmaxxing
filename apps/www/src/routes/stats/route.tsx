import { useMemo, useState } from "react";
import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { StatsRankedMetric } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";

import { StackedChartPanel, type StackedBarsMode } from "../../components/charts/stacked-bars";
import { StatCard } from "../../components/stat-card";
import { SegmentedControl, type SegmentedOption } from "../../components/ui/segmented-control";
import { formatInteger, formatPercent, formatTokens, formatUsd, percentOf } from "../../lib/format";
import { statsQueryOptions } from "../../lib/queries";
import { searchParam } from "../../lib/search";
import { pageHead } from "../../lib/seo";
import {
  deriveAggregateCharts,
  formatUsageRange,
  selectStatsWindow,
  StatsTabParam,
  ytdLabel,
  type StatsTab,
  type StatsWindowView,
} from "./-lib/stats-view";

const statsSearchSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    window: searchParam(StatsTabParam, "30d"),
  }),
);

type StatsSearch = typeof statsSearchSchema.Type;

const DEFAULT_STATS_SEARCH = {
  window: "30d",
} as const satisfies StatsSearch;

const CHART_MODE_OPTIONS = [
  { label: "Usage", value: "absolute" },
  { label: "Share", value: "share" },
] as const satisfies readonly SegmentedOption<StackedBarsMode>[];

const Route = createFileRoute("/stats")({
  validateSearch: statsSearchSchema,
  search: {
    middlewares: [stripSearchParams<StatsSearch>(DEFAULT_STATS_SEARCH)],
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statsQueryOptions);
  },
  head: () =>
    pageHead({
      description:
        "Aggregate tokenmaxxing stats across tracked LLM agent spend, token volume, models, sources, and public leaderboard users.",
      path: "/stats",
      title: "Stats - tokenmaxxing.sh",
    }),
  component: StatsPage,
});

function StatsPage() {
  const { window } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(statsQueryOptions);
  const view = useMemo(() => selectStatsWindow(data, window), [data, window]);
  const windowOptions: readonly SegmentedOption<StatsTab>[] = [
    { label: "30 days", value: "30d" },
    { label: ytdLabel(data), value: "ytd" },
  ];

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
          <SegmentedControl
            label="Time window"
            onChange={(value) =>
              navigate({
                resetScroll: false,
                search: { window: value },
              })
            }
            options={windowOptions}
            value={window}
          />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-px border-y border-border bg-border">
        <StatsSummary view={view} />
        <TrendSection view={view} />
        <ModelSection view={view} />
        <SourceSection view={view} />
      </div>
    </>
  );
}

function StatsSummary({ view }: { view: StatsWindowView }) {
  const { label } = view;
  const { totals } = view.window;

  return (
    <section className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
      <StatCard label={`${label} spend`} value={formatUsd(totals.spendUsd)} />
      <StatCard label={`${label} tokens`} value={formatTokens(totals.totalTokens)} />
      <StatCard label="Users" value={formatInteger(totals.userCount)} />
      <StatCard label="Devices" value={formatInteger(totals.deviceCount)} />
      <StatCard label="Input tokens" value={formatTokens(totals.inputTokens)} />
      <StatCard label="Output tokens" value={formatTokens(totals.outputTokens)} />
      <StatCard
        label="Cache-read share"
        value={formatPercent(percentOf(totals.cacheReadTokens, totals.totalTokens))}
      />
      <StatCard label="Usage range" value={formatUsageRange(view.chartRange)} />
    </section>
  );
}

function TrendSection({ view }: { view: StatsWindowView }) {
  const charts = useMemo(() => deriveAggregateCharts(view), [view]);
  const [chartMode, setChartMode] = useState<StackedBarsMode>("absolute");
  const dayCount = charts.spend.days.length;

  return (
    <>
      <section className="flex justify-end bg-background p-5 pb-0">
        <SegmentedControl
          label="Chart values"
          onChange={setChartMode}
          options={CHART_MODE_OPTIONS}
          value={chartMode}
        />
      </section>

      <StackedChartPanel
        ariaLabel={`Aggregate daily spend by model across ${dayCount} days`}
        days={charts.spend.days}
        legend={charts.spend.legend}
        mode={chartMode}
        title="Daily Spend"
        valueFormatter={formatUsd}
      />
      <StackedChartPanel
        ariaLabel={`Aggregate daily tokens by model across ${dayCount} days`}
        days={charts.tokens.days}
        legend={charts.tokens.legend}
        mode={chartMode}
        title="Daily Tokens"
        valueFormatter={formatTokens}
      />
      <StackedChartPanel
        ariaLabel={`Aggregate daily sessions by model across ${dayCount} days`}
        days={charts.sessions.days}
        legend={charts.sessions.legend}
        mode={chartMode}
        title="Daily Sessions"
        valueFormatter={formatInteger}
      />
    </>
  );
}

function ModelSection({ view }: { view: StatsWindowView }) {
  return (
    <section className="grid grid-cols-1 gap-px bg-border xl:grid-cols-2">
      <RankPanel
        entries={view.window.modelsByTokens}
        metric="tokens"
        title={`Popular models ${view.label}`}
      />
      <RankPanel
        entries={view.window.modelsBySpend}
        metric="spend"
        title={`Top spend models ${view.label}`}
      />
    </section>
  );
}

function SourceSection({ view }: { view: StatsWindowView }) {
  return (
    <section className="grid grid-cols-1 gap-px bg-border">
      <RankPanel entries={view.window.sources} metric="tokens" title={`Sources ${view.label}`} />
    </section>
  );
}

function RankPanel({
  entries,
  metric,
  title,
}: {
  entries: readonly StatsRankedMetric[];
  metric: "spend" | "tokens";
  title: string;
}) {
  const valueOf = (entry: StatsRankedMetric) =>
    metric === "spend" ? entry.spendUsd : entry.totalTokens;
  const total = entries.reduce((sum, entry) => sum + valueOf(entry), 0);

  return (
    <div className="bg-background p-5">
      <h2 className="font-medium">{title}</h2>
      <div className="mt-4 divide-y divide-border border-y border-border">
        {entries.slice(0, 6).map((entry, index) => {
          const value = valueOf(entry);

          return (
            <div
              className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 py-3"
              key={entry.key}
            >
              <span className="text-sm text-muted-foreground">{index + 1}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{entry.key}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatInteger(entry.userCount)} users · {formatPercent(percentOf(value, total))}{" "}
                  of shown
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

export { Route };
