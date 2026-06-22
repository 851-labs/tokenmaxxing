import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Code } from "../components/ui/code";
import { SITE_ORIGIN } from "../lib/og";

const GITHUB_URL = "https://github.com/851-labs/tokenmaxxing";
const DISCORD_URL = "https://discord.gg/WzX6BpfaRH";
const CCUSAGE_URL = "https://ccusage.com/";

const PRIVACY_TITLE = "Privacy Policy — tokenmaxxing.sh";
const PRIVACY_DESCRIPTION =
  "How tokenmaxxing handles your data: we collect only daily usage aggregates and never your prompts, code, or session content.";
const PRIVACY_URL = new URL("/privacy", SITE_ORIGIN).toString();

const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: PRIVACY_TITLE },
      { content: PRIVACY_DESCRIPTION, name: "description" },
      { content: PRIVACY_TITLE, property: "og:title" },
      { content: PRIVACY_DESCRIPTION, property: "og:description" },
      { content: PRIVACY_URL, property: "og:url" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="px-4 py-10 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: June 20, 2026</p>
      </header>

      <div className="mt-10 space-y-8">
        <Section title="What we collect">
          tokenmaxxing collects daily usage aggregates only: the date, model name, agent source,
          token counts, and an API-equivalent cost estimate. When you sign in we also store your
          OAuth profile basics (username and avatar) and the hostnames of the devices you sync from.
        </Section>

        <Section title="What we never collect">
          Prompts, file paths, project names, and session content are never uploaded. We only ever
          receive the aggregated counts described above — never the contents of your conversations
          or your code.
        </Section>

        <Section title="How data is sourced">
          The CLI uses <ExternalLink href={CCUSAGE_URL}>ccusage</ExternalLink> to parse usage
          locally from supported coding agents (Claude Code, Codex, OpenCode, Gemini CLI, and
          Copilot CLI). It only reads usage data that still exists on your computer; if an agent has
          already cleaned up its local logs, that data cannot be recovered or uploaded. You can
          preview exactly what would be sent with <Code>tokenmaxxing sync --dry-run</Code>.
        </Section>

        <Section title="What is public and what is private">
          Profiles and leaderboard totals are public — your username, avatar, and aggregated usage
          are visible to anyone. Device hostnames are private and shown only to you in settings and
          in your own per-device breakdown.
        </Section>

        <Section title="How we use your data">
          We use the data you sync to compute and display leaderboard rankings and your public
          profile, and to show you your own per-device usage breakdown.
        </Section>

        <Section title="Retention and deletion">
          You stay in control of your data. CLI tokens do not expire automatically, but you can
          revoke them at any time with <Code>tokenmaxxing logout</Code> or from your settings page.
          You can also remove device data from settings.
        </Section>

        <Section title="Third parties">
          We rely on your chosen OAuth provider to sign you in, and on the public GitHub API to show
          the repository&apos;s star count. We don&apos;t sell your data or share it with
          advertisers.
        </Section>

        <Section title="Changes and contact">
          We may update this policy over time. Questions about your data can be raised on{" "}
          <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink> or in our{" "}
          <ExternalLink href={DISCORD_URL}>Discord</ExternalLink>.
        </Section>
      </div>
    </div>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section>
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p>
    </section>
  );
}

function ExternalLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a
      className="font-medium text-foreground hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

export { Route };
