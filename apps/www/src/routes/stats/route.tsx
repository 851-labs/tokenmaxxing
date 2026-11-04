import { useMemo, useState } from "react";
import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { UsageRangeId } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { AnimatedNumber, AnimatedText } from "../../components/animated-value";
import { StackedBars, type StackedBarsMode } from "../../components/charts/stacked-bars";
import { FilterBar } from "../../components/filter-bar";
import { StatCard } from "../../components/stat-card";
import { SegmentedControl, type SegmentedOption } from "../../components/ui/segmented-control";
import { cn } from "../../lib/cn";
import {
  formatDay,
  formatDayRange,
  formatInteger,
  formatPercent,
  formatTokens,
  formatUsd,
} from "../../lib/format";
import { statsQueryOptions } from "../../lib/queries";
import { optionalSearchParam, searchParam } from "../../lib/search";
import { pageHead } from "../../lib/seo";
import { DEFAULT_USAGE_RANGE, USAGE_RANGE_OPTIONS } from "../../lib/usage-ranges";
import {
  DEFAULT_STATS_METRIC,
  deriveStatsView,
  LegacyStatsWindow,
  StatsMetric,
  type SeriesSection,
  type StatsView,
} from "./-lib/stats-view";

const StatsSearchInput = Schema.Struct({
  metric: searchParam(StatsMetric, DEFAULT_STATS_METRIC),
  range: optionalSearchParam(UsageRangeId),
  /** Pre-range links (`?window=30d|ytd|2026`); `range` wins when both are set. */
  window: optionalSearchParam(LegacyStatsWindow),
});

const StatsSearch = Schema.Struct({ metric: StatsMetric, range: UsageRangeId });

type StatsSearch = typeof StatsSearch.Type;

/**
 * Every param is optional in links (the encoded side), and anything missing
 * or invalid decodes to the defaults; a legacy `window` becomes the range.
 */
const statsSearchSchema = Schema.toStandardSchemaV1(
  StatsSearchInput.pipe(
    Schema.decodeTo(
      StatsSearch,
      SchemaTransformation.transform<StatsSearch, typeof StatsSearchInput.Type>({
        decode: (input) => ({
          metric: input.metric,
          range: input.range ?? input.window ?? DEFAULT_USAGE_RANGE,
        }),
        encode: (search) => search,
      }),
    ),
  ),
);

const DEFAULT_STATS_SEARCH = {
  metric: DEFAULT_STATS_METRIC,
  range: DEFAULT_USAGE_RANGE,
} as const satisfies StatsSearch;

const METRIC_OPTIONS = [
  { label: "Tokens", value: "tokens" },
  { label: "Spend", value: "spend" },
] as const satisfies readonly SegmentedOption<StatsMetric>[];

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
        "Which AI models and coding agents are winning: token volume, API-equivalent spend and active users across every public tokenmaxxing profile.",
      path: "/stats",
      title: "Stats — tokenmaxxing.sh",
    }),
  component: StatsPage,
});

function StatsPage() {
  const { metric, range } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(statsQueryOptions);
  const view = useMemo(() => deriveStatsView(data, range, metric), [data, metric, range]);
  // Rebuilt from the validated values, so a legacy `?window=` drops out of the URL.
  const setSearch = (next: Partial<StatsSearch>) =>
    navigate({ resetScroll: false, search: { metric, range, ...next } });

  return (
    <>
      <header className="px-4 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Stats</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Every public tokenmaxxing profile, combined: which models and coding agents people
          actually use, and how much. Spend is an API-equivalent estimate for comparison, not
          billing.
        </p>
      </header>

      {/* Every section follows the filters, so the bar stays pinned for the whole page. */}
      <div className="border-b border-border">
        <FilterBar
          hideSpanWhenNarrow
          span={
            view.window === null
              ? "No usage yet"
              : formatDayRange(view.window.firstDate, view.window.lastDate)
          }
        >
          <SegmentedControl
            label="Metric"
            onChange={(value) => setSearch({ metric: value })}
            options={METRIC_OPTIONS}
            value={metric}
          />
          <SegmentedControl
            label="Time range"
            onChange={(value) => setSearch({ range: value })}
            options={USAGE_RANGE_OPTIONS}
            value={range}
          />
        </FilterBar>

        <div className="grid grid-cols-1 gap-px bg-border">
          <StatsCards metric={metric} view={view} />
          <SeriesPanel
            bucketDays={view.bucketDays}
            itemLabel="Model"
            metric={metric}
            section={view.models}
            title="Models"
          />
          <SeriesPanel
            bucketDays={view.bucketDays}
            itemLabel="Agent"
            metric={metric}
            section={view.agents}
            title="Agents"
          />
          <ActiveUsersPanel bucketDays={view.bucketDays} view={view} />
        </div>
      </div>
    </>
  );
}

