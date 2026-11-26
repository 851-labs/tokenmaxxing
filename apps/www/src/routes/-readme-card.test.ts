import { describe, expect, it, vi } from "vite-plus/test";
import type { ProfileDailyResponse, ProfileResponse } from "@tokenmaxxing/api-contract";

import { OTHER_MODEL_SERIES } from "../components/charts/model-colors";
import {
  modelChart,
  parseReadmeCardOptions,
  renderReadmeCard,
  renderReadmeCardPlaceholder,
} from "../lib/readme-card";
import type { ReadmeCardData } from "../lib/readme-card";
import type { LoadedReadmeCard } from "../lib/readme-card-data";
import { readmeCardPath, readmeCardSnippet } from "../lib/readme-card-embed";
import { estimateTextWidth } from "../lib/text-width";
import { CARD_CACHE_CONTROL, makeReadmeCardHandler } from "./card/{$login}[.]svg";
import type { ReadmeCardCache, ReadmeCardRouteDeps } from "./card/{$login}[.]svg";

type Daily = typeof ProfileDailyResponse.Type;
type Profile = typeof ProfileResponse.Type;

describe("README card renderer", () => {
  it("renders the profile stats, rank and chart legend", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "auto" });

    expect(svg).toContain("pondorasti");
    expect(svg).toContain("$1,235");
    expect(svg).toContain("1.23B");
    // The rank is the 30-day leaderboard's, and says so next to all-time stats.
    expect(svg).toContain("Rank #7 · 30d");
    expect(svg).toContain("claude-opus-5-5");
    expect(svg).toContain("prefers-color-scheme: dark");
  });

  it("escapes user-controlled text", () => {
    const data = cardData();
    data.profile = profile({ topModel: { model: '<b>"x"', spendUsd: 1 } });

    const svg = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "light" });

    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;&quot;x&quot;");
  });

  it("swaps spend for sessions and charts tokens when spend is hidden", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: true, layout: "full", theme: "dark" });

    expect(svg).not.toContain("Spend");
    expect(svg).not.toContain("$");
    expect(svg).toContain("Sessions");
    expect(svg).toContain(">1.3M<");
  });

  it("uses system fonts and loads nothing from outside the image", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" });

    expect(svg).not.toContain("@font-face");
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg).toContain("font-family:-apple-system");
    // Small enough to embed many times over: the stats, not a font file.
    expect(svg.length).toBeLessThan(15_000);
  });

  it("parses query options and ignores unknown values", () => {
    expect(
      parseReadmeCardOptions(new URLSearchParams("theme=dark&hide=bogus,spend&layout=compact")),
    ).toEqual({ hideSpend: true, layout: "compact", theme: "dark" });
    expect(parseReadmeCardOptions(new URLSearchParams("theme=neon&layout=tiny"))).toEqual({
      hideSpend: false,
      layout: "full",
      theme: "auto",
    });
  });

  it("keeps the compact card to one stats row, a legend and no date ticks", () => {
    const full = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" });
    const compact = renderReadmeCard(cardData(), {
      hideSpend: false,
      layout: "compact",
      theme: "dark",
    });
    const height = (svg: string) => Number(/height="(\d+(?:\.\d+)?)" viewBox/.exec(svg)?.[1]);

    expect(height(compact)).toBeLessThan(height(full) * 0.6);
    expect(compact).toContain("Streak");
    expect(compact).not.toContain("Longest streak");
    expect(compact).not.toContain("Top spend model");
    expect(compact).toContain("<circle");
    expect(compact).not.toContain("Jun 21<");
    expect(full).toContain("Jun 21<");
    expect(compact).toContain("All-time spend");
    expect(compact).toContain(">#7 · 30d</tspan>");
    expect(compact).not.toContain("Rank #7");
  });

  it("stacks the top models and folds the rest into Other", () => {
    const models = ["a", "b", "c", "d", "e", "f"];
    const chart = modelChart(
      {
        days: models.map((model, index) => row("2026-06-21", model, 60 - index * 10)),
        range: { firstDate: "2026-05-23", lastDate: "2026-06-21" },
      },
      "spend",
    );

    expect(chart.series.map((series) => series.model)).toEqual([
      "a",
      "b",
      "c",
      "d",
      OTHER_MODEL_SERIES,
    ]);
    expect(chart.series.at(-1)?.total).toBe(30);
    expect(chart.days.at(-1)?.get(OTHER_MODEL_SERIES)).toBe(30);
    expect(chart.days).toHaveLength(30);
  });

  it("charts exactly the 30 days ending on the range's last date", () => {
    const chart = modelChart(
      {
        days: [row("2026-05-22", "too-old", 999), row("2026-05-23", "first", 1)],
        range: { firstDate: "2026-05-01", lastDate: "2026-06-21" },
      },
      "spend",
    );

    expect(chart.dates[0]).toBe("2026-05-23");
    expect(chart.dates.at(-1)).toBe("2026-06-21");
    expect(chart.series.map((series) => series.model)).toEqual(["first"]);
  });

  it("says so instead of charting when there was no usage", () => {
    const data = cardData();
    data.daily = { days: [], range: { firstDate: "2026-05-23", lastDate: "2026-06-21" } };

    const svg = renderReadmeCard(data, { hideSpend: false, layout: "compact", theme: "dark" });

    expect(svg).toContain("No usage<");
    expect(svg).toContain("No usage in the last 30 days");
    expect(svg).not.toContain("NaN");
  });

  it("keeps the peak day's stack inside the plot, however many tiny models it has", () => {
    const data = cardData();
    // One model fills the plot; four more are far too small to show at scale.
    data.daily = {
      ...data.daily,
      days: [
        row("2026-06-21", "big", 1_000),
        ...["a", "b", "c", "d"].map((model) => row("2026-06-21", model, 0.001)),
      ],
    };

    const svg = renderReadmeCard(data, { hideSpend: false, layout: "compact", theme: "dark" });
    const track = /<rect class="track"[^>]* y="([\d.]+)"/.exec(svg);
    const plotTop = Number(track?.[1]);
    const barTops = [
      ...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="[\d.]+" fill=/g),
    ].map((match) => Number(match[1]));

    expect(barTops.length).toBeGreaterThan(0);
    expect(Math.min(...barTops)).toBeGreaterThanOrEqual(plotTop);
  });

  it("lists a short model after one too long for the legend", () => {
    const data = cardData();
    data.daily = {
      ...data.daily,
      days: [
        row("2026-06-21", "a-model-name-that-is-long", 30),
        row("2026-06-21", "b-model-name-that-is-long", 20),
        row("2026-06-21", "c-model-name-that-is-long", 10),
      ],
    };
    const three = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "dark" });
    data.daily = {
      ...data.daily,
      days: [...data.daily.days.slice(0, 2), row("2026-06-21", "tiny", 10)],
    };
    const withShort = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "dark" });

    // Three long names don't all fit; a short third one does.
    expect(three.match(/<circle/g)).toHaveLength(2);
    expect(withShort.match(/<circle/g)).toHaveLength(3);
    expect(withShort).toContain(">tiny<");
  });

  it("drops legend entries that would run past the card's edge", () => {
    const data = cardData();
    data.daily = {
      ...data.daily,
      days: ["a", "b", "c"].map((letter, index) =>
        row("2026-06-21", `${letter}-very-long-model-name-xyz`, 30 - index),
      ),
    };

    const svg = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "dark" });

    expect(svg.match(/<circle/g)).toHaveLength(2);
  });

  it("sets a long login smaller, then cuts it, before it reaches the brand or the rank", () => {
    const data = cardData();
    data.profile = { ...data.profile, user: { ...data.profile.user, login: "W".repeat(39) } };
    const fitted = (layout: "compact" | "full") => {
      const svg = renderReadmeCard(data, { hideSpend: false, layout, theme: "dark" });
      const match = /font-size="([\d.]+)" font-weight="600">(W+…)</.exec(svg);
      return { size: Number(match?.[1]), text: match?.[2] ?? "" };
    };
    const full = fitted("full");
    const compact = fitted("compact");

    expect(full.size).toBe(14);
    expect(compact.size).toBe(11);
    // Full: avatar to x=72, then the login, a gap and the brand, which ends at x=580.
    expect(72 + estimateTextWidth(full.text, full.size)).toBeLessThanOrEqual(
      580 - estimateTextWidth("tokenmaxxing.sh", 14) - 16,
    );
    // Compact: the rank follows the login on the same line, before the brand.
    expect(51 + estimateTextWidth(compact.text, compact.size)).toBeLessThanOrEqual(
      580 - estimateTextWidth("tokenmaxxing.sh", 11) - 16 - 6 - estimateTextWidth("#7 · 30d", 15),
    );
  });

  it("leaves an ordinary login at full size", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" });

    expect(svg).toContain('font-size="20" font-weight="600">pondorasti<');
  });

  it("sets a long top model smaller instead of cutting it, and cuts one that is far too long", () => {
    const data = cardData();
    data.profile = profile({ topModel: { model: "claude-sonnet-5-5", spendUsd: 1 } });
    const shrunk = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "dark" });
    data.profile = profile({ topModel: { model: "m".repeat(200), spendUsd: 1 } });
    const cut = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "dark" });

    const size = Number(/font-size="([\d.]+)"[^>]*>claude-sonnet-5-5</.exec(shrunk)?.[1]);
    expect(size).toBeLessThan(20);
    expect(size).toBeGreaterThanOrEqual(13);
    const [, cutSize, cutText] = /font-size="([\d.]+)"[^>]*>(m+…)</.exec(cut) ?? [];
    expect(Number(cutSize)).toBe(13);
    // The model's cell is the last of three columns: 160px between its paddings.
    expect(estimateTextWidth(cutText ?? "", 13)).toBeLessThanOrEqual(160);
    expect(estimateTextWidth(cutText ?? "", 13)).toBeGreaterThan(140);
  });

  it("ends the newest day's label at the plot's edge, inside the padding", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" });

    expect(svg).toMatch(/<text class="muted" x="580" text-anchor="end"[^>]*>Jun 21</);
    expect(svg).toMatch(/<text class="muted" x="[\d.]+" text-anchor="middle"[^>]*>Jun 14</);
  });

  it("widens the axis gutter for labels the default one can't hold", () => {
    const axis = (spendUsd: number) => {
      const data = cardData();
      data.daily = { ...data.daily, days: [row("2026-06-21", "claude-opus-5-5", spendUsd)] };
      const svg = renderReadmeCard(data, { hideSpend: false, layout: "full", theme: "dark" });
      const labels = [
        ...svg.matchAll(/x="([\d.]+)" y="[\d.]+" font-size="9.5" text-anchor="end">([^<]+)</g),
      ].map((match) => ({ right: Number(match[1]), text: match[2] ?? "" }));
      return { labels, plotLeft: Number(/<rect class="track" x="([\d.]+)"/.exec(svg)?.[1]) };
    };
    const usual = axis(40);
    const wide = axis(150_000);

    expect(usual.plotLeft).toBe(66);
    expect(wide.labels.map((label) => label.text)).toEqual(["$0", "$100,000", "$200,000"]);
    expect(wide.plotLeft).toBeGreaterThan(usual.plotLeft);
    for (const label of wide.labels) {
      expect(label.right - estimateTextWidth(label.text, 9.5)).toBeGreaterThanOrEqual(20);
    }
  });

  it("labels the value axis and summarises total, average and peak", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" });

    expect(svg).toContain(">$0<");
    expect(svg).toContain(">$50.00<");
    expect(svg).toContain('>$50.00</tspan><tspan class="muted" dx="4">total');
    expect(svg).toContain('>$25.00</tspan><tspan class="muted" dx="4">avg/active day');
    expect(svg).toContain('>$40.00</tspan><tspan class="muted" dx="4">peak');
  });
});

