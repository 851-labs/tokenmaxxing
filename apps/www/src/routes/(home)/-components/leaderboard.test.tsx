// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { LeaderboardEntry, LeaderboardResponse } from "@tokenmaxxing/api-contract";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchViewer, runApi } from "../../../lib/api";
import { Leaderboard } from "./leaderboard";

vi.mock("../../../lib/api", () => ({ fetchViewer: vi.fn(), runApi: vi.fn() }));

interface ListCall {
  query: { metric: string; offset?: number; window: string };
}

function entry(rank: number, login: string): LeaderboardEntry {
  return {
    activeDays: 1,
    lastDate: "2026-11-14",
    rank,
    spendUsd: 100 - rank,
    totalTokens: 1_000 - rank,
    user: { avatarUrl: null, login, name: null },
  };
}

/** Pages by offset; tests replace it to fail or shift rows. */
let pages: Record<number, LeaderboardResponse | Error>;
const list = vi.fn(async ({ query }: ListCall) => {
  const page = pages[query.offset ?? 0];
  if (page === undefined || page instanceof Error) {
    throw page ?? new Error(`no page at ${query.offset}`);
  }
  return page;
});

let container: HTMLElement;
let root: Root;

let scrolled: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  list.mockClear();
  vi.mocked(fetchViewer).mockResolvedValue(null);
  scrolled = [];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
    this: HTMLElement,
  ) {
    scrolled.push(this.dataset["login"] ?? "");
  });
  vi.mocked(runApi).mockImplementation(
    async (call) => call({ leaderboard: { list } } as never) as never,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("Leaderboard", () => {
  it("appends the next page with continuous ranks under the same filters", async () => {
    pages = {
      0: page([entry(1, "alice"), entry(2, "bob")], 2),
      2: page([entry(3, "carol")], null),
    };
    await render();

    expect(ranks()).toEqual([
      ["1", "alice"],
      ["2", "bob"],
    ]);

    await clickLoadMore();

    expect(ranks()).toEqual([
      ["1", "alice"],
      ["2", "bob"],
      ["3", "carol"],
    ]);
    expect(list.mock.calls.map(([call]) => call.query)).toEqual([
      { metric: "tokens", window: "7d" },
      { metric: "tokens", offset: 2, window: "7d" },
    ]);
    expect(loadMoreButton()).toBeUndefined();
  });

  it("counts loaded rows against the ranked total, and keeps the count on the last page", async () => {
    pages = {
      0: page([entry(1, "alice"), entry(2, "bob")], 2, { total: 3 }),
      2: page([entry(3, "carol")], null, { total: 3 }),
    };
    await render();

    expect(progress()).toBe("Showing 1–2 of 3");

    await clickLoadMore();

    expect(progress()).toBe("Showing 1–3 of 3");
    expect(loadMoreButton()).toBeUndefined();
  });

  it("shows no button when the first page is the last", async () => {
    pages = { 0: page([entry(1, "alice")], null) };
    await render();

    expect(ranks()).toHaveLength(1);
    expect(loadMoreButton()).toBeUndefined();
  });

  it("treats a response without nextOffset or total as the last page of unknown size", async () => {
    const {
      nextOffset: _,
      total: __,
      viewerRank: ___,
      ...legacy
    } = page([entry(1, "alice")], null);
    pages = { 0: legacy };
    await render();

    expect(loadMoreButton()).toBeUndefined();
    expect(progress()).toBe("Showing 1–1");
  });

  it("offers no footer on an empty board", async () => {
    pages = { 0: page([], null, { total: 0 }) };
    await render();

    expect(progress()).toBeUndefined();
  });

  it("hides Find me when signed out or unranked in this metric and window", async () => {
    pages = { 0: page([entry(1, "alice")], null, { viewerRank: null }) };
    vi.mocked(fetchViewer).mockResolvedValue(viewer("alice"));
    await render();

    expect(findMeButton()).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(container);
    // A stale rank must not show once the viewer is signed out.
    pages = { 0: page([entry(1, "alice")], null, { viewerRank: 1 }) };
    vi.mocked(fetchViewer).mockResolvedValue(null);
    await render();

    expect(findMeButton()).toBeUndefined();
  });

  it("loads pages until the viewer's row, then scrolls to and highlights it", async () => {
    pages = {
      0: page([entry(1, "alice"), entry(2, "bob")], 2, { viewerRank: 5 }),
      2: page([entry(3, "carol"), entry(4, "dave")], 4, { viewerRank: 5 }),
      4: page([entry(5, "erin"), entry(6, "frank")], 6, { viewerRank: 5 }),
      6: page([entry(7, "gina")], null, { viewerRank: 5 }),
    };
    vi.mocked(fetchViewer).mockResolvedValue(viewer("erin"));
    await render();

    expect(findMeButton()?.textContent).toBe("Find me#5");

    await click(findMeButton());

    expect(list.mock.calls.map(([call]) => call.query.offset)).toEqual([undefined, 2, 4]);
    expect(ranks()).toHaveLength(6);
    expect(scrolled).toEqual(["erin"]);
    expect(highlightedLogins()).toEqual(["erin"]);
    expect(document.activeElement?.textContent).toBe("erin");
    // More pages remain, so the footer still offers them.
    expect(loadMoreButton()).toBeDefined();

    // Already loaded: jumps without fetching.
    await click(findMeButton());

    expect(list).toHaveBeenCalledTimes(3);
    expect(scrolled).toEqual(["erin", "erin"]);
  });

  it("stops looking when a page fails", async () => {
    pages = {
      0: page([entry(1, "alice")], 1, { viewerRank: 3 }),
      1: new Error("network down"),
    };
    vi.mocked(fetchViewer).mockResolvedValue(viewer("carol"));
    await render();

    await click(findMeButton());

    expect(list).toHaveBeenCalledTimes(2);
    expect(scrolled).toEqual([]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(findMeButton()?.disabled).toBe(false);
  });

  it("keeps one row per user when the board shifts between pages", async () => {
    pages = {
      0: page([entry(1, "alice"), entry(2, "bob")], 2),
      // carol overtook bob between fetches, pushing him onto the next page.
      2: page([entry(3, "bob"), entry(4, "dave")], null),
    };
    await render();

    await clickLoadMore();

    expect(ranks()).toEqual([
      ["1", "alice"],
      ["2", "bob"],
      ["4", "dave"],
    ]);
  });

  it("keeps the rows and offers a retry when a page fails", async () => {
    pages = { 0: page([entry(1, "alice")], 1), 1: new Error("network down") };
    await render();

    await clickLoadMore();

    expect(ranks()).toEqual([["1", "alice"]]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load more rows. Try again.",
    );

    pages[1] = page([entry(2, "bob")], null);
    await clickLoadMore();

    expect(ranks()).toEqual([
      ["1", "alice"],
      ["2", "bob"],
    ]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

function page(
  entries: LeaderboardEntry[],
  nextOffset: number | null,
  fields: { total?: number; viewerRank?: number | null } = {},
): LeaderboardResponse & { nextOffset: number | null; total: number; viewerRank: number | null } {
  return {
    entries,
    metric: "tokens",
    nextOffset,
    total: fields.total ?? 1_000,
    viewerRank: fields.viewerRank ?? null,
    window: "7d",
  };
}

function viewer(login: string) {
  return { user: { avatarUrl: null, id: `user_${login}`, login, name: null } } as never;
}

async function render() {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      component: () => (
        <Suspense fallback="loading">
          <Leaderboard metric="tokens" window="7d" />
        </Suspense>
      ),
      getParentRoute: () => rootRoute,
      path: "/",
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "$user" }),
  ]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function clickLoadMore() {
  await click(loadMoreButton());
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  await settle();
}

function button(text: (content: string) => boolean): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) =>
    text(candidate.textContent ?? ""),
  );
}

function loadMoreButton(): HTMLButtonElement | undefined {
  return button((text) => text === "Load 100 more");
}

function findMeButton(): HTMLButtonElement | undefined {
  return button((text) => text.startsWith("Find me"));
}

/** The footer's "Showing …" text, if the footer renders. */
function progress(): string | undefined {
  return [...container.querySelectorAll("span")]
    .find((span) => span.textContent?.startsWith("Showing"))
    ?.textContent?.trim();
}

function highlightedLogins(): string[] {
  return [...container.querySelectorAll<HTMLElement>("tbody tr[data-highlighted]")].map(
    (row) => row.dataset["login"] ?? "",
  );
}

/** Each body row's rank and login. */
function ranks(): [string, string][] {
  return [...container.querySelectorAll("tbody tr")].map((row) => {
    const [pinned, login] = row.querySelectorAll("td");
    return [pinned?.querySelector("span")?.textContent ?? "", login?.textContent ?? ""];
  });
}
