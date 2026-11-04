import { useMemo, useState } from "react";
import { LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import type { ProfileResponse, UsageRangeId } from "@tokenmaxxing/api-contract";

import { AnimatedNumber, AnimatedText } from "../../components/animated-value";
import { Heatmap } from "../../components/charts/heatmap";
import { MonthBars } from "../../components/charts/month-bars";
import { StackedChartPanel } from "../../components/charts/stacked-bars";
import { WeekdayBars } from "../../components/charts/weekday-bars";
import { StatCard } from "../../components/stat-card";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Code } from "../../components/ui/code";
import { FilterBar } from "../../components/filter-bar";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { isNotFoundApiError } from "../../lib/api";
import { formatDayRange, formatInteger, formatTokens, formatUsd } from "../../lib/format";
import { breadcrumbSchema, profilePageSchema } from "../../lib/jsonld";
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
import { pageHead } from "../../lib/seo";
import { DEFAULT_USAGE_RANGE, USAGE_RANGE_OPTIONS, usageRangeWindow } from "../../lib/usage-ranges";

type ProfileStats = (typeof ProfileResponse.Type)["stats"];

const Route = createFileRoute("/$user")({
  loader: ({ context, params }) => loadProfile(context.queryClient, params.user),
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
async function loadProfile(queryClient: QueryClient, login: string) {
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

  // Lookups are case-insensitive; every profile keeps one canonical URL.
  const canonicalLogin = profile.value.user.login;
  if (canonicalLogin !== login) {
    throw redirect({ params: { user: canonicalLogin }, statusCode: 301, to: "/$user" });
  }

  return { profile: profile.value };
}

function ProfilePage() {
  const { user } = Route.useParams();
  const { data: profile } = useSuspenseQuery(profileQueryOptions(user));
  const { data: daily } = useSuspenseQuery(profileDailyQueryOptions(user));
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
        <ProfileDashboard range={daily.range} rows={daily.days} stats={profile.stats} />
      )}
    </>
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
  range,
  rows,
  stats,
}: {
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
        <ProfileFilterBar onTimeframeChange={setTimeframe} range={range} timeframe={timeframe} />
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

/** The dashboard's time range, over the stat cards and trend charts it filters. */
function ProfileFilterBar({
  onTimeframeChange,
  range,
  timeframe,
}: {
  onTimeframeChange: (timeframe: UsageRangeId) => void;
  range: DailyRange;
  timeframe: UsageRangeId;
}) {
  const window = usageRangeWindow(range, timeframe);

  return (
    <FilterBar span={formatDayRange(window.firstDate, window.lastDate)}>
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