describe("README card embed", () => {
  it("only puts non-default options in the card URL", () => {
    expect(readmeCardPath("pondorasti", { hideSpend: false, layout: "full", theme: "auto" })).toBe(
      "/card/pondorasti.svg",
    );
    expect(
      readmeCardPath("pondorasti", { hideSpend: true, layout: "compact", theme: "dark" }),
    ).toBe("/card/pondorasti.svg?theme=dark&hide=spend&layout=compact");
  });

  it("round-trips the URL options through the route's parser", () => {
    const options = { hideSpend: true, layout: "compact", theme: "light" } as const;
    const url = new URL(readmeCardPath("pondorasti", options), "https://tokenmaxxing.sh");

    expect(parseReadmeCardOptions(url.searchParams)).toEqual(options);
  });

  it("links the absolute card URL to the profile in both formats", () => {
    const options = { hideSpend: false, layout: "full", theme: "dark" } as const;

    expect(readmeCardSnippet("pondorasti", options, "markdown")).toBe(
      "[![pondorasti's tokenmaxxing stats](https://tokenmaxxing.sh/card/pondorasti.svg?theme=dark)](https://tokenmaxxing.sh/pondorasti)",
    );
    expect(readmeCardSnippet("pondorasti", options, "html")).toBe(
      `<a href="https://tokenmaxxing.sh/pondorasti"><img src="https://tokenmaxxing.sh/card/pondorasti.svg?theme=dark" alt="pondorasti's tokenmaxxing stats" width="600"></a>`,
    );
  });

  it("follows GitHub's theme in the HTML snippet when the theme is auto", () => {
    const options = { hideSpend: false, layout: "compact", theme: "auto" } as const;
    const html = readmeCardSnippet("pondorasti", options, "html");

    // GitHub resolves prefers-color-scheme in <picture> against its own theme setting.
    expect(html).toContain(
      `<source media="(prefers-color-scheme: dark)" srcset="https://tokenmaxxing.sh/card/pondorasti.svg?theme=dark&layout=compact">`,
    );
    expect(html).toContain(
      `<img src="https://tokenmaxxing.sh/card/pondorasti.svg?theme=light&layout=compact" alt="pondorasti's tokenmaxxing stats" width="600">`,
    );
    // Markdown has no <picture>: one image, whose own auto theme follows the system.
    expect(readmeCardSnippet("pondorasti", options, "markdown")).toBe(
      "[![pondorasti's tokenmaxxing stats](https://tokenmaxxing.sh/card/pondorasti.svg?layout=compact)](https://tokenmaxxing.sh/pondorasti)",
    );
  });
});

