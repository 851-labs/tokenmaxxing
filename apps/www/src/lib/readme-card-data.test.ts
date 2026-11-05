import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { loadReadmeCardData } from "./readme-card-data";

const NOW = new Date("2026-06-21T12:00:00Z");
const AVATAR_URL = "https://avatars.githubusercontent.com/u/1?v=4";

describe("loadReadmeCardData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the 30 UTC days ending today, grouped by model", async () => {
    const fetch = stubApi({});

    const data = await loadReadmeCardData("pondorasti", NOW);

    const dailyUrl = fetch.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes("/daily"));
    expect(dailyUrl).toMatch(/\/profiles\/pondorasti\/daily\?groupBy=model&since=2026-05-23$/);
    expect(data?.daily.range.lastDate).toBe("2026-06-21");
    expect(data?.profile.user.login).toBe("pondorasti");
  });

  it("resolves null when the profile is unknown or hidden", async () => {
    stubApi({ profileStatus: 404 });

    await expect(loadReadmeCardData("ghost", NOW)).resolves.toBeNull();
  });

  it("still returns the card data when the avatar can't be fetched", async () => {
    stubApi({ avatar: new Response("down", { status: 503 }) });

    const data = await loadReadmeCardData("pondorasti", NOW);

    expect(data).not.toBeNull();
    expect(data?.avatarDataUri).toBeNull();
  });

  it("embeds a fetched avatar as a data URI", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    stubApi({ avatar: new Response(png, { headers: { "content-type": "image/png" } }) });

    const data = await loadReadmeCardData("pondorasti", NOW);

    expect(data?.avatarDataUri).toMatch(/^data:image\/png;base64,/);
  });
});

function stubApi({ avatar, profileStatus = 200 }: { avatar?: Response; profileStatus?: number }) {
  const fetch = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://avatars.githubusercontent.com/")) {
      return avatar ?? new Response("missing", { status: 404 });
    }
    if (url.includes("/daily")) {
      return Response.json({
        days: [
          {
            date: "2026-06-21",
            key: "claude-opus-5-5",
            outputTokens: 1,
            spendUsd: 2,
            totalTokens: 3,
          },
        ],
        range: { firstDate: "2026-05-23", lastDate: "2026-06-21" },
      });
    }
    return profileStatus === 200
      ? Response.json(profileBody())
      : new Response("missing", { status: profileStatus });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function profileBody() {
  return {
    stats: {
      activeDays: 1,
      avgSpendPerActiveDay: 2,
      currentStreakDays: 1,
      deviceCount: 1,
      firstDate: "2026-06-21",
      lastDate: "2026-06-21",
      leaderboardRank: 3,
      longestStreakDays: 1,
      peakDay: { date: "2026-06-21", spendUsd: 2 },
      sessionCount: 4,
      sources: ["claude"],
      spendUsd: 2,
      topModel: { model: "claude-opus-5-5", spendUsd: 2 },
      totalTokens: 3,
    },
    user: { avatarUrl: AVATAR_URL, login: "pondorasti", name: null },
  };
}
