import { useMemo } from "react";
import { LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { USAGE_SOURCES, UsageSource } from "@tokenmaxxing/api-contract";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";

import { Heatmap } from "../../components/charts/heatmap";
import { MonthBars } from "../../components/charts/month-bars";
import { StackedChartPanel } from "../../components/charts/stacked-bars";
import { WeekdayBars } from "../../components/charts/weekday-bars";
import { StatCard } from "../../components/stat-card";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Code } from "../../components/ui/code";
import { SegmentedControl, type SegmentedOption } from "../../components/ui/segmented-control";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { isNotFoundApiError } from "../../lib/api";
import { agentLabel } from "../../lib/agents";
import { formatInteger, formatTokens, formatUsd } from "../../lib/format";
import { breadcrumbSchema, profilePageSchema } from "../../lib/jsonld";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  profileOgDescription,
  profileOgImageUrl,
  profileOgTitle,
  profileUrl,
} from "../../lib/og";
import { profileDailyQueryOptions, profileQueryOptions, queryKeys } from "../../lib/queries";
import { optionalSearchParam } from "../../lib/search";
import { pageHead } from "../../lib/seo";
import { deriveProfileCharts, type DailyRange, type DailyRow } from "./-lib/profile-charts";

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

  // Lookups are case-insensitive; every profile keeps one canonical URL.
  const canonicalLogin = profile.value.user.login;
  if (canonicalLogin !== login) {
    throw redirect({ params: { user: canonicalLogin }, statusCode: 301, to: "/$user" });
  }

  return { profile: profile.value };
}

/**
 * The agent segments for the daily charts: all agents plus every agent the
 * profile has synced a day for. An active selection is kept even when the
 * profile's agent list no longer contains it, so a stale filter stays visible
 * and dismissable.
 */
function agentFilterOptions(
  source: UsageSource | undefined,
  sources: readonly string[],
): readonly SegmentedOption<ProfileSourceFilter>[] {
  const known = sources.filter((candidate): candidate is UsageSource =>
    (USAGE_SOURCES as readonly string[]).includes(candidate),
  );
  const options: SegmentedOption<ProfileSourceFilter>[] = [
    { label: "All agents", value: ALL_AGENT_SOURCE },
    ...known.map((agent) => ({ label: agentLabel(agent), value: agent })),
  ];
  if (source !== undefined && !known.includes(source)) {
    options.unshift({ label: agentLabel(source), value: source });
  }

  return options;
}

function ProfilePage() {
  const { user } = Route.useParams();
  const { source } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: profile } = useSuspenseQuery(profileQueryOptions(user));
  const { data: daily } = useSuspenseQuery(profileDailyQueryOptions(user, source));
  const owner = profile.user;
  const agentOptions = agentFilterOptions(source, profile.stats.sources);
  const activeSource = source === undefined ? ALL_AGENT_SOURCE : source;

  const selectAgent = (value: ProfileSourceFilter) =>
    navigate({
      params: { user: owner.login },
      search: { source: value === ALL_AGENT_SOURCE ? undefined : value },
    });

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 px-4 py-8">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar alt={`${owner.login} avatar`} priority size={56} src={owner.avatarUrl} />
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{owner.login}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {agentOptions.length > 1 && (
            <SegmentedControl
              label="Agent"
              onChange={selectAgent}
              options={agentOptions}
              value={activeSource}
            />
          )}
          <ProfileShareButton url={profileUrl(profile)} />
        </div>
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
  const dayCount = charts.spend.days.length;

  return (
    <div className="grid grid-cols-1 gap-px border-y border-border bg-border">
      <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
        <StatCard label="Total spend" value={formatUsd(stats.spendUsd)} />
        <StatCard label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <StatCard label="Sessions" value={formatInteger(stats.sessionCount)} />
        <StatCard
          label="Top spend model"
          value={stats.topModel === null ? "—" : stats.topModel.model}
        />
        <StatCard label="Current streak" value={formatInteger(stats.currentStreakDays)} />
        <StatCard label="Longest streak" value={formatInteger(stats.longestStreakDays)} />
        <StatCard label="Active days" value={formatInteger(stats.activeDays)} />
        <StatCard
          label="Leaderboard rank"
          value={stats.leaderboardRank === null ? "—" : `#${formatInteger(stats.leaderboardRank)}`}
        />
      </div>

      <StackedChartPanel
        ariaLabel={`Daily spend by model across ${dayCount} days`}
        days={charts.spend.days}
        legend={charts.spend.legend}
        title="Daily Spend"
        valueFormatter={formatUsd}
      />
      <StackedChartPanel
        ariaLabel={`Daily tokens by model across ${dayCount} days`}
        days={charts.tokens.days}
        legend={charts.tokens.legend}
        title="Daily Tokens"
        valueFormatter={formatTokens}
      />

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
          <MonthBars months={charts.months} />
        </div>
      </section>
    </div>
  );
}

export { loadProfile, Route };
