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
import { readmeCardPath, readmeCardSnippet } from "../lib/readme-card-embed";
import { CARD_CACHE_CONTROL, makeReadmeCardHandler } from "./card/{$login}[.]svg";

type Daily = typeof ProfileDailyResponse.Type;
type Profile = typeof ProfileResponse.Type;

describe("README card renderer", () => {
  it("renders the profile stats, rank and chart legend", () => {
    const svg = renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "auto" });

    expect(svg).toContain("pondorasti");
    expect(svg).toContain("$1,235");
    expect(svg).toContain("1.23B");
    expect(svg).toContain("Leaderboard #7");
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

  it("embeds fonts only when given", () => {
    const fonts = { regular: "data:font/woff2;base64,AA", semibold: "data:font/woff2;base64,BB" };

    expect(
      renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" }),
    ).not.toContain("@font-face");
    expect(
      renderReadmeCard(cardData(), { hideSpend: false, layout: "full", theme: "dark" }, fonts),
    ).toContain("url(data:font/woff2;base64,BB)");
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
    expect(compact).toContain(">#7</tspan>");
    expect(compact).not.toContain("Leaderboard");
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

describe("README card route", () => {
  it("serves a cacheable svg", async () => {
    const response = await requestCard(async () => cardData());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(CARD_CACHE_CONTROL);
    expect(await response.text()).toContain("<svg");
  });

  it("serves a placeholder card with 200 for missing profiles", async () => {
    const response = await requestCard(async () => null);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No public profile");
  });

  it("serves a short-lived placeholder card when the API fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await requestCard(async () => {
      throw new Error("api down");
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.text()).toContain("temporarily unavailable");
    warn.mockRestore();
  });
});

async function requestCard(load: () => Promise<ReadmeCardData | null>): Promise<Response> {
  const handler = makeReadmeCardHandler({ fonts: null, loadReadmeCardData: vi.fn(load) });
  return handler({
    params: { login: "pondorasti" },
    request: new Request("https://tokenmaxxing.sh/card/pondorasti.svg"),
  });
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
    user: { avatarUrl: null, login: "pondorasti", name: null },
  };
}
