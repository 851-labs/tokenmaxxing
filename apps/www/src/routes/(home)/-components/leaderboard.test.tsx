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

import { runApi } from "../../../lib/api";
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  list.mockClear();
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

  it("shows no button when the first page is the last", async () => {
    pages = { 0: page([entry(1, "alice")], null) };
    await render();

    expect(ranks()).toHaveLength(1);
    expect(loadMoreButton()).toBeUndefined();
  });

  it("treats a response without nextOffset as the last page", async () => {
    const { nextOffset: _, ...legacy } = page([entry(1, "alice")], null);
    pages = { 0: legacy };
    await render();

    expect(loadMoreButton()).toBeUndefined();
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
): LeaderboardResponse & { nextOffset: number | null } {
  return { entries, metric: "tokens", nextOffset, window: "7d" };
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
  const button = loadMoreButton();
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  await settle();
}

function loadMoreButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  );
}

/** Each body row's rank and login. */
function ranks(): [string, string][] {
  return [...container.querySelectorAll("tbody tr")].map((row) => {
    const [pinned, login] = row.querySelectorAll("td");
    return [pinned?.querySelector("span")?.textContent ?? "", login?.textContent ?? ""];
  });
}
