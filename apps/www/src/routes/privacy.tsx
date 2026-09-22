import { createFileRoute } from "@tanstack/react-router";

import { ExternalLink } from "../components/external-link";
import { LegalPage, LegalSection } from "../components/legal-page";
import { Code } from "../components/ui/code";
import { supportedAgentSentenceList } from "../lib/agents";
import { pageHead } from "../lib/seo";
import { CCUSAGE_URL, DISCORD_URL, GITHUB_URL } from "../lib/site";

const PRIVACY_TITLE = "Privacy Policy — tokenmaxxing.sh";
const PRIVACY_DESCRIPTION =
  "How tokenmaxxing handles your data: we collect only daily usage aggregates and never your prompts, code, or session content.";

const Route = createFileRoute("/privacy")({
  head: () =>
    pageHead({ description: PRIVACY_DESCRIPTION, path: "/privacy", title: PRIVACY_TITLE }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="June 20, 2026">
      <LegalSection title="What we collect">
        tokenmaxxing collects daily usage aggregates only: the date, model name, agent source, token
        counts, and an API-equivalent cost estimate. When you sign in we also store your OAuth
        profile basics (username and avatar) and the hostnames of the devices you sync from.
      </LegalSection>

      <LegalSection title="What we never collect">
        Prompts, file paths, project names, and session content are never uploaded. We only ever
        receive the aggregated counts described above — never the contents of your conversations or
        your code.
      </LegalSection>

      <LegalSection title="How data is sourced">
        The CLI uses <ExternalLink href={CCUSAGE_URL}>ccusage</ExternalLink> to parse usage locally
        from supported coding agents ({supportedAgentSentenceList()}). It only reads usage data that
        still exists on your computer; if an agent has already cleaned up its local logs, that data
        cannot be recovered or uploaded. You can preview exactly what would be sent with{" "}
        <Code>tokenmaxxing sync --dry-run</Code>.
      </LegalSection>

      <LegalSection title="What is public and what is private">
        Profiles and leaderboard totals are public — your username, avatar, and aggregated usage are
        visible to anyone. Device hostnames are private and shown only to you in settings and in
        your own per-device breakdown.
      </LegalSection>

      <LegalSection title="How we use your data">
        We use the data you sync to compute and display leaderboard rankings and your public
        profile, and to show you your own per-device usage breakdown.
      </LegalSection>

      <LegalSection title="Retention and deletion">
        You stay in control of your data. CLI tokens do not expire automatically, but you can revoke
        them at any time with <Code>tokenmaxxing logout</Code> or from your settings page. You can
        also remove device data from settings.
      </LegalSection>

      <LegalSection title="Third parties">
        We rely on your chosen OAuth provider to sign you in, and on the public GitHub API to show
        the repository&apos;s star count. We don&apos;t sell your data or share it with advertisers.
      </LegalSection>

      <LegalSection title="Changes and contact">
        We may update this policy over time. Questions about your data can be raised on{" "}
        <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink> or in our{" "}
        <ExternalLink href={DISCORD_URL}>Discord</ExternalLink>.
      </LegalSection>
    </LegalPage>
  );
}

export { Route };