describe("README card placeholder", () => {
  it("follows the requested theme and explains why there is no card", () => {
    const missing = renderReadmeCardPlaceholder("ghost", "dark", "missing");
    const unavailable = renderReadmeCardPlaceholder("ghost", "light", "unavailable");

    expect(missing).toContain(".bg{fill:#0c0d11}");
    expect(missing).not.toContain("prefers-color-scheme");
    expect(missing).toContain("No public profile");
    expect(unavailable).toContain(".bg{fill:#fcfcfa}");
    expect(unavailable).toContain("temporarily unavailable");
  });
});

describe("README card placeholder text", () => {
  it("echoes only what could be a login, so the card can't carry arbitrary text", () => {
    for (const login of ["visit evil.example now", "<script>alert(1)</script>", "a\u0000b", ""]) {
      const svg = renderReadmeCardPlaceholder(login, "light", "missing");

      expect(svg).toContain("No public profile");
      expect(svg.match(/<text/g)).toHaveLength(2);
      expect(svg).not.toContain("evil");
      expect(svg).not.toContain("script");
      expect(svg).not.toContain("\u0000");
    }
    expect(renderReadmeCardPlaceholder("some_user-2", "light", "missing")).toContain(
      ">some_user-2<",
    );
  });

  it("fits a long login beside the brand", () => {
    const svg = renderReadmeCardPlaceholder("W".repeat(64), "light", "missing");
    const [, size, text] = /font-size="([\d.]+)" font-weight="600">(W+…)</.exec(svg) ?? [];

    expect(20 + estimateTextWidth(text ?? "", Number(size))).toBeLessThanOrEqual(
      580 - estimateTextWidth("tokenmaxxing.sh", 14) - 16,
    );
  });
});

