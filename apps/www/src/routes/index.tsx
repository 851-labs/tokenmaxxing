import { Collapsible } from "@base-ui-components/react/collapsible";
import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";
import { useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react/ssr";
import { z } from "zod";

import { formatTokens, formatUsd } from "../components/charts/scale";
import { Avatar } from "../components/ui/avatar";
import { Code } from "../components/ui/code";
import { Tabs } from "../components/ui/tabs";
import { cn } from "../lib/cn";
import { faqPageSchema, softwareApplicationSchema } from "../lib/jsonld";
import { leaderboardQueryOptions } from "../lib/queries";

const LEADERBOARD_METRIC_VALUES = ["spend", "tokens"] as const;
const LEADERBOARD_WINDOW_VALUES = ["7d", "30d", "all"] as const;

const leaderboardSearchSchema = z.object({
  metric: z.enum(LEADERBOARD_METRIC_VALUES).default("spend").catch("spend"),
  window: z.enum(LEADERBOARD_WINDOW_VALUES).default("30d").catch("30d"),
});

type LeaderboardSearch = z.infer<typeof leaderboardSearchSchema>;

const DEFAULT_LEADERBOARD_SEARCH = {
  metric: "spend",
  window: "30d",
} as const satisfies LeaderboardSearch;

const Route = createFileRoute("/")({
  validateSearch: leaderboardSearchSchema,
  search: {
    middlewares: [stripSearchParams<LeaderboardSearch>(DEFAULT_LEADERBOARD_SEARCH)],
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(leaderboardQueryOptions(deps.metric, deps.window));
  },
  head: () => ({
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(softwareApplicationSchema()),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify(
          faqPageSchema(
            FAQ_ITEMS.map((item) => ({ answerText: item.answerText, question: item.question })),
          ),
        ),
      },
    ],
  }),
  component: LeaderboardPage,
});

const WINDOWS: { label: string; value: typeof LeaderboardWindow.Type }[] = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "All time", value: "all" },
];

const METRICS: { label: string; value: typeof LeaderboardMetric.Type }[] = [
  { label: "Spend", value: "spend" },
  { label: "Tokens", value: "tokens" },
];

const BOOTSTRAP_COMMANDS = [
  {
    command: "npm install -g @851-labs/tokenmaxxing\ntokenmaxxing bootstrap",
    label: "npm",
    value: "npm",
  },
  {
    command: "bun add -g @851-labs/tokenmaxxing\ntokenmaxxing bootstrap",
    label: "bun",
    value: "bun",
  },
  {
    command: "pnpm add -g @851-labs/tokenmaxxing\ntokenmaxxing bootstrap",
    label: "pnpm",
    value: "pnpm",
  },
] as const;

type BootstrapPackageManager = (typeof BOOTSTRAP_COMMANDS)[number]["value"];

const SUPPORTED_AGENTS = [
  { icon: <ClaudeCodeIcon />, label: "Claude Code" },
  { icon: <OpenAICodexIcon />, label: "OpenAI Codex" },
  { icon: <CursorIcon />, label: "Cursor" },
  { icon: <OpenCodeIcon />, label: "OpenCode" },
  { icon: <GeminiIcon />, label: "Gemini CLI" },
] as const;

