import { useMemo, useState } from "react";
import { CaretDown, LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { USAGE_SOURCES, UsageSource } from "@tokenmaxxing/api-contract";
import type { ProfileResponse, UsageRangeId } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";

import { AnimatedNumber, AnimatedText } from "../../components/animated-value";
import { Heatmap } from "../../components/charts/heatmap";
import { MonthBars } from "../../components/charts/month-bars";
import { StackedChartPanel } from "../../components/charts/stacked-bars";
import { WeekdayBars } from "../../components/charts/weekday-bars";
import { StatCard } from "../../components/stat-card";
import { Avatar } from "../../components/ui/avatar";
import { Button, buttonClassName } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Code } from "../../components/ui/code";
import { FilterBar } from "../../components/filter-bar";
import { Menu } from "../../components/ui/menu";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { agentLabel } from "../../lib/agents";
import { isNotFoundApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatDayRange, formatInteger, formatTokens, formatUsd } from "../../lib/format";
import { breadcrumbSchema, profilePageSchema } from "../../lib/jsonld";
import { LOGIN_REDIRECT_HEADERS } from "../../lib/login-redirect";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  profileOgDescription,
  profileOgImageUrl,
  profileOgTitle,
  profileUrl,
} from "../../lib/og";
import {
  deriveProfileCharts,
  deriveProfileTrendCharts,
  deriveWindowStats,
  type DailyRange,
  type DailyRow,
} from "./-lib/profile-charts";
import { profileDailyQueryOptions, profileQueryOptions, queryKeys } from "../../lib/queries";
import { optionalSearchParam } from "../../lib/search";
import { pageHead } from "../../lib/seo";
import { DEFAULT_USAGE_RANGE, USAGE_RANGE_OPTIONS, usageRangeWindow } from "../../lib/usage-ranges";

type ProfileStats = (typeof ProfileResponse.Type)["stats"];

/** The agent a profile's daily charts are scoped to; missing means all agents. */
const profileSearchSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    source: optionalSearchParam(UsageSource),
  }),
);

type ProfileSearch = typeof profileSearchSchema.Type;

const DEFAULT_PROFILE_SEARCH = {
  source: undefined,
} as const satisfies ProfileSearch;

const ALL_AGENT_SOURCE = "all";
type ProfileSourceFilter = UsageSource | typeof ALL_AGENT_SOURCE;

interface AgentFilterOption {
  label: string;
  value: ProfileSourceFilter;
}

const Route = createFileRoute("/$user")({
  validateSearch: profileSearchSchema,
  search: {
    middlewares: [stripSearchParams<ProfileSearch>(DEFAULT_PROFILE_SEARCH)],
  },
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => loadProfile(context.queryClient, params.user, deps.source),
  head: ({ loaderData }) => {
    if (loaderData === undefined) {
      return {};
    }

    const profile = loaderData.profile;
    const image = profileOgImageUrl(profile);
    const url = profileUrl(profile);

    return {
      ...pageHead({
        description: profileOgDescription(profile),
        meta: [
          { content: image, property: "og:image" },
          { content: String(OG_IMAGE_WIDTH), property: "og:image:width" },
          { content: String(OG_IMAGE_HEIGHT), property: "og:image:height" },
          { content: "summary_large_image", name: "twitter:card" },
          { content: image, name: "twitter:image" },
        ],
        path: `/${encodeURIComponent(profile.user.login)}`,
        title: profileOgTitle(profile),
        type: "profile",
      }),
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

/**
 * Loads the profile summary and its daily rows in parallel, letting both
 * settle before answering: a daily read still pending when the summary 404s
 * would be dehydrated to the client and reject there, uncaught. Only the
 * (small) summary rides in loader data, for head tags and the favicon; the
 * daily rows reach the client once, via the dehydrated query cache.
 */
async function loadProfile(queryClient: QueryClient, login: string, source?: UsageSource) {
  const [profile, daily] = await Promise.allSettled([
    queryClient.ensureQueryData(profileQueryOptions(login)),
    queryClient.ensureQueryData(profileDailyQueryOptions(login, source)),
  ]);
  if (profile.status === "rejected") {
    // The daily read fails alongside it and nothing on the error page reads it.
    queryClient.removeQueries({ exact: true, queryKey: queryKeys.profileDaily(login, source) });
    if (isNotFoundApiError(profile.reason)) {
      throw notFound();
    }

    throw profile.reason;
  }
  if (daily.status === "rejected") {
    throw daily.reason;
  }

  // Lookups are case-insensitive and resolve old logins (renamed users);
  // every profile keeps one canonical URL.
  const canonicalLogin = profile.value.user.login;
  if (canonicalLogin !== login) {
    throw redirect({
      headers: LOGIN_REDIRECT_HEADERS,
      params: { user: canonicalLogin },
      // Keep the agent filter across the redirect.
      search: source === undefined ? {} : { source },
      statusCode: 301,
      to: "/$user",
    });
  }

  return { profile: profile.value };
}

/**
 * The agent choices for the dashboard: all agents plus every agent with usage
 * in the charts' range. An agent whose only usage is older than that range
 * would open an empty dashboard, so it is not offered.
 */
function agentFilterOptions(sources: readonly string[]): readonly AgentFilterOption[] {
  const known = sources.filter((candidate): candidate is UsageSource =>
    (USAGE_SOURCES as readonly string[]).includes(candidate),
  );

  return [
    { label: "All agents", value: ALL_AGENT_SOURCE },
    ...known.map((agent) => ({ label: agentLabel(agent), value: agent })),
  ];
}

function ProfilePage() {
  const { user } = Route.useParams();
  const { source } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: profile } = useSuspenseQuery(profileQueryOptions(user));
  const { data: daily } = useSuspenseQuery(profileDailyQueryOptions(user, source));
  const owner = profile.user;
  // `sources` is missing only from a daily response cached before the API sent it.
  const agentOptions = agentFilterOptions(daily.sources ?? profile.stats.sources);
  const activeSource = source === undefined ? ALL_AGENT_SOURCE : source;

  const selectAgent = (value: ProfileSourceFilter) =>
    navigate({
      params: { user: owner.login },
      search: { source: value === ALL_AGENT_SOURCE ? undefined : value },
    });

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
          {source === undefined ? (
            <Card className="p-6 text-sm text-muted-foreground">
              No usage yet — run <Code>tokenmaxxing sync</Code> to fill this page.
            </Card>
          ) : (
            // The filter bar lives in the dashboard, which has nothing to show
            // here, so the way back to all agents is offered inline.
            <Card className="flex flex-wrap items-center justify-between gap-3 p-6 text-sm text-muted-foreground">
              <span>No {agentLabel(source)} usage on this profile.</span>
              <Button
                onClick={() => void selectAgent(ALL_AGENT_SOURCE)}
                size="sm"
                variant="outline"
              >
                Show all agents
              </Button>
            </Card>
          )}
        </div>
      ) : (
        <ProfileDashboard
          agentFilter={
            agentOptions.length > 1
              ? { onChange: selectAgent, options: agentOptions, value: activeSource }
              : undefined
          }
          range={daily.range}
          rows={daily.days}
          stats={profile.stats}
        />
      )}
    </>
  );
}