describe("README card route", () => {
  it("serves a cacheable svg that nothing may frame", async () => {
    const { response } = await requestCard();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(CARD_CACHE_CONTROL);
    // Its own policy replaces the site-wide one, so it must deny framing itself.
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain("<svg");
  });

  it("serves a placeholder card with 200 for missing profiles", async () => {
    const { loadCard, response } = await requestCard({ loadIdentity: async () => null });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("No public profile");
    expect(loadCard).not.toHaveBeenCalled();
  });

  it("serves a short-lived placeholder card when the API fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const identityDown = await requestCard({
      loadIdentity: async () => {
        throw new Error("api down");
      },
    });
    const statsDown = await requestCard({
      loadCard: async () => {
        throw new Error("api down");
      },
    });

    for (const { response } of [identityDown, statsDown]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
      expect(await response.text()).toContain("temporarily unavailable");
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("checks visibility before the cache, so a hidden profile's cached card is not served", async () => {
    const cache = memoryCache();
    const first = await requestCard({ cache: () => cache });
    expect(await first.response.text()).toContain("pondorasti");
    expect(cache.entries.size).toBe(1);

    // Shadow-banned since: the identity read now answers 404.
    const hidden = await requestCard({ cache: () => cache, loadIdentity: async () => null });

    expect(await hidden.response.text()).toContain("No public profile");
    expect(hidden.loadCard).not.toHaveBeenCalled();
  });

  it("answers from the cache without re-reading stats, one entry per card variant", async () => {
    const cache = memoryCache();
    await requestCard({ cache: () => cache });

    // Same card through other spellings: case, parameter order, junk parameters.
    const again = await requestCard(
      { cache: () => cache },
      "https://tokenmaxxing.sh/card/PONDORASTI.svg?utm=x&layout=full",
    );
    expect(again.loadCard).not.toHaveBeenCalled();
    expect(await again.response.text()).toContain("<svg");
    expect(cache.entries.size).toBe(1);

    const compact = await requestCard(
      { cache: () => cache },
      "https://tokenmaxxing.sh/card/pondorasti.svg?layout=compact",
    );
    expect(compact.loadCard).toHaveBeenCalledTimes(1);
    expect(cache.entries.size).toBe(2);
  });

  it("serves the current profile's card under an old login, without a redirect", async () => {
    const cache = memoryCache();
    // The API resolves an old login (a renamed user) to the current identity.
    const { loadCard, response } = await requestCard(
      { cache: () => cache },
      "https://tokenmaxxing.sh/card/old-name.svg",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("pondorasti");
    expect(loadCard).toHaveBeenCalledWith({ avatarUrl: null, login: "pondorasti" });
    expect([...cache.entries.keys()][0]).toContain("/card/pondorasti.svg");
  });

  it("caches a card whose avatar failed only briefly", async () => {
    const { response } = await requestCard({
      loadCard: async () => ({ avatarFailed: true, data: cardData() }),
    });

    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.text()).toContain("pondorasti");
  });

  it("answers with a placeholder when the profile is hidden between the two reads", async () => {
    const { response } = await requestCard({ loadCard: async () => null });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No public profile");
  });
});