const FAQ_ITEMS: { answer: ReactNode; answerText: string; question: string }[] = [
  {
    question: "What is tokenmaxxing?",
    answer:
      "tokenmaxxing is a public leaderboard for LLM agent usage. It syncs your local usage from supported coding agents, turns it into daily token and spend totals, and lets you compare with other users.",
    answerText:
      "tokenmaxxing is a public leaderboard for LLM agent usage. It syncs your local usage from supported coding agents, turns it into daily token and spend totals, and lets you compare with other users.",
  },
  {
    question: "How do I join the leaderboard?",
    answer: (
      <>
        Install the CLI, then run the bootstrap command.
        <span className="mt-3 block">
          <Code>npm install -g @851-labs/tokenmaxxing</Code>
        </span>
        <span className="mt-2 block">
          <Code>tokenmaxxing bootstrap</Code>
        </span>
        <span className="mt-3 block">
          Bootstrap signs you in, syncs your usage, and can set up automatic syncing.
        </span>
      </>
    ),
    answerText:
      "Install the CLI, then run the bootstrap command. Run `npm install -g @851-labs/tokenmaxxing`, then `tokenmaxxing bootstrap`. Bootstrap signs you in, syncs your usage, and can set up automatic syncing.",
  },
  {
    question: "Which agents does it support?",
    answer: (
      <>
        tokenmaxxing uses{" "}
        <a
          className="font-medium text-foreground hover:underline"
          href="https://ccusage.com/"
          rel="noreferrer"
          target="_blank"
        >
          ccusage
        </a>{" "}
        to parse local usage from Claude Code, Codex, OpenCode, Gemini CLI, and Copilot CLI.
      </>
    ),
    answerText:
      "tokenmaxxing uses ccusage to parse local usage from Claude Code, Codex, OpenCode, Gemini CLI, and Copilot CLI.",
  },
  {
    question: "What data gets uploaded?",
    answer:
      "Only daily aggregates: date, model name, agent source, token counts, and API-equivalent cost. Prompts, file paths, project names, and session content are never uploaded.",
    answerText:
      "Only daily aggregates: date, model name, agent source, token counts, and API-equivalent cost. Prompts, file paths, project names, and session content are never uploaded.",
  },
  {
    question: "Why is usage data missing?",
    answer:
      "tokenmaxxing only reads usage data that still exists on your local computer. Some agents clean up old local logs automatically; for example, Claude Code can retain logs for only 30 days by default. If older local data has already been deleted, tokenmaxxing cannot recover or upload it.",
    answerText:
      "tokenmaxxing only reads usage data that still exists on your local computer. Some agents clean up old local logs automatically; for example, Claude Code can retain logs for only 30 days by default. If older local data has already been deleted, tokenmaxxing cannot recover or upload it.",
  },
  {
    question: "Are profiles public?",
    answer:
      "Yes. Profiles and leaderboard totals are public. Device hostnames are shown only to you in settings and in your own per-device breakdown.",
    answerText:
      "Yes. Profiles and leaderboard totals are public. Device hostnames are shown only to you in settings and in your own per-device breakdown.",
  },
  {
    question: "Can I sync multiple machines?",
    answer: (
      <>
        Yes. Run <Code>tokenmaxxing bootstrap</Code> on each machine. Your profile aggregates usage
        across devices, and sync is idempotent, so you can run it as often as you want.
      </>
    ),
    answerText:
      "Yes. Run `tokenmaxxing bootstrap` on each machine. Your profile aggregates usage across devices, and sync is idempotent, so you can run it as often as you want.",
  },
  {
    question: "How can I sync usage automatically?",
    answer: (
      <>
        Run <Code>tokenmaxxing service install</Code> to install an optional background service that
        syncs every 5 minutes. Use <Code>tokenmaxxing service status</Code> to check the last run
        and <Code>tokenmaxxing service doctor</Code> to inspect scheduler files, auth, locks,
        auto-update settings, and recent logs.
      </>
    ),
    answerText:
      "Run `tokenmaxxing service install` to install an optional background service that syncs every 5 minutes. Use `tokenmaxxing service status` to check the last run and `tokenmaxxing service doctor` to inspect scheduler files, auth, locks, auto-update settings, and recent logs.",
  },
  {
    question: "Can I delete or revoke access?",
    answer: (
      <>
        Yes. CLI tokens do not expire automatically, but you can revoke them with{" "}
        <Code>tokenmaxxing logout</Code> or from settings. You can also remove device data from your
        settings page.
      </>
    ),
    answerText:
      "Yes. CLI tokens do not expire automatically, but you can revoke them with `tokenmaxxing logout` or from settings. You can also remove device data from your settings page.",
  },
  {
    question: "How is spend calculated?",
    answer:
      "Spend is an API-equivalent estimate from the parsed usage data. It is meant for leaderboard comparison and usage tracking, not billing reconciliation.",
    answerText:
      "Spend is an API-equivalent estimate from the parsed usage data. It is meant for leaderboard comparison and usage tracking, not billing reconciliation.",
  },
  {
    question: "Can I preview what will sync?",
    answer: (
      <>
        Yes. Run <Code>tokenmaxxing sync --dry-run</Code> to see what would be pushed. You can also
        limit the range with <Code>--since YYYY-MM-DD</Code> or choose sources with flags like{" "}
        <Code>--sources claude,codex</Code>.
      </>
    ),
    answerText:
      "Yes. Run `tokenmaxxing sync --dry-run` to see what would be pushed. You can also limit the range with `--since YYYY-MM-DD` or choose sources with flags like `--sources claude,codex`.",
  },
];

