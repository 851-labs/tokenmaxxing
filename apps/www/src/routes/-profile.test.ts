// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { queryKeys } from "../lib/queries";
import { loadProfile } from "./$user/route";

/**
 * The profile loader over the real derived API client, with the network
 * replaced by `respond` (keyed by request path). The client resolves
 * `globalThis.fetch` once, so the stub stays installed for the whole file and
 * delegates to the current test's `respond`. happy-dom selects the client
 * build (no SSR cookie to forward).
 */

type Respond = (path: string) => Response | Promise<Response>;

const profileBody = {
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
  },
  user: { avatarUrl: null, login: "martinxjonsson", name: null },
};

const dailyBody = { days: [], range: { firstDate: "2026-01-01", lastDate: "2026-09-22" } };

let respond: Respond;

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return respond(decodeURIComponent(url.pathname));
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function userNotFound(login: string): Response {
  return json({ _tag: "UserNotFound", login, message: "User not found." }, 404);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the loader to throw");
}

describe("profile loader", () => {
  it("loads the summary and daily rows for a canonical login", async () => {
    respond = (path) => (path.endsWith("/daily") ? json(dailyBody) : json(profileBody));
    const queryClient = new QueryClient();

    const data = await loadProfile(queryClient, "martinxjonsson");

    expect(data.profile.user.login).toBe("martinxjonsson");
    expect(queryClient.getQueryData(queryKeys.profileDaily("martinxjonsson"))).toEqual(dailyBody);
  });

  it("maps a tagged UserNotFound to not-found and drops the settled daily read", async () => {
    respond = () => userNotFound("ghost");
    const queryClient = new QueryClient();

    expect(isNotFound(await rejection(loadProfile(queryClient, "ghost")))).toBe(true);
    // Left in the cache it would be dehydrated and reject on the client.
    expect(queryClient.getQueryState(queryKeys.profileDaily("ghost"))).toBeUndefined();
  });

  it("maps the router's RouteNotFound 404 (over-long login) to not-found", async () => {
    respond = () => json({ _tag: "RouteNotFound", message: "No such endpoint." }, 404);

    expect(isNotFound(await rejection(loadProfile(new QueryClient(), "a".repeat(101))))).toBe(true);
  });

  it("waits for the daily read to settle before answering a 404", async () => {
    let settleDaily!: () => void;
    const dailySettled = new Promise<void>((resolve) => {
      settleDaily = resolve;
    });
    const requested: string[] = [];
    respond = async (path) => {
      requested.push(path);
      if (path.endsWith("/daily")) {
        await dailySettled;
      }
      return userNotFound("ghost");
    };
    let answered = false;

    const loading = rejection(loadProfile(new QueryClient(), "ghost")).then((error) => {
      answered = true;
      return error;
    });
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toBe(false);

    settleDaily();
    expect(isNotFound(await loading)).toBe(true);
  });

  it("redirects a differently-cased login to the canonical profile URL", async () => {
    respond = (path) => (path.endsWith("/daily") ? json(dailyBody) : json(profileBody));

    const error = await rejection(loadProfile(new QueryClient(), "MartinXJonsson"));

    expect(isRedirect(error)).toBe(true);
    expect(isRedirect(error) && error.options).toMatchObject({
      params: { user: "martinxjonsson" },
      statusCode: 301,
      to: "/$user",
    });
  });

  it("rethrows other failures for the error boundary", async () => {
    respond = () => json({ _tag: "InternalServerError", message: "Something went wrong." }, 500);

    const error = await rejection(loadProfile(new QueryClient(), "martinxjonsson"));

    expect(isNotFound(error)).toBe(false);
    expect(isRedirect(error)).toBe(false);
  });
});
