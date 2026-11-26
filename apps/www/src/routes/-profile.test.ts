// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { LOGIN_REDIRECT_CACHE_CONTROL } from "../lib/login-redirect";
import { queryKeys } from "../lib/queries";
import { loadProfile, ProfileGithubLink, ProfileShareButton } from "./$user/route";

/**
 * The profile loader over the real derived API client, with the network
 * replaced by `respond` (keyed by request path). The client resolves
 * `globalThis.fetch` once, so the stub stays installed for the whole file and
 * delegates to the current test's `respond`. happy-dom selects the client
 * build (no SSR cookie to forward).
 */

type Respond = (path: string, search: string) => Response | Promise<Response>;

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
  user: { avatarUrl: null, githubLogin: "martinxjonsson", login: "martinxjonsson", name: null },
};

const dailyBody = { days: [], range: { firstDate: "2026-01-01", lastDate: "2026-09-22" } };

let respond: Respond;

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return respond(decodeURIComponent(url.pathname), url.search);
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

  it("keeps the filters across the canonical-login redirect", async () => {
    respond = (path) => (path.endsWith("/daily") ? json(dailyBody) : json(profileBody));

    const error = await rejection(
      loadProfile(new QueryClient(), "MartinXJonsson", { agent: "opencode", range: "6m" }),
    );

    expect(isRedirect(error) && error.options).toMatchObject({
      params: { user: "martinxjonsson" },
      search: { agent: "opencode", range: "6m" },
      statusCode: 301,
    });
  });

  it("reads the daily rows once, grouped by agent and model", async () => {
    const requested: string[] = [];
    respond = (path, search) => {
      if (path.endsWith("/daily")) {
        requested.push(search);
        return json(dailyBody);
      }
      return json(profileBody);
    };

    await loadProfile(new QueryClient(), "martinxjonsson", { agent: "opencode", range: "6m" });

    // The filters never reach the API: they are applied in the browser.
    expect(requested).toEqual(["?groupBy=sourceModel"]);
  });

  it("redirects an old login (a renamed user) to the current profile URL", async () => {
    respond = (path) => (path.endsWith("/daily") ? json(dailyBody) : json(profileBody));

    const error = await rejection(loadProfile(new QueryClient(), "martin-old"));

    expect(isRedirect(error)).toBe(true);
    expect(isRedirect(error) && error.options).toMatchObject({
      params: { user: "martinxjonsson" },
      statusCode: 301,
      to: "/$user",
    });
    // Revalidated on every use: the user may take the old login back.
    expect(isRedirect(error) && error.headers.get("cache-control")).toBe("no-cache");
    expect(LOGIN_REDIRECT_CACHE_CONTROL).toBe("no-cache");
  });

  it("rethrows other failures for the error boundary", async () => {
    respond = () => json({ _tag: "InternalServerError", message: "Something went wrong." }, 500);

    const error = await rejection(loadProfile(new QueryClient(), "martinxjonsson"));

    expect(isNotFound(error)).toBe(false);
    expect(isRedirect(error)).toBe(false);
  });
});

describe("profile GitHub link", () => {
  function render(githubLogin: string | null): HTMLElement {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement(ProfileGithubLink, { githubLogin }));

    return container;
  }

  it("opens the stored GitHub account in a new tab, named for screen readers", () => {
    // The profile login can be "bob-2" while the GitHub account is "Bob".
    const link = render("Bob").querySelector("a");

    expect(link?.getAttribute("href")).toBe("https://github.com/Bob");
    expect(link?.getAttribute("aria-label")).toBe("Bob on GitHub");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    // Icon only: the accessible name is the label, the logo is decorative.
    expect(link?.textContent).toBe("");
    expect(link?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // The solid GitHub mark, in the button's text colour.
    expect(link?.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  });

  it("renders nothing for a profile without a GitHub account", () => {
    expect(render(null).innerHTML).toBe("");
  });
});

describe("profile share button", () => {
  it("copies the link and confirms it in the name, the label and the icon", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const writeText = vi.fn(async (_text: string) => {});
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      const url = "https://tokenmaxxing.sh/bob-2";
      await act(async () => root.render(createElement(ProfileShareButton, { url })));
      const button = container.querySelector("button");

      // The label stays in the DOM: narrow screens hide it visually, so the
      // name and the text are there for every width.
      expect(button?.getAttribute("aria-label")).toBe("Share profile");
      expect(button?.textContent).toBe("Share");
      expect(button?.querySelectorAll("svg")).toHaveLength(1);

      await act(async () => button?.click());

      expect(writeText).toHaveBeenCalledWith(url);
      expect(button?.getAttribute("aria-label")).toBe("Profile link copied");
      expect(button?.textContent).toBe("Copied");
      // The check that stands in for the label on narrow screens, beside the
      // link icon that wide screens keep.
      expect(button?.querySelectorAll("svg")).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      container.remove();
      if (clipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboard);
      }
    }
  });
});