interface AgentFilter {
  onChange: (value: ProfileSourceFilter) => void;
  options: readonly AgentFilterOption[];
  value: ProfileSourceFilter;
}

/**
 * The agent the dashboard is scoped to, as a dropdown: a profile can have a
 * dozen agents, which is too many for an inline segmented control.
 */
function AgentFilterMenu({ onChange, options, value }: AgentFilter) {
  const selected = options.find((option) => option.value === value);

  return (
    <Menu>
      <Menu.Trigger
        aria-label={`Agent: ${selected?.label ?? "All agents"}`}
        // As tall as the segmented control beside it in the filter bar.
        className={cn(buttonClassName({ size: "xs", variant: "outline" }), "h-[30px]")}
      >
        {selected?.label ?? "All agents"}
        <CaretDown aria-hidden className="size-3.5 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Content className="max-h-(--available-height) overflow-y-auto">
        <Menu.RadioGroup
          onValueChange={(next) => onChange(next as ProfileSourceFilter)}
          value={value}
        >
          {options.map((option) => (
            <Menu.RadioItem key={option.value} value={option.value}>
              {option.label}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu>
  );
}

function ProfileShareButton({ url }: { url: string }) {
  const { copiedKey, copy } = useCopyToClipboard();
  const copied = copiedKey !== null;

  return (
    <Button
      aria-label={copied ? "Profile link copied" : "Share profile"}
      className="shrink-0"
      onClick={() => void copy(url, "profile")}
      size="sm"
      variant="outline"
    >
      <LinkSimple className="size-4" />
      {copied ? "Copied" : "Share"}
    </Button>
  );
}

function ProfileDashboard({
  agentFilter,
  range,
  rows,
  stats,
}: {
  agentFilter: AgentFilter | undefined;
  range: DailyRange;
  rows: readonly DailyRow[];
  stats: ProfileStats;
}) {
  const charts = useMemo(() => deriveProfileCharts(rows, range), [range, rows]);
  const [timeframe, setTimeframe] = useState<UsageRangeId>(DEFAULT_USAGE_RANGE);

  return (
    <>
      {/* The filter bar's sticky scope: it stays pinned only while the
          sections it filters are on screen, then scrolls away with them. */}
      <div className="border-b border-border">
        <ProfileFilterBar
          agentFilter={agentFilter}
          onTimeframeChange={setTimeframe}
          range={range}
          timeframe={timeframe}
        />
        <div className="grid grid-cols-1 gap-px bg-border">
          <ProfileStatCards range={range} rows={rows} stats={stats} timeframe={timeframe} />
          <ProfileTrends range={range} rows={rows} timeframe={timeframe} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-px border-b border-border bg-border">
        <section className="bg-background p-5">
          <h2 className="font-medium">Activity Heatmap</h2>
          <div className="mt-4">
            <Heatmap
              byDate={charts.spendByDate}
              first={charts.heatmap.first}
              focus={charts.heatmap.focus}
              last={charts.heatmap.last}
              segmentsByDate={charts.segmentsByDate}
            />
          </div>
        </section>

        <section className="bg-background p-5">
          <h2 className="font-medium">Most Active Time</h2>
          <div className="mt-4">
            <WeekdayBars spend={charts.spendByWeekday} />
          </div>
        </section>

        <section className="bg-background p-5">
          <h2 className="font-medium">Monthly Spend</h2>
          <div className="mt-4">
            <MonthBars
              ariaLabel={`Monthly spend by model across ${charts.monthlySpend.length} months`}
              months={charts.monthlySpend}
              valueFormatter={formatUsd}
            />
          </div>
        </section>
        <section className="bg-background p-5">
          <h2 className="font-medium">Monthly Tokens</h2>
          <div className="mt-4">
            <MonthBars
              ariaLabel={`Monthly tokens by model across ${charts.monthlyTokens.length} months`}
              months={charts.monthlyTokens}
              valueFormatter={formatTokens}
            />
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * Two rows of stats: the first follows the time range; the second is lifetime
 * (streaks, sessions, and the 30-day leaderboard rank), which per-day rows
 * can't scope to a range.
 */
function ProfileStatCards({
  range,
  rows,
  stats,
  timeframe,
}: {
  range: DailyRange;
  rows: readonly DailyRow[];
  stats: ProfileStats;
  timeframe: UsageRangeId;
}) {
  const windowStats = useMemo(
    () => deriveWindowStats(rows, usageRangeWindow(range, timeframe)),
    [range, rows, timeframe],
  );

  return (
    <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
      <StatCard label="Spend" value={<AnimatedNumber kind="usd" value={windowStats.spendUsd} />} />
      <StatCard
        label="Tokens"
        value={<AnimatedNumber kind="tokens" value={windowStats.totalTokens} />}
      />
      <StatCard
        label="Top spend model"
        value={<AnimatedText className="inline-block" text={windowStats.topModel ?? "—"} />}
      />
      <StatCard
        label="Active days"
        value={<AnimatedNumber kind="integer" value={windowStats.activeDays} />}
      />
      <StatCard label="Current streak" value={formatInteger(stats.currentStreakDays)} />
      <StatCard label="Longest streak" value={formatInteger(stats.longestStreakDays)} />
      <StatCard label="Sessions" value={formatInteger(stats.sessionCount)} />
      <StatCard
        label="Rank · 30d"
        value={stats.leaderboardRank === null ? "—" : `#${formatInteger(stats.leaderboardRank)}`}
      />
    </div>
  );
}

/**
 * The dashboard's filters: the agent (every per-day figure and chart below)
 * and the time range (the stat cards and trend charts).
 */
function ProfileFilterBar({
  agentFilter,
  onTimeframeChange,
  range,
  timeframe,
}: {
  agentFilter: AgentFilter | undefined;
  onTimeframeChange: (timeframe: UsageRangeId) => void;
  range: DailyRange;
  timeframe: UsageRangeId;
}) {
  const window = usageRangeWindow(range, timeframe);

  return (
    <FilterBar
      hideSpanWhenNarrow={agentFilter !== undefined}
      span={formatDayRange(window.firstDate, window.lastDate)}
    >
      {agentFilter === undefined ? null : <AgentFilterMenu {...agentFilter} />}
      <SegmentedControl
        label="Time range"
        onChange={onTimeframeChange}
        options={USAGE_RANGE_OPTIONS}
        value={timeframe}
      />
    </FilterBar>
  );
}

/** Spend and token stacks over a chosen timeframe, bucketed to a readable bar count. */
function ProfileTrends({
  range,
  rows,
  timeframe,
}: {
  range: DailyRange;
  rows: readonly DailyRow[];
  timeframe: UsageRangeId;
}) {
  const trends = useMemo(
    () => deriveProfileTrendCharts(rows, range, timeframe),
    [range, rows, timeframe],
  );
  const barCount = trends.spend.days.length;
  const per = trends.bucketDays === 1 ? "day" : `${trends.bucketDays} days`;

  return (
    <>
      <StackedChartPanel
        ariaLabel={`Spend by model per ${per} across ${barCount} bars`}
        days={trends.spend.days}
        legend={trends.spend.legend}
        title="Spend"
        valueFormatter={formatUsd}
      />
      <StackedChartPanel
        ariaLabel={`Tokens by model per ${per} across ${barCount} bars`}
        days={trends.tokens.days}
        legend={trends.tokens.legend}
        title="Tokens"
        valueFormatter={formatTokens}
      />
    </>
  );
}

export { loadProfile, Route };
