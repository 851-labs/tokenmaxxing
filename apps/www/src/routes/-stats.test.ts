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

  return { routeId: match?.routeId, search: match?.search };
}

describe("/stats search", () => {
  it("opens year to date from legacy ?window=2026 links", () => {
    // The default parser turns the bare 2026 into a number, not the string.
    expect(statsSearch("/stats?window=2026")).toEqual({
      routeId: "/stats",
      search: { window: "ytd" },
    });
    expect(statsSearch('/stats?window="2026"').search).toEqual({ window: "ytd" });
  });

  it("keeps current tab values and falls back to 30d for anything else", () => {
    expect(statsSearch("/stats?window=ytd").search).toEqual({ window: "ytd" });
    expect(statsSearch("/stats?window=30d").search).toEqual({ window: "30d" });
    expect(statsSearch("/stats?window=2025").search).toEqual({ window: "30d" });
    expect(statsSearch("/stats").search).toEqual({ window: "30d" });
  });
});
