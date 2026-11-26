import { describe, expect, it } from "vite-plus/test";
import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import {
  breadcrumbSchema,
  jsonLdScript,
  organizationSchema,
  profilePageSchema,
  softwareApplicationSchema,
  webSiteSchema,
} from "./jsonld";

type Profile = typeof ProfileResponse.Type;

describe("profilePageSchema", () => {
  it("links the stored GitHub account, not the tokenmaxxing username", () => {
    const schema = profilePageSchema(profile({ githubLogin: "Bob", login: "bob-2" }));

    expect(schema.mainEntity).toMatchObject({
      identifier: "bob-2",
      sameAs: ["https://github.com/Bob"],
      url: "https://tokenmaxxing.sh/bob-2",
    });
  });

  it("omits sameAs when no GitHub account is linked", () => {
    const schema = profilePageSchema(profile({ githubLogin: null, login: "carol" }));

    expect(schema.mainEntity).not.toHaveProperty("sameAs");
  });
});

describe("profile Dataset", () => {
  it("is described at the length Google requires, however little the profile holds", () => {
    const schema = profilePageSchema(
      profile(
        { githubLogin: null, login: "ab" },
        { activeDays: 1, firstDate: "2026-06-21", lastDate: "2026-06-21", totalTokens: 12 },
      ),
    );
    const dataset = schema.about as { description: string };

    // The stats sentence alone is under Google's 50-character minimum here.
    expect(schema.description).toBe("ab has spent $0.00 across 1 active day and 12 tokens.");
    expect(String(schema.description).length).toBeLessThan(55);
    expect(dataset.description.length).toBeGreaterThanOrEqual(50);
    expect(dataset.description.length).toBeLessThanOrEqual(5_000);
    expect(dataset.description).toContain(String(schema.description));
  });

  it("names the profile's person as its creator", () => {
    const schema = profilePageSchema(
      profile({ githubLogin: "bob", login: "bob" }, { activeDays: 3, totalTokens: 100 }),
    );

    expect(schema.mainEntity).toMatchObject({ "@id": "https://tokenmaxxing.sh/bob#person" });
    expect(schema.about).toMatchObject({
      "@type": "Dataset",
      creator: { "@id": "https://tokenmaxxing.sh/bob#person" },
      name: "bob token usage",
      url: "https://tokenmaxxing.sh/bob",
    });
  });

  it("is left off a profile with no usage", () => {
    expect(profilePageSchema(profile({ githubLogin: null, login: "carol" }))).not.toHaveProperty(
      "about",
    );
  });
});

describe("site schemas", () => {
  it("spell the home page the way its canonical link does", () => {
    const home = "https://tokenmaxxing.sh/";

    expect(organizationSchema().url).toBe(home);
    expect(webSiteSchema().url).toBe(home);
    expect(softwareApplicationSchema().url).toBe(home);
    expect(breadcrumbSchema("bob", "https://tokenmaxxing.sh/bob").itemListElement).toEqual([
      { "@type": "ListItem", item: home, name: "Home", position: 1 },
      { "@type": "ListItem", item: "https://tokenmaxxing.sh/bob", name: "bob", position: 2 },
    ]);
  });

  it("gives the organization a logo and the site the names it goes by", () => {
    expect(organizationSchema().logo).toBe("https://tokenmaxxing.sh/apple-touch-icon.png");
    expect(webSiteSchema()).toMatchObject({
      alternateName: "tokenmaxxing",
      name: "tokenmaxxing.sh",
      publisher: { "@id": organizationSchema()["@id"] },
    });
  });

  it("claims no rating the software has not been given", () => {
    const schema = softwareApplicationSchema();

    expect(schema).not.toHaveProperty("aggregateRating");
    expect(schema).not.toHaveProperty("review");
    expect(schema.offers).toMatchObject({ price: "0", priceCurrency: "USD" });
  });
});

describe("jsonLdScript", () => {
  it("emits JSON a parser reads back unchanged", () => {
    const schema = profilePageSchema(profile({ githubLogin: "Bob", login: "bob-2" }));
    const script = jsonLdScript(schema);

    expect(script.type).toBe("application/ld+json");
    expect(JSON.parse(script.children)).toEqual(schema);
  });

  it("cannot be closed early by a value holding a script end tag", () => {
    const schema = { name: "</script><script>alert(1)</script>" };
    const script = jsonLdScript(schema);

    expect(script.children).not.toContain("<");
    expect(JSON.parse(script.children)).toEqual(schema);
  });
});

function profile(
  user: { githubLogin: string | null; login: string },
  stats: Partial<Profile["stats"]> = {},
): Profile {
  return {
    stats: {
      activeDays: 0,
      avgSpendPerActiveDay: 0,
      currentStreakDays: 0,
      deviceCount: 0,
      firstDate: null,
      lastDate: null,
      leaderboardRank: null,
      longestStreakDays: 0,
      peakDay: null,
      sessionCount: 0,
      sources: [],
      spendUsd: 0,
      topModel: null,
      totalTokens: 0,
      ...stats,
    },
    user: { avatarUrl: null, name: null, ...user },
  };
}
