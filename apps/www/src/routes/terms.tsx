import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Code } from "../components/ui/code";
import { SITE_ORIGIN } from "../lib/og";

const GITHUB_URL = "https://github.com/851-labs/tokenmaxxing";
const DISCORD_URL = "https://discord.gg/WzX6BpfaRH";

const TERMS_TITLE = "Terms of Service — tokenmaxxing.sh";
const TERMS_DESCRIPTION =
  "The terms for using tokenmaxxing.sh, the public leaderboard for LLM agent usage, provided as-is and free of charge.";
const TERMS_URL = new URL("/terms", SITE_ORIGIN).toString();

const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: TERMS_TITLE },
      { content: TERMS_DESCRIPTION, name: "description" },
      { content: TERMS_TITLE, property: "og:title" },
      { content: TERMS_DESCRIPTION, property: "og:description" },
      { content: TERMS_URL, property: "og:url" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="px-4 py-10 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: June 20, 2026</p>
      </header>

      <div className="mt-10 space-y-8">
        <Section title="The service">
          tokenmaxxing.sh is a public leaderboard for LLM agent usage. It is provided as-is and free
          of charge. We may change, pause, or shut down the service at any time, and features may be
          added or removed without notice.
        </Section>

        <Section title="Accounts">
          You sign in through a third-party OAuth provider. You are responsible for activity under
          your account and for keeping your CLI tokens secure. CLI tokens do not expire
          automatically; revoke them with <Code>tokenmaxxing logout</Code> or from your settings if
          a device is lost or compromised.
        </Section>

        <Section title="Acceptable use">
          Don&apos;t abuse the service. In particular, don&apos;t overload or disrupt the API,
          scrape the site in ways that degrade it for others, upload usage data that isn&apos;t
          yours, or attempt to fabricate or game leaderboard rankings. We may rate-limit or block
          activity that threatens the service.
        </Section>

        <Section title="Public content">
          Profiles and leaderboard totals are public. Your username, avatar, and aggregated usage
          totals are visible to anyone. Device hostnames are shown only to you in settings and in
          your own per-device breakdown. Don&apos;t publish anything you aren&apos;t comfortable
          making public.
        </Section>

        <Section title="Data accuracy">
          Spend figures are API-equivalent estimates derived from your parsed local usage. They are
          meant for leaderboard comparison and usage tracking, not for billing reconciliation, and
          may differ from what you are actually charged by any provider.
        </Section>

        <Section title="Termination">
          You can stop using the service at any time. You can revoke CLI tokens and remove device
          data from your settings page. We may suspend or remove accounts that violate these terms
          or abuse the service.
        </Section>

        <Section title="Disclaimers and liability">
          The service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties
          of any kind, express or implied. To the maximum extent permitted by law, tokenmaxxing and
          its maintainers are not liable for any indirect, incidental, or consequential damages
          arising from your use of the service.
        </Section>

        <Section title="Changes and contact">
          We may update these terms over time; continued use after an update means you accept the
          revised terms. Questions or concerns can be raised on{" "}
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
