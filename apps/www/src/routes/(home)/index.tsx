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
import { z } from "zod";

import { AGENT_ICONS } from "./-components/agent-icons";
import { BootstrapCommand } from "./-components/bootstrap-command";
import { FAQ_ITEMS } from "./-components/faq-items";
import { Avatar } from "../../components/ui/avatar";
import { SegmentedControl, type SegmentedOption } from "../../components/ui/segmented-control";
import { SUPPORTED_AGENTS } from "../../lib/agents";
import { formatTokens, formatUsd } from "../../lib/format";
import { faqPageSchema, softwareApplicationSchema } from "../../lib/jsonld";
import { leaderboardQueryOptions } from "../../lib/queries";
import { pageHead } from "../../lib/seo";

const leaderboardSearchSchema = z.object({
  metric: z
    .enum(LeaderboardMetric.literals)
    .default(DEFAULT_LEADERBOARD_METRIC)
    .catch(DEFAULT_LEADERBOARD_METRIC),
  window: z
    .enum(LeaderboardWindow.literals)
    .default(DEFAULT_LEADERBOARD_WINDOW)
    .catch(DEFAULT_LEADERBOARD_WINDOW),
});

type LeaderboardSearch = z.infer<typeof leaderboardSearchSchema>;

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
            <div className="flex gap-2">
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
  return (
    <div className="overflow-hidden border-y border-border">
      {entries.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          Nobody on the board yet — be the first to sync.
        </p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">
            Leaderboard of top users by LLM token spend and usage
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="w-12 p-3 font-medium" scope="col">
                #
              </th>
              <th className="p-3 font-medium" scope="col">
                User
              </th>
              <th className="p-3 text-right font-medium" scope="col">
                Spend
              </th>
              <th className="p-3 text-right font-medium" scope="col">
                Tokens
              </th>
              <th className="hidden p-3 text-right font-medium sm:table-cell" scope="col">
                Active days
              </th>
              <th className="hidden p-3 text-right font-medium sm:table-cell" scope="col">
                Last active
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/40"
                key={entry.user.id}
              >
                <td className="p-3 font-mono text-muted-foreground">{entry.rank}</td>
                <td className="p-3">
                  <Link
                    className="flex items-center gap-2.5 font-medium hover:underline"
                    params={{ user: entry.user.login }}
                    to="/$user"
                  >
                    <Avatar
                      alt={`${entry.user.login} avatar`}
                      size={24}
                      src={entry.user.avatarUrl}
                    />
                    {entry.user.login}
                  </Link>
                </td>
                <td className="p-3 text-right font-mono tabular-nums">
                  {formatUsd(entry.spendUsd)}
                </td>
                <td className="p-3 text-right font-mono tabular-nums">
                  {formatTokens(entry.totalTokens)}
                </td>
                <td className="hidden p-3 text-right tabular-nums text-muted-foreground sm:table-cell">
                  {entry.activeDays}
                </td>
                <td className="hidden p-3 text-right text-muted-foreground sm:table-cell">
                  {entry.lastDate ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
