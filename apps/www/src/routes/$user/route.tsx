import { useMemo } from "react";
import { CaretDown, LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { UsageRangeId, UsageSource } from "@tokenmaxxing/api-contract";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";
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
  agentsBySpend,
  deriveProfileCharts,
  deriveProfileTrendCharts,
  deriveWindowStats,
  rowsForAgent,
  type DailyRange,
  type DailyRow,
} from "./-lib/profile-charts";
import { profileDailyQueryOptions, profileQueryOptions, queryKeys } from "../../lib/queries";
import { optionalSearchParam, searchParam } from "../../lib/search";
import { pageHead } from "../../lib/seo";
import { DEFAULT_USAGE_RANGE, USAGE_RANGE_OPTIONS, usageRangeWindow } from "../../lib/usage-ranges";

type ProfileStats = (typeof ProfileResponse.Type)["stats"];

/**
 * The dashboard's filters: the agent it is scoped to (missing means all
 * agents) and the time range of the stat cards and trend charts. They live in
 * the URL so a view can be linked, but the loader does not depend on them: the
 * daily rows carry every agent and the whole range and are filtered in the
 * browser, so changing a filter never refetches.
 */
const profileSearchSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    agent: optionalSearchParam(UsageSource),
    range: searchParam(UsageRangeId, DEFAULT_USAGE_RANGE),
  }),
);

type ProfileSearch = typeof profileSearchSchema.Type;

const DEFAULT_PROFILE_SEARCH = {
  agent: undefined,
  range: DEFAULT_USAGE_RANGE,
} as const satisfies ProfileSearch;

const ALL_AGENTS = "all";
type AgentFilterValue = UsageSource | typeof ALL_AGENTS;

const Route = createFileRoute("/$user")({
  validateSearch: profileSearchSchema,
  search: {
    middlewares: [stripSearchParams<ProfileSearch>(DEFAULT_PROFILE_SEARCH)],
  },
  // The search rides along only for the canonical-login redirect; it is not
  // a loader dependency.
  loader: ({ context, location, params }) =>
    loadProfile(context.queryClient, params.user, location.search),
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
async function loadProfile(
  queryClient: QueryClient,
  login: string,
  search: Partial<ProfileSearch> = {},
) {
  const [profile, daily] = await Promise.allSettled([
    queryClient.ensureQueryData(profileQueryOptions(login)),
    queryClient.ensureQueryData(profileDailyQueryOptions(login)),
  ]);
  if (profile.status === "rejected") {
    // The daily read fails alongside it and nothing on the error page reads it.
    queryClient.removeQueries({ exact: true, queryKey: queryKeys.profileDaily(login) });
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
      // Keep the filters across the redirect.
      search,
      statusCode: 301,
      to: "/$user",
    });
  }

  return { profile: profile.value };
}

function ProfilePage() {
  const { user } = Route.useParams();
  const { agent, range: timeframe } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: profile } = useSuspenseQuery(profileQueryOptions(user));
  const { data: daily } = useSuspenseQuery(profileDailyQueryOptions(user));
  const owner = profile.user;
  // Only agents the filter can select: a stored tag outside the current list
  // (older ingests accepted any) still counts toward "All agents".
  const agents = useMemo(
    () => agentsBySpend(daily.days).filter(Schema.is(UsageSource)),
    [daily.days],
  );
  const rows = useMemo(() => rowsForAgent(daily.days, agent), [agent, daily.days]);
  // A filter, not a page: no history entry, and the reader stays where they
  // scrolled to.
  const setSearch = (next: Partial<ProfileSearch>) =>
    void navigate({
      replace: true,
      resetScroll: false,
      search: { agent, range: timeframe, ...next },
    });

  return (
    <>
      <header className="flex items-center justify-between gap-4 px-4 py-8">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar alt={`${owner.login} avatar`} priority size={56} src={owner.avatarUrl} />
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{owner.login}</h1>
        </div>
        {/* Shares the view on screen: active filters ride along. */}
        <ProfileShareButton url={sharedProfileUrl(profileUrl(profile), agent, timeframe)} />
      </header>

      {daily.days.length === 0 ? (
        <div className="px-4">
          <Card className="p-6 text-sm text-muted-foreground">
            No usage yet — run <Code>tokenmaxxing sync</Code> to fill this page.
          </Card>
        </div>
      ) : (
        // An agent with no rows in range (an old link) still gets the
        // dashboard, empty: the filter bar is the way back.
        <ProfileDashboard
          agent={agent}
          agents={agents}
          onAgentChange={(next) => setSearch({ agent: next })}
          onTimeframeChange={(next) => setSearch({ range: next })}
          range={daily.range}
          rows={rows}
          stats={profile.stats}
          timeframe={timeframe}
        />
      )}
    </>
  );
}

