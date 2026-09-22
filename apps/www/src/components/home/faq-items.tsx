import type { ReactNode } from "react";

import { supportedAgentSentenceList } from "../../lib/agents";
import type { FaqItem } from "../../lib/jsonld";
import { CCUSAGE_URL, NPM_INSTALL_COMMAND } from "../../lib/site";
import { ExternalLink } from "../external-link";
import { Code } from "../ui/code";

/**
 * Homepage FAQ. `answerText` feeds FAQPage JSON-LD and is rendered as-is
 * unless a richer `answer` (with inline code or links) is given.
 */

interface HomeFaqItem extends FaqItem {
  answer?: ReactNode;
}

const FAQ_ITEMS: readonly HomeFaqItem[] = [
  {
    question: "What is tokenmaxxing?",
    answerText:
      "tokenmaxxing is a public leaderboard for LLM agent usage. It syncs your local usage from supported coding agents, turns it into daily token and spend totals, and lets you compare with other users.",
  },
  {
    question: "How do I join the leaderboard?",
    answer: (
      <>
        Install the CLI, then run the bootstrap command.
        <span className="mt-3 block">
          <Code>{NPM_INSTALL_COMMAND}</Code>
        </span>
        <span className="mt-2 block">
          <Code>tokenmaxxing bootstrap</Code>
        </span>
        <span className="mt-3 block">
          Bootstrap signs you in, syncs your usage, and can set up automatic syncing.
        </span>
      </>
    ),
    answerText: `Install the CLI, then run the bootstrap command. Run \`${NPM_INSTALL_COMMAND}\`, then \`tokenmaxxing bootstrap\`. Bootstrap signs you in, syncs your usage, and can set up automatic syncing.`,
  },
  {
    question: "Which agents does it support?",
    answer: (
      <>
        tokenmaxxing uses <ExternalLink href={CCUSAGE_URL}>ccusage</ExternalLink> to parse local
        usage from {supportedAgentSentenceList()}.
      </>
    ),
    answerText: `tokenmaxxing uses ccusage to parse local usage from ${supportedAgentSentenceList()}.`,
  },
  {
    question: "What data gets uploaded?",
    answerText:
      "Only daily aggregates: date, model name, agent source, token counts, and API-equivalent cost. Prompts, file paths, project names, and session content are never uploaded.",
  },
  {
    question: "Why is usage data missing?",
    answerText:
      "tokenmaxxing only reads usage data that still exists on your local computer. Some agents clean up old local logs automatically; for example, Claude Code can retain logs for only 30 days by default. If older local data has already been deleted, tokenmaxxing cannot recover or upload it.",
  },
  {
    question: "Are profiles public?",
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

export { FAQ_ITEMS };

export type { HomeFaqItem };
