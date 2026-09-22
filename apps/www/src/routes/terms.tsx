import { createFileRoute } from "@tanstack/react-router";

import { ExternalLink } from "../components/external-link";
import { LegalPage, LegalSection } from "../components/legal-page";
import { Code } from "../components/ui/code";
import { pageHead } from "../lib/seo";
import { DISCORD_URL, GITHUB_URL } from "../lib/site";

const TERMS_TITLE = "Terms of Service — tokenmaxxing.sh";
const TERMS_DESCRIPTION =
  "The terms for using tokenmaxxing.sh, the public leaderboard for LLM agent usage, provided as-is and free of charge.";

const Route = createFileRoute("/terms")({
  head: () => pageHead({ description: TERMS_DESCRIPTION, path: "/terms", title: TERMS_TITLE }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="June 20, 2026">
      <LegalSection title="The service">
        tokenmaxxing.sh is a public leaderboard for LLM agent usage. It is provided as-is and free
        of charge. We may change, pause, or shut down the service at any time, and features may be
        added or removed without notice.
      </LegalSection>

      <LegalSection title="Accounts">
        You sign in through a third-party OAuth provider. You are responsible for activity under
        your account and for keeping your CLI tokens secure. CLI tokens do not expire automatically;
        revoke them with <Code>tokenmaxxing logout</Code> or from your settings if a device is lost
        or compromised.
      </LegalSection>

      <LegalSection title="Acceptable use">
        Don&apos;t abuse the service. In particular, don&apos;t overload or disrupt the API, scrape
        the site in ways that degrade it for others, upload usage data that isn&apos;t yours, or
        attempt to fabricate or game leaderboard rankings. We may rate-limit or block activity that
        threatens the service.
      </LegalSection>

      <LegalSection title="Public content">
        Profiles and leaderboard totals are public. Your username, avatar, and aggregated usage
        totals are visible to anyone. Device hostnames are shown only to you in settings and in your
        own per-device breakdown. Don&apos;t publish anything you aren&apos;t comfortable making
        public.
      </LegalSection>

      <LegalSection title="Data accuracy">
        Spend figures are API-equivalent estimates derived from your parsed local usage. They are
        meant for leaderboard comparison and usage tracking, not for billing reconciliation, and may
        differ from what you are actually charged by any provider.
      </LegalSection>

      <LegalSection title="Termination">
        You can stop using the service at any time. You can revoke CLI tokens and remove device data
        from your settings page. We may suspend or remove accounts that violate these terms or abuse
        the service.
      </LegalSection>

      <LegalSection title="Disclaimers and liability">
        The service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties
        of any kind, express or implied. To the maximum extent permitted by law, tokenmaxxing and
        its maintainers are not liable for any indirect, incidental, or consequential damages
        arising from your use of the service.
      </LegalSection>

      <LegalSection title="Changes and contact">
        We may update these terms over time; continued use after an update means you accept the
        revised terms. Questions or concerns can be raised on{" "}
        <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink> or in our{" "}
        <ExternalLink href={DISCORD_URL}>Discord</ExternalLink>.
      </LegalSection>
    </LegalPage>
  );
}

export { Route };