/** The profile URL with the filters that differ from the defaults. */
function sharedProfileUrl(url: string, agent: UsageSource | undefined, range: UsageRangeId) {
  const query = new URLSearchParams();
  if (agent !== undefined) {
    query.set("agent", agent);
  }
  if (range !== DEFAULT_USAGE_RANGE) {
    query.set("range", range);
  }

  return query.size === 0 ? url : `${url}?${query.toString()}`;
}

/**
 * The agent the dashboard is scoped to, as a dropdown: a profile can have a
 * dozen agents, which is too many for an inline segmented control. Only
 * agents with usage in the charts' range are offered; one selected anyway (an
 * old link) is listed so the control shows it and can leave it.
 */
function AgentFilterMenu({
  agent,
  agents,
  onChange,
}: {
  agent: UsageSource | undefined;
  agents: readonly UsageSource[];
  onChange: (agent: UsageSource | undefined) => void;
}) {
  const offered = agent === undefined || agents.includes(agent) ? agents : [...agents, agent];
  const label = agent === undefined ? "All agents" : agentLabel(agent);

  return (
    <Menu>
      <Menu.Trigger
        aria-label={`Agent: ${label}`}
        // As tall as the segmented control beside it in the filter bar.
        className={cn(buttonClassName({ size: "xs", variant: "outline" }), "h-[30px]")}
      >
        {label}
        <CaretDown aria-hidden className="size-3.5 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Content className="max-h-(--available-height) overflow-y-auto">
        <Menu.RadioGroup
          onValueChange={(next: AgentFilterValue) =>
            onChange(next === ALL_AGENTS ? undefined : next)
          }
          value={agent ?? ALL_AGENTS}
        >
          <Menu.RadioItem value={ALL_AGENTS}>All agents</Menu.RadioItem>
          {offered.map((option) => (
            <Menu.RadioItem key={option} value={option}>
              {agentLabel(option)}
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
  agent,
  agents,
  onAgentChange,
  onTimeframeChange,
  range,
  rows,
  stats,
  timeframe,
}: {
  agent: UsageSource | undefined;
  agents: readonly UsageSource[];
  onAgentChange: (agent: UsageSource | undefined) => void;
  onTimeframeChange: (timeframe: UsageRangeId) => void;
  range: DailyRange;
  rows: readonly DailyRow[];
  stats: ProfileStats;
  timeframe: UsageRangeId;
}) {
  const charts = useMemo(() => deriveProfileCharts(rows, range), [range, rows]);
  // These sections follow the agent filter but sit below the filter bar's
  // sticky scope, so each heading names the agent once the bar scrolls away.
  const scope =
    agent === undefined ? null : (
      <span className="font-normal text-muted-foreground"> · {agentLabel(agent)}</span>
    );

  return (
    <>
      {/* The filter bar's sticky scope: it stays pinned only while the
          sections its time range filters are on screen, then scrolls away
          with them. The agent filter also reaches the sections below, whose
          headings name the agent. */}
      <div className="border-b border-border">
        <ProfileFilterBar
          agent={agent}
          agents={agents}
          onAgentChange={onAgentChange}
          onTimeframeChange={onTimeframeChange}
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
          <h2 className="font-medium">
            Activity Heatmap
            {scope}
          </h2>
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
          <h2 className="font-medium">
            Most Active Time
            {scope}
          </h2>
          <div className="mt-4">
            <WeekdayBars spend={charts.spendByWeekday} />
          </div>
        </section>

        <section className="bg-background p-5">
          <h2 className="font-medium">
            Monthly Spend
            {scope}
          </h2>
          <div className="mt-4">
            <MonthBars
              ariaLabel={`Monthly spend by model across ${charts.monthlySpend.length} months`}
              months={charts.monthlySpend}
              valueFormatter={formatUsd}
            />
          </div>
        </section>
        <section className="bg-background p-5">
          <h2 className="font-medium">
            Monthly Tokens
            {scope}
          </h2>
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
 * Two rows of stats: the first follows the time range and the agent filter;
 * the second is lifetime and whole-profile (streaks, sessions, and the 30-day
 * leaderboard rank), which per-day rows can't scope.
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
        value={
          <AnimatedText className="line-clamp-1 break-all" text={windowStats.topModel ?? "—"} />
        }
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
  agent,
  agents,
  onAgentChange,
  onTimeframeChange,
  range,
  timeframe,
}: {
  agent: UsageSource | undefined;
  agents: readonly UsageSource[];
  onAgentChange: (agent: UsageSource | undefined) => void;
  onTimeframeChange: (timeframe: UsageRangeId) => void;
  range: DailyRange;
  timeframe: UsageRangeId;
}) {
  const window = usageRangeWindow(range, timeframe);
  // One agent leaves nothing to choose, unless a link selected another one.
  const showAgentFilter = agents.length > 1 || agent !== undefined;

  return (
    <FilterBar
      hideSpanWhenNarrow={showAgentFilter}
      span={formatDayRange(window.firstDate, window.lastDate)}
    >
      {showAgentFilter ? (
        <AgentFilterMenu agent={agent} agents={agents} onChange={onAgentChange} />
      ) : null}
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