async function requestCard(
  overrides: Partial<ReadmeCardRouteDeps> = {},
  url = "https://tokenmaxxing.sh/card/pondorasti.svg",
) {
  const loadCard = vi.fn(
    overrides.loadCard ??
      (async (): Promise<LoadedReadmeCard | null> => ({ avatarFailed: false, data: cardData() })),
  );
  const handler = makeReadmeCardHandler({
    cache: () => null,
    loadIdentity: async () => ({ avatarUrl: null, login: "pondorasti" }),
    ...overrides,
    loadCard,
  });
  const response = await handler({
    params: { login: new URL(url).pathname.slice("/card/".length, -".svg".length) },
    request: new Request(url),
  });

  return { loadCard, response };
}

function memoryCache(): ReadmeCardCache & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();

  return {
    entries,
    match: async (request) => entries.get(request.url)?.clone(),
    put: async (request, response) => {
      entries.set(request.url, response);
    },
  };
}

function cardData(): ReadmeCardData {
  return {
    avatarDataUri: null,
    daily: {
      days: [
        row("2026-06-20", "claude-opus-5-5", 40, 400_000),
        row("2026-06-21", "gpt-6-astra", 10, 900_000),
      ],
      range: { firstDate: "2026-05-23", lastDate: "2026-06-21" },
    },
    profile: profile(),
  };
}

function row(date: string, key: string, spendUsd: number, totalTokens = 0): Daily["days"][number] {
  return { date, key, outputTokens: 0, spendUsd, totalTokens };
}

function profile(overrides: Partial<Profile["stats"]> = {}): Profile {
  return {
    stats: {
      activeDays: 42,
      avgSpendPerActiveDay: 29.4,
      currentStreakDays: 3,
      deviceCount: 2,
      firstDate: "2026-01-02",
      lastDate: "2026-06-21",
      leaderboardRank: 7,
      longestStreakDays: 9,
      peakDay: null,
      sessionCount: 120,
      sources: ["claude"],
      spendUsd: 1_234.56,
      topModel: { model: "claude-opus-5-5", spendUsd: 900 },
      totalTokens: 1_234_567_890,
      ...overrides,
    },
    user: { avatarUrl: null, githubLogin: "pondorasti", login: "pondorasti", name: null },
  };
}
