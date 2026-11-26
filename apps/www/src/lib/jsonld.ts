import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import { profileOgDescription, profileOgTitle } from "./og";
import {
  DISCORD_URL,
  githubProfileUrl,
  NPM_INSTALL_COMMAND,
  NPM_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  siteUrl,
} from "./site";

type Profile = typeof ProfileResponse.Type;

const ORGANIZATION_NAME = "851 Labs";
const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

const ORGANIZATION_SAME_AS = ["https://github.com/851-labs", "https://x.com/851labs", DISCORD_URL];

/** The home page as its canonical link spells it, trailing slash included. */
const HOME_URL = siteUrl("/");
/** A square raster mark: Google wants a logo of at least 112x112 it can crawl. */
const LOGO_URL = siteUrl("/apple-touch-icon.png");
/** What people call the site without its TLD; a candidate for Google's site name. */
const SITE_ALTERNATE_NAME = "tokenmaxxing";

/**
 * A `<script type="application/ld+json">` head entry. `<` is escaped so a
 * value that happens to hold `</script>` cannot end the block early; the
 * escape is plain JSON, so parsers read the same data.
 */
function jsonLdScript(schema: Record<string, unknown>): { children: string; type: string } {
  return {
    type: "application/ld+json",
    children: JSON.stringify(schema).replaceAll("<", "\\u003c"),
  };
}

function organizationSchema(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: ORGANIZATION_NAME,
    url: HOME_URL,
    logo: LOGO_URL,
    sameAs: ORGANIZATION_SAME_AS,
  };
}

function webSiteSchema(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: SITE_NAME,
    alternateName: SITE_ALTERNATE_NAME,
    url: HOME_URL,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

function softwareApplicationSchema(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "tokenmaxxing",
    description:
      "CLI that syncs local LLM agent usage and publishes it to the tokenmaxxing.sh leaderboard.",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    url: HOME_URL,
    downloadUrl: NPM_URL,
    installUrl: NPM_URL,
    softwareHelp: { "@type": "CreativeWork", text: NPM_INSTALL_COMMAND },
    publisher: { "@id": ORGANIZATION_ID },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}

interface FaqItem {
  answerText: string;
  question: string;
}

function faqPageSchema(items: readonly FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answerText,
      },
    })),
  };
}

/**
 * A profile's Dataset description. Google rejects a Dataset whose description
 * is under 50 characters, and the stats sentence alone can fall short for a
 * short login with little usage, so it follows a fixed lead-in.
 */
function profileDatasetDescription(profile: Profile): string {
  return `Daily token usage and API-equivalent spend that ${profile.user.login} synced to ${SITE_NAME} from their coding agents. ${profileOgDescription(profile)}`;
}

function profilePageSchema(profile: Profile): Record<string, unknown> {
  const { stats, user } = profile;
  const url = siteUrl(`/${encodeURIComponent(user.login)}`);
  const personId = `${url}#person`;

  const person: Record<string, unknown> = {
    "@type": "Person",
    "@id": personId,
    name: user.login,
    identifier: user.login,
    url,
  };

  // The GitHub account as GitHub last reported it. `user.login` is the
  // tokenmaxxing username, which can be suffixed, Google-derived or stale.
  if (user.githubLogin !== null) {
    person.sameAs = [githubProfileUrl(user.githubLogin)];
  }

  if (user.avatarUrl !== null) {
    person.image = user.avatarUrl;
  }

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    name: profileOgTitle(profile),
    description: profileOgDescription(profile),
    url,
    isPartOf: { "@id": WEBSITE_ID },
    mainEntity: person,
  };

  if (stats.activeDays > 0) {
    const variableMeasured: Record<string, unknown>[] = [
      { "@type": "PropertyValue", name: "totalSpendUsd", value: stats.spendUsd },
      { "@type": "PropertyValue", name: "totalTokens", value: stats.totalTokens },
      { "@type": "PropertyValue", name: "activeDays", value: stats.activeDays },
      { "@type": "PropertyValue", name: "sessionCount", value: stats.sessionCount },
    ];

    const dataset: Record<string, unknown> = {
      "@type": "Dataset",
      name: `${user.login} token usage`,
      description: profileDatasetDescription(profile),
      url,
      creator: { "@id": personId },
      isAccessibleForFree: true,
      variableMeasured,
    };

    if (stats.firstDate !== null && stats.lastDate !== null) {
      dataset.temporalCoverage = `${stats.firstDate}/${stats.lastDate}`;
    }

    schema.about = dataset;
  }

  return schema;
}

function breadcrumbSchema(login: string, url: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: HOME_URL,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: login,
        item: url,
      },
    ],
  };
}

export {
  breadcrumbSchema,
  faqPageSchema,
  jsonLdScript,
  organizationSchema,
  profilePageSchema,
  softwareApplicationSchema,
  webSiteSchema,
};

export type { FaqItem };
