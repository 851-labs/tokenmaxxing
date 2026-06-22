import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import { profileOgDescription, profileOgTitle, SITE_ORIGIN } from "./og";

type Profile = typeof ProfileResponse.Type;

const ORGANIZATION_NAME = "851 Labs";
const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN}/#website`;
const SITE_NAME = "tokenmaxxing.sh";

const ORGANIZATION_SAME_AS = [
  "https://github.com/851-labs",
  "https://x.com/851labs",
  "https://discord.gg/851labs",
];

function organizationSchema(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: ORGANIZATION_NAME,
    url: SITE_ORIGIN,
    sameAs: ORGANIZATION_SAME_AS,
  };
}

function webSiteSchema(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: SITE_NAME,
    url: SITE_ORIGIN,
    description: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
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
    url: SITE_ORIGIN,
    downloadUrl: "https://www.npmjs.com/package/@851-labs/tokenmaxxing",
    installUrl: "https://www.npmjs.com/package/@851-labs/tokenmaxxing",
    softwareHelp: { "@type": "CreativeWork", text: "npm install -g @851-labs/tokenmaxxing" },
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

function profilePageSchema(profile: Profile): Record<string, unknown> {
  const { stats, user } = profile;
  const url = new URL(`/${encodeURIComponent(user.login)}`, SITE_ORIGIN).toString();

  const person: Record<string, unknown> = {
    "@type": "Person",
    name: user.login,
    identifier: user.login,
    url,
    sameAs: [`https://github.com/${user.login}`],
  };

  if (user.avatarUrl !== null) {
    person.image = user.avatarUrl;
  }

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    name: profileOgTitle(profile),
    description: profileOgDescription(profile),
    url,
    mainEntity: person,
  };

  if (stats.activeDays > 0) {
    const variableMeasured: Record<string, unknown>[] = [
      { "@type": "PropertyValue", name: "totalSpendUsd", value: stats.totalSpendUsd },
      { "@type": "PropertyValue", name: "totalTokens", value: stats.totalTokens },
      { "@type": "PropertyValue", name: "activeDays", value: stats.activeDays },
      { "@type": "PropertyValue", name: "sessionCount", value: stats.sessionCount },
    ];

    const dataset: Record<string, unknown> = {
      "@type": "Dataset",
      name: `${user.login} token usage`,
      description: profileOgDescription(profile),
      url,
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
        item: SITE_ORIGIN,
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
  organizationSchema,
  profilePageSchema,
  softwareApplicationSchema,
  webSiteSchema,
};

export type { FaqItem };
