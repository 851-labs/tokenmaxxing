import { Collapsible } from "@base-ui/react/collapsible";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import {
  DEFAULT_LEADERBOARD_METRIC,
  DEFAULT_LEADERBOARD_WINDOW,
  LeaderboardMetric,
  LeaderboardWindow,
  type LeaderboardResponse,
} from "@tokenmaxxing/api-contract";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { AGENT_ICONS } from "./-components/agent-icons";
import { BootstrapCommand } from "./-components/bootstrap-command";
import { FAQ_ITEMS } from "./-components/faq-items";
import { Avatar } from "../../components/ui/avatar";
import { SegmentedControl, type SegmentedOption } from "../../components/ui/segmented-control";
import { SUPPORTED_AGENTS } from "../../lib/agents";
import { cn } from "../../lib/cn";
import { formatTokens, formatUsd } from "../../lib/format";
import { faqPageSchema, softwareApplicationSchema } from "../../lib/jsonld";
import { leaderboardQueryOptions } from "../../lib/queries";
import { searchParam } from "../../lib/search";
import { pageHead } from "../../lib/seo";

const leaderboardSearchSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    metric: searchParam(LeaderboardMetric, DEFAULT_LEADERBOARD_METRIC),
    window: searchParam(LeaderboardWindow, DEFAULT_LEADERBOARD_WINDOW),
  }),
);

type LeaderboardSearch = typeof leaderboardSearchSchema.Type;

const DEFAULT_LEADERBOARD_SEARCH = {
  metric: DEFAULT_LEADERBOARD_METRIC,
  window: DEFAULT_LEADERBOARD_WINDOW,
} as const satisfies LeaderboardSearch;

const WINDOW_OPTIONS = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "All time", value: "all" },
] as const satisfies readonly SegmentedOption<typeof LeaderboardWindow.Type>[];

const METRIC_OPTIONS = [
  { label: "Spend", value: "spend" },
  { label: "Tokens", value: "tokens" },
] as const satisfies readonly SegmentedOption<typeof LeaderboardMetric.Type>[];

const AGENTS_WITH_ICONS = SUPPORTED_AGENTS.flatMap((agent) => {
  const Icon = AGENT_ICONS[agent.source];
  return Icon === undefined ? [] : [{ Icon, label: agent.label }];
});

type LeaderboardEntry = (typeof LeaderboardResponse.Type)["entries"][number];

/** Tighter gutters on phones, so more columns fit before the table scrolls. */
const CELL = "whitespace-nowrap px-2 py-3 sm:px-3";
const NUMBER_CELL = cn(CELL, "text-right tabular-nums");
const DETAIL_CELL = cn(NUMBER_CELL, "text-muted-foreground");

/**
 * Rank and avatar share one pinned cell while the login and numbers scroll
 * under it; keeping the pinned block this narrow leaves phones room for the
 * data. It inherits its row's background, so rows are painted with opaque
 * mixes rather than alpha tints.
 *
 * At fractional zoom Chromium rounds the scroller's clip outward, so slivers
 * of scrolled text could show past the pinned cell's left edge. It is one
 * cell (no seam between pinned boxes) on its own compositor layer, and a
 * background bleed widens that layer past the clip edge to cover the gap.
 */
const PINNED_CELL = cn(
  // w-px: shrink to its content, so desktop tables give spare width to the data.
  "sticky left-0 z-10 w-px whitespace-nowrap bg-inherit py-3 pr-2 pl-2 will-change-transform sm:pl-3",
  "before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-inherit",
  // A hairline and soft shadow mark the pinned edge once rows scroll under it.
  "group-data-scrolled/board:shadow-[inset_-1px_0_0_var(--color-border),6px_0_8px_-6px_rgb(0_0_0/0.2)]",
);
/** Wide enough for a three-digit rank, so avatars line up in one column. */
const RANK = "inline-block w-12";
/** The pinned cell's `pr-2` plus this `pl-0.5` keep the old 10px avatar–login gap. */
const LOGIN_CELL = "whitespace-nowrap py-3 pr-2 pl-0.5 sm:pr-3";
const HEADER_ROW_BG = "bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-background))]";
const BODY_ROW_BG =
  "bg-background hover:bg-[color-mix(in_oklab,var(--color-muted)_40%,var(--color-background))]";

const Route = createFileRoute("/(home)/")({
  validateSearch: leaderboardSearchSchema,
  search: {
    middlewares: [stripSearchParams<LeaderboardSearch>(DEFAULT_LEADERBOARD_SEARCH)],
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(leaderboardQueryOptions(deps.metric, deps.window));
  },
  head: () => ({
    ...pageHead({ path: "/" }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(softwareApplicationSchema()),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify(faqPageSchema(FAQ_ITEMS)),
      },
    ],
  }),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  const { metric, window } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(leaderboardQueryOptions(metric, window));

  return (
    <>
      <HeroSection />

      <section
        className="scroll-mt-14"
        id="leaderboard"
        aria-labelledby="homepage-leaderboard-title"
      >
        <header className="px-4 pt-8 pb-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="homepage-leaderboard-title">
                Leaderboard
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <SegmentedControl
                label="Rank by"
                onChange={(value) =>
                  navigate({
                    resetScroll: false,
                    search: (prev) => ({ ...prev, metric: value }),
                  })
                }
                options={METRIC_OPTIONS}
                value={metric}
              />
              <SegmentedControl
                label="Time window"
                onChange={(value) =>
                  navigate({
                    resetScroll: false,
                    search: (prev) => ({ ...prev, window: value }),
                  })
                }
                options={WINDOW_OPTIONS}
                value={window}
              />
            </div>
          </div>
        </header>

        <LeaderboardTable entries={data.entries} />
      </section>

      <FaqSection />
    </>
  );
}