function StatsCards({ metric, view }: { metric: StatsMetric; view: StatsView }) {
  const { cards } = view;
  const busiest = cards.busiestDay;

  return (
    <section className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
      <StatCard label="Spend" value={<AnimatedNumber kind="usd" value={cards.spendUsd} />} />
      <StatCard label="Tokens" value={<AnimatedNumber kind="tokens" value={cards.totalTokens} />} />
      <StatCard
        label="Active users"
        value={<AnimatedNumber kind="integer" value={cards.userCount} />}
      />
      <StatCard
        label="Spend per user"
        value={<AnimatedNumber kind="usd" value={cards.spendPerUser} />}
      />
      <StatCard
        label="Top model"
        value={<AnimatedText className="inline-block" text={cards.topModel ?? "—"} />}
      />
      <StatCard
        label="Top agent"
        value={<AnimatedText className="inline-block" text={cards.topAgent ?? "—"} />}
      />
      <StatCard
        label="Cache reads"
        detail="of all tokens"
        value={<AnimatedNumber kind="percent" value={cards.cacheReadPercent} />}
      />
      <StatCard
        detail={busiest === null ? undefined : formatDay(busiest.date)}
        label="Busiest day"
        value={
          busiest === null ? (
            "—"
          ) : (
            <AnimatedNumber kind={metric === "spend" ? "usd" : "tokens"} value={busiest.value} />
          )
        }
      />
    </section>
  );
}

/**
 * One breakdown (models or agents): its series stacked over time, then a
 * table of exactly the charted series, which doubles as the legend.
 */
function SeriesPanel({
  bucketDays,
  itemLabel,
  metric,
  section,
  title,
}: {
  bucketDays: number;
  itemLabel: string;
  metric: StatsMetric;
  section: SeriesSection;
  title: string;
}) {
  const [mode, setMode] = useState<StackedBarsMode>("absolute");
  const [highlight, setHighlight] = useState<string | null>(null);
  const per = bucketDays === 1 ? "day" : `${bucketDays} days`;
  const metricLabel = metric === "spend" ? "spend" : "tokens";

  return (
    <section className="bg-background p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        <SegmentedControl
          label={`${title} chart values`}
          onChange={setMode}
          options={CHART_MODE_OPTIONS}
          value={mode}
        />
      </div>
      <div className="mt-4">
        <StackedBars
          ariaLabel={`${title} by ${metricLabel} per ${per} across ${section.chart.days.length} bars`}
          days={section.chart.days}
          highlight={highlight}
          mode={mode}
          valueFormatter={metric === "spend" ? formatUsd : formatTokens}
        />
      </div>
      <SeriesTable
        itemLabel={itemLabel}
        metric={metric}
        onHover={setHighlight}
        rows={section.rows}
      />
    </section>
  );
}

function SeriesTable({
  itemLabel,
  metric,
  onHover,
  rows,
}: {
  itemLabel: string;
  metric: StatsMetric;
  onHover: (series: string | null) => void;
  rows: SeriesSection["rows"];
}) {
  // Number columns shrink to their content, so names keep the remaining width.
  const numeric = "w-px whitespace-nowrap px-2 py-2 text-right tabular-nums";
  const secondary = "hidden sm:table-cell";

  return (
    <table className="mt-6 w-full text-sm" onPointerLeave={() => onHover(null)}>
      <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
        <tr className="border-b border-border">
          <th className="w-px py-2 pr-2 text-left font-medium">#</th>
          <th className="px-2 py-2 text-left font-medium">{itemLabel}</th>
          <th className={cn(numeric, secondary, "font-medium")}>Users</th>
          <th className={cn(numeric, metric === "tokens" ? "" : secondary, "font-medium")}>
            Tokens
          </th>
          <th className={cn(numeric, metric === "spend" ? "" : secondary, "font-medium")}>Spend</th>
          <th className={cn(numeric, "pr-0 font-medium")}>Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            className="border-b border-border last:border-b-0 hover:bg-muted"
            key={row.key}
            onPointerEnter={() => onHover(row.key)}
          >
            <td className="py-2 pr-2 tabular-nums text-muted-foreground">{index + 1}</td>
            <td className="max-w-0 px-2 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span className="truncate">{row.label}</span>
              </span>
            </td>
            <td className={cn(numeric, secondary, "text-muted-foreground")}>
              {row.userCount === null ? "—" : formatInteger(row.userCount)}
            </td>
            <td className={cn(numeric, metric === "tokens" ? "" : secondary)}>
              {formatTokens(row.totalTokens)}
            </td>
            <td className={cn(numeric, metric === "spend" ? "" : secondary)}>
              {formatUsd(row.spendUsd)}
            </td>
            <td className={cn(numeric, "pr-0 text-muted-foreground")}>
              {formatPercent(row.percent)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActiveUsersPanel({ bucketDays, view }: { bucketDays: number; view: StatsView }) {
  const per = bucketDays === 1 ? "day" : `${bucketDays} days`;

  return (
    <section className="bg-background p-5">
      <h2 className="font-medium">Daily active users</h2>
      <div className="mt-4">
        <StackedBars
          ariaLabel={`Average daily active users per ${per} across ${view.activeUsers.length} bars`}
          days={view.activeUsers}
          totalLabel={(total) => `${formatInteger(total)} users a day`}
          valueFormatter={formatInteger}
        />
      </div>
    </section>
  );
}

export { Route };
