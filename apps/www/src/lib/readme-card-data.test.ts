import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { loadReadmeCardData } from "./readme-card-data";

const NOW = new Date("2026-06-21T12:00:00Z");
const AVATAR_URL = "https://avatars.githubusercontent.com/u/1?v=4";

const IDENTITY = { avatarUrl: AVATAR_URL, login: "pondorasti" };

describe("loadReadmeCardData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the 30 UTC days ending today, grouped by model", async () => {
    const fetch = stubApi({});

    const card = await loadReadmeCardData(IDENTITY, { now: NOW });

    const dailyUrl = fetch.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes("/daily"));
    expect(dailyUrl).toMatch(/\/profiles\/pondorasti\/daily\?groupBy=model&since=2026-05-23$/);
    expect(card?.data.daily.range.lastDate).toBe("2026-06-21");
    expect(card?.data.profile.user.login).toBe("pondorasti");
  });

  it("resolves null when the profile is unknown or hidden", async () => {
    stubApi({ profileStatus: 404 });

    await expect(
      loadReadmeCardData({ avatarUrl: null, login: "ghost" }, { now: NOW }),
    ).resolves.toBeNull();
  });

  it("rejects when the API fails, so the route can answer with a short-lived placeholder", async () => {
    stubApi({ profileStatus: 500 });

    await expect(loadReadmeCardData(IDENTITY, { now: NOW })).rejects.toThrow();
  });

  it("still returns the card, flagged, when the avatar can't be fetched", async () => {
    stubApi({ avatar: new Response("down", { status: 503 }) });

    const card = await loadReadmeCardData(IDENTITY, { now: NOW });

    expect(card?.data.avatarDataUri).toBeNull();
    expect(card?.avatarFailed).toBe(true);
  });

  it("does not flag a profile with no avatar, or one on a host it won't fetch", async () => {
    const fetch = stubApi({});

    const none = await loadReadmeCardData({ avatarUrl: null, login: "pondorasti" }, { now: NOW });
    const rejected = await loadReadmeCardData(
      { avatarUrl: "https://evil.example/a.png", login: "pondorasti" },
      { now: NOW },
    );

    expect(none).toMatchObject({ avatarFailed: false, data: { avatarDataUri: null } });
    expect(rejected).toMatchObject({ avatarFailed: false, data: { avatarDataUri: null } });
    expect(fetch.mock.calls.map(([url]) => String(url)).some((url) => url.includes("evil"))).toBe(
      false,
    );
  });

  it("embeds a fetched avatar as a data URI", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    stubApi({ avatar: new Response(png, { headers: { "content-type": "image/png" } }) });

    const card = await loadReadmeCardData(IDENTITY, { now: NOW });

    expect(card?.data.avatarDataUri).toMatch(/^data:image\/png;base64,/);
    expect(card?.avatarFailed).toBe(false);
  });

  it("starts the avatar fetch alongside the API reads, not after them", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      started.push(
        url.includes("/daily") ? "daily" : url.includes("avatars") ? "avatar" : "profile",
      );
      await gate;
      if (url.includes("avatars")) {
        return new Response("missing", { status: 404 });
      }
      return url.includes("/daily")
        ? Response.json({ days: [], range: { firstDate: "2026-05-23", lastDate: "2026-06-21" } })
        : Response.json(profileBody());
    });

    const loading = loadReadmeCardData(IDENTITY, { now: NOW });
    await Promise.resolve();

    expect(started.toSorted()).toEqual(["avatar", "daily", "profile"]);
    release();
    await loading;
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
    user: { avatarUrl: AVATAR_URL, githubLogin: "pondorasti", login: "pondorasti", name: null },
  };
}