function LeaderboardTable({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const [scrolled, setScrolled] = useState(false);

  if (entries.length === 0) {
    return (
      <div className="border-y border-border">
        <p className="p-6 text-sm text-muted-foreground">
          Nobody on the board yet — be the first to sync.
        </p>
      </div>
    );
  }

  return (
    // Phones get every column: the table scrolls sideways inside this frame
    // (never the page), and it is focusable so keyboards can scroll it too.
    <div
      aria-label="Leaderboard table"
      className="group/board overflow-x-auto overscroll-x-contain border-y border-border outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      data-scrolled={scrolled ? "" : undefined}
      onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}
      role="region"
      tabIndex={0}
    >
      {/* Separate borders live on the cells, so they travel with the pinned
          cell; collapsed borders belong to the table and some engines leave
          them behind when a sticky cell moves. */}
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Leaderboard of top users by LLM token spend and usage</caption>
        <thead>
          <tr
            className={cn(
              "text-left text-xs uppercase tracking-wider text-muted-foreground [&>th]:border-b [&>th]:border-border",
              HEADER_ROW_BG,
            )}
          >
            <th className={cn(PINNED_CELL, "font-medium")} scope="col">
              {/* Spans the avatar too; the spacer keeps the pinned width. */}
              <span className={RANK}>#</span>
              <span aria-hidden="true" className="inline-block w-6" />
            </th>
            <th className={cn(LOGIN_CELL, "font-medium")} scope="col">
              User
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Spend
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Tokens
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Active days
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Last active
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              className={cn(
                "transition-colors [&>td]:border-b [&>td]:border-border last:[&>td]:border-b-0",
                BODY_ROW_BG,
              )}
              key={entry.user.login}
            >
              <td className={PINNED_CELL}>
                <div className="flex items-center">
                  <span className={cn(RANK, "font-mono tabular-nums text-muted-foreground")}>
                    {entry.rank}
                  </span>
                  {/* Pointer shortcut only: the login link beside it is the tab stop and name. */}
                  <Link
                    aria-hidden="true"
                    className="flex"
                    params={{ user: entry.user.login }}
                    tabIndex={-1}
                    to="/$user"
                  >
                    <Avatar size={24} src={entry.user.avatarUrl} />
                  </Link>
                </div>
              </td>
              <td className={LOGIN_CELL}>
                <Link
                  className="font-medium hover:underline"
                  params={{ user: entry.user.login }}
                  to="/$user"
                >
                  {entry.user.login}
                </Link>
              </td>
              <td className={cn(NUMBER_CELL, "font-mono")}>{formatUsd(entry.spendUsd)}</td>
              <td className={cn(NUMBER_CELL, "font-mono")}>{formatTokens(entry.totalTokens)}</td>
              <td className={DETAIL_CELL}>{entry.activeDays}</td>
              <td className={DETAIL_CELL}>{entry.lastDate ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeroSection() {
  return (
    <section className="border-b border-border px-4 py-10 sm:py-14" aria-labelledby="hero-title">
      <h1 className="max-w-3xl text-2xl font-semibold tracking-tight" id="hero-title">
        The best place to track token usage
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        A local CLI, built on ccusage, that syncs your token usage with everyone else.
      </p>
      <div className="mt-6 max-w-3xl">
        <BootstrapCommand />
        <ul
          className="mt-4 flex flex-wrap items-center gap-2 text-muted-foreground"
          aria-label="Supported agents"
        >
          {AGENTS_WITH_ICONS.map(({ Icon, label }) => (
            <li key={label}>
              <span
                aria-label={label}
                className="inline-flex size-8 items-center justify-center"
                role="img"
                title={label}
              >
                <Icon />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="scroll-mt-14 pt-8" id="faq" aria-labelledby="homepage-faq-title">
      <h2 id="homepage-faq-title" className="px-4 text-lg font-semibold tracking-tight">
        FAQ
      </h2>
      <div className="mt-4 divide-y divide-border border-y border-border">
        {FAQ_ITEMS.map((item) => (
          <Collapsible.Root className="px-4 py-4" key={item.question}>
            <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-2 bg-transparent p-0 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span
                aria-hidden="true"
                className="w-4 shrink-0 text-center font-mono text-muted-foreground transition-transform group-data-panel-open:rotate-45"
              >
                +
              </span>
              <span>{item.question}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel
              className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0"
              hiddenUntilFound
            >
              <div className="ml-6 max-w-2xl pt-3 text-sm leading-6 text-muted-foreground">
                {item.answer ?? item.answerText}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ))}
      </div>
    </section>
  );
}

export { Route };