function bootstrapCommandFor(value: BootstrapPackageManager) {
  return BOOTSTRAP_COMMANDS.find((option) => option.value === value) ?? BOOTSTRAP_COMMANDS[0];
}

function ClaudeCodeIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="currentColor" viewBox="0 0 24 24">
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24V14.051H21V17.079H19.513V20H18V17.079H16.513V20H15V17.079H9V20H7.488V17.079H6V20H4.487V17.079H3V14.05H0V10.95H3V5H20.998V10.949ZM6 10.949H7.488V8.102H6V10.949ZM16.51 10.949H18V8.102H16.51V10.949Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function OpenAICodexIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="currentColor" viewBox="0 0 24 24">
      <path
        clipRule="evenodd"
        d="M8.41221 1.41884C9.29525 1.05595 10.2564 0.924989 11.2044 1.03843C12.4263 1.17868 13.5153 1.69843 14.4714 2.59676C14.4843 2.60895 14.5 2.61777 14.5171 2.6224C14.5342 2.62704 14.5522 2.62737 14.5695 2.62334C15.8601 2.30618 17.1013 2.41801 18.292 2.95884L18.3498 2.98634L18.491 3.05601C19.7349 3.70043 20.6268 4.67851 21.1658 5.98751C21.4206 6.60993 21.549 7.25984 21.5517 7.93634C21.5697 8.44007 21.5141 8.94374 21.3867 9.43143C21.3804 9.45628 21.3805 9.48232 21.3869 9.50715C21.3933 9.53197 21.4059 9.55479 21.4234 9.57351C22.144 10.3041 22.6452 11.2223 22.8699 12.2236C23.2228 13.9662 22.8607 15.5373 21.7855 16.9353L21.6186 17.1369C20.9065 17.9524 19.9717 18.5421 18.9291 18.8337C18.9064 18.8402 18.8855 18.8521 18.8683 18.8684C18.8511 18.8847 18.838 18.9048 18.8301 18.9272C18.5964 19.6018 18.3617 20.1775 17.9254 20.7532C16.8263 22.2033 15.2102 23.01 13.3897 22.9999C11.9386 22.9926 10.6525 22.4618 9.53054 21.4086C9.51354 21.393 9.49277 21.3821 9.47026 21.3769C9.44776 21.3718 9.42431 21.3726 9.40221 21.3793C8.92738 21.5323 8.44888 21.5543 7.93188 21.5488C7.10591 21.5422 6.29236 21.3472 5.55313 20.9787C4.77936 20.5949 4.1058 20.0359 3.58596 19.3461C3.39988 19.0995 3.21563 18.8676 3.08088 18.5935C2.89503 18.2157 2.74318 17.8221 2.62713 17.4174C2.38346 16.4977 2.37809 15.5311 2.61154 14.6088C2.61909 14.587 2.6216 14.5638 2.61888 14.5409C2.61434 14.5182 2.60241 14.4975 2.58496 14.4823C2.01991 13.9107 1.58797 13.2215 1.31996 12.4638C1.14252 11.9972 1.03951 11.5057 1.01471 11.0072C0.97038 10.3507 1.02852 9.69139 1.18704 9.05284C1.59954 7.69251 2.38696 6.62551 3.54929 5.85093C3.80779 5.67859 4.05346 5.54476 4.28446 5.44943C4.54663 5.33943 4.80971 5.24776 5.07371 5.17076C5.09259 5.16516 5.10978 5.15493 5.1237 5.141C5.13763 5.12708 5.14786 5.10989 5.15346 5.09101C5.35365 4.3714 5.69795 3.69996 6.16546 3.11743C6.78879 2.34193 7.53771 1.77543 8.41221 1.41884ZM7.67521 8.61468C7.57286 8.43562 7.40357 8.30456 7.20459 8.25032C7.0056 8.19609 6.79322 8.22312 6.61417 8.32547C6.43511 8.42782 6.30405 8.59711 6.24981 8.79609C6.19558 8.99507 6.22261 9.20745 6.32496 9.38651L7.87779 12.1044L6.33046 14.7151C6.23559 14.892 6.21274 15.0987 6.26669 15.2921C6.32064 15.4854 6.44721 15.6504 6.61996 15.7527C6.79271 15.8549 6.99828 15.8864 7.19373 15.8407C7.38917 15.7949 7.55938 15.6754 7.66879 15.5071L9.44713 12.5078C9.51726 12.3895 9.55481 12.2547 9.55593 12.1172C9.55706 11.9797 9.52173 11.8443 9.45354 11.7249L7.67521 8.61468ZM12.6674 14.3347C12.4693 14.3465 12.2833 14.4334 12.1472 14.5778C12.0111 14.7222 11.9354 14.9132 11.9354 15.1116C11.9354 15.31 12.0111 15.5009 12.1472 15.6453C12.2833 15.7897 12.4693 15.8766 12.6674 15.8884H17.1114C17.311 15.8787 17.4993 15.7926 17.6371 15.6479C17.775 15.5032 17.8519 15.311 17.8519 15.1111C17.8519 14.9112 17.775 14.719 17.6371 14.5743C17.4993 14.4296 17.311 14.3435 17.1114 14.3338H12.6674V14.3347Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function OpenCodeIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 6 24 30">
      <path d="M18 30H6V18H18V30Z" fill="currentColor" opacity="0.45" />
      <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M21.2629 6.20722L12.4558 1.12249C12.173 0.959171 11.824 0.959171 11.5412 1.12249L2.73452 6.20722C2.49678 6.34449 2.35001 6.59835 2.35001 6.8733V17.1267C2.35001 17.4016 2.49678 17.6555 2.73452 17.7928L11.5416 22.8775C11.8244 23.0408 12.1734 23.0408 12.4562 22.8775L21.2633 17.7928C21.5011 17.6555 21.6478 17.4016 21.6478 17.1267V6.8733C21.6478 6.59835 21.5011 6.34449 21.2633 6.20722H21.2629ZM20.7097 7.28428L12.2077 22.0101C12.1502 22.1093 11.9985 22.0688 11.9985 21.9538V12.3115C11.9985 12.1189 11.8956 11.9407 11.7285 11.8439L3.37828 7.02298C3.27905 6.9655 3.31957 6.81376 3.43451 6.81376H20.4385C20.6799 6.81376 20.8308 7.07548 20.7101 7.2847H20.7097V7.28428Z" />
    </svg>
  );
}

function GeminiIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  );
}

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
              <Tabs
                onChange={(value) =>
                  navigate({
                    resetScroll: false,
                    search: (prev) => ({ ...prev, metric: value }),
                  })
                }
                options={METRICS}
                value={metric}
              />
              <Tabs
                onChange={(value) =>
                  navigate({
                    resetScroll: false,
                    search: (prev) => ({ ...prev, window: value }),
                  })
                }
                options={WINDOWS}
                value={window}
              />
            </div>
          </div>
        </header>

        <div className="overflow-hidden border-y border-border">
          {data.entries.length === 0 ? (
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
                {data.entries.map((entry) => (
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
                        <Avatar size={24} src={entry.user.avatarUrl} />
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
      </section>

      <FaqSection />
    </>
  );
}

function HeroSection() {
  const [packageManager, setPackageManager] = useState<BootstrapPackageManager>("npm");
  const [copiedPackageManager, setCopiedPackageManager] = useState<BootstrapPackageManager | null>(
    null,
  );
  const selectedCommand = bootstrapCommandFor(packageManager);
  const copied = copiedPackageManager === selectedCommand.value;

  const copyBootstrapCommand = async () => {
    if (navigator.clipboard === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedCommand.command);
      setCopiedPackageManager(selectedCommand.value);
      window.setTimeout(() => setCopiedPackageManager(null), 1500);
    } catch {
      return;
    }
  };

  return (
    <section className="border-b border-border px-4 py-10 sm:py-14" aria-labelledby="hero-title">
      <h1 className="max-w-3xl text-2xl font-semibold tracking-tight" id="hero-title">
        The best place to track your token usage
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        Sync local agent usage, publish your profile, and climb the leaderboard.
      </p>
      <div className="mt-6 max-w-3xl">
        <div className="overflow-hidden border border-border bg-muted/40">
          <BaseTabs.Root
            onValueChange={(next) => setPackageManager(next as BootstrapPackageManager)}
            value={packageManager}
          >
            <BaseTabs.List
              className="relative flex border-b border-border"
              aria-label="Package manager"
            >
              <BaseTabs.Indicator
                className="absolute bottom-0 left-[calc(var(--active-tab-left)+1rem)] z-0 h-0.5 w-[calc(var(--active-tab-width)-2rem)] bg-foreground transition-all duration-200 ease-out"
                renderBeforeHydration
              />
              {BOOTSTRAP_COMMANDS.map((option) => (
                <BaseTabs.Tab
                  className={cn(
                    "relative z-10 px-4 py-2.5 font-mono text-sm transition-colors",
                    "text-muted-foreground hover:text-foreground",
                    "data-[active]:text-foreground",
                  )}
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </BaseTabs.Tab>
              ))}
            </BaseTabs.List>
          </BaseTabs.Root>
          <button
            aria-label={`Copy ${selectedCommand.label} bootstrap command`}
            className="group flex w-full items-start justify-between gap-4 bg-transparent p-4 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => void copyBootstrapCommand()}
            type="button"
          >
            <code className="min-w-0 overflow-x-auto whitespace-pre font-mono text-sm leading-6 text-muted-foreground">
              {selectedCommand.command}
            </code>
            <span className="mt-0.5 shrink-0 text-muted-foreground opacity-100 transition-opacity group-hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </span>
          </button>
        </div>
        <ul
          className="mt-4 flex flex-wrap items-center gap-2 text-muted-foreground"
          aria-label="Supported agents"
        >
          {SUPPORTED_AGENTS.map((agent) => (
            <li key={agent.label}>
              <span
                aria-label={agent.label}
                className="inline-flex size-8 items-center justify-center"
                title={agent.label}
              >
                {agent.icon}
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
              <span className="w-4 shrink-0 text-center font-mono text-muted-foreground transition-transform group-data-[panel-open]:rotate-45">
                +
              </span>
              <span>{item.question}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel
              className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0"
              hiddenUntilFound
            >
              <div className="ml-6 max-w-2xl pt-3 text-sm leading-6 text-muted-foreground">
                {item.answer}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ))}
      </div>
    </section>
  );
}

export { Route };
