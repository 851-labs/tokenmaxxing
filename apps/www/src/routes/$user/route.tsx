import { useMemo } from "react";
import { LinkSimple } from "@phosphor-icons/react/ssr";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import { Heatmap } from "../../components/charts/heatmap";
import { MonthBars } from "../../components/charts/month-bars";
import { StackedChartPanel } from "../../components/charts/stacked-bars";
import { WeekdayBars } from "../../components/charts/weekday-bars";
import { StatCard } from "../../components/stat-card";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Code } from "../../components/ui/code";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { isApiError } from "../../lib/api";
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
import { deriveProfileCharts, type DailyRange, type DailyRow } from "./-lib/profile-charts";
import { profileDailyQueryOptions, profileQueryOptions } from "../../lib/queries";
import { pageHead } from "../../lib/seo";

type ProfileStats = (typeof ProfileResponse.Type)["stats"];

const Route = createFileRoute("/$user")({
  loader: async ({ context, params }) => {
    try {
      const [profile] = await Promise.all([
        context.queryClient.ensureQueryData(profileQueryOptions(params.user)),
        context.queryClient.ensureQueryData(profileDailyQueryOptions(params.user)),
      ]);

      // Only the (small) profile summary rides in loader data, for head tags
      // and the favicon. The daily rows reach the client once, via the
      // dehydrated query cache.
      return { profile };
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

export { Route };
