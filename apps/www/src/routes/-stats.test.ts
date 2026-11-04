import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { routeTree } from "../routeTree.gen";

/** The /stats search as the real router parses and validates `href`. */
function statsSearch(href: string) {
  const router = createRouter({
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: [href] }),
    routeTree,
  });
  const match = router.matchRoutes(router.state.location).at(-1);

  // The root route passes raw params through, so keep only what /stats validates.
  const search = match?.search as { metric?: unknown; range?: unknown } | undefined;
  return { routeId: match?.routeId, search: { metric: search?.metric, range: search?.range } };
}

describe("/stats search", () => {
  it("opens the default range and metric without params", () => {
    expect(statsSearch("/stats")).toEqual({
      routeId: "/stats",
      search: { metric: "tokens", range: "2m" },
    });
  });

  it("keeps valid ranges and metrics and falls back for anything else", () => {
    expect(statsSearch("/stats?range=6m&metric=spend").search).toEqual({
      metric: "spend",
      range: "6m",
    });
    expect(statsSearch("/stats?range=5y&metric=vibes").search).toEqual({
      metric: "tokens",
      range: "2m",
    });
  });

  it("maps legacy ?window= links onto ranges", () => {
    expect(statsSearch("/stats?window=30d").search).toEqual({ metric: "tokens", range: "1m" });
    expect(statsSearch("/stats?window=ytd").search).toEqual({ metric: "tokens", range: "ytd" });
    // The default parser turns the bare 2026 into a number, not the string.
    expect(statsSearch("/stats?window=2026").search).toEqual({ metric: "tokens", range: "ytd" });
    expect(statsSearch('/stats?window="2026"').search).toEqual({ metric: "tokens", range: "ytd" });
    expect(statsSearch("/stats?window=2025").search).toEqual({ metric: "tokens", range: "2m" });
    // An explicit range wins over a leftover window.
    expect(statsSearch("/stats?window=ytd&range=2w").search).toEqual({
      metric: "tokens",
      range: "2w",
    });
  });
});
