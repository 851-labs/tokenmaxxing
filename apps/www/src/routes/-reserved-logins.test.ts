import { readdirSync } from "node:fs";

import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { isReservedLogin } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

import { routeTree } from "../routeTree.gen";

/**
 * tokenmaxxing.sh/<login> is a profile, so any first path segment the site
 * itself serves must never be minted as a login (the API reserves them via
 * the contract's RESERVED_LOGINS).
 */

/** First path segment, without a file extension ("og.png" -> "og"). */
function loginShapedSegment(path: string): string | null {
  const segment = path.split("/")[1] ?? "";
  if (segment === "" || segment.startsWith("$") || segment.startsWith("{")) {
    return null;
  }

  return segment.split(".")[0] ?? null;
}

function topLevelRouteSegments(): string[] {
  const router = createRouter({ context: { queryClient: new QueryClient() }, routeTree });
  const segments = Object.keys(router.routesByPath).map(loginShapedSegment);

  return [...new Set(segments.filter((segment) => segment !== null))].toSorted();
}

describe("reserved logins", () => {
  it("cover every top-level www route", () => {
    const segments = topLevelRouteSegments();

    // Guards the walk itself: these routes exist today.
    expect(segments).toEqual(expect.arrayContaining(["favicon", "login", "og-card", "stats"]));
    expect(segments.filter((segment) => !isReservedLogin(segment))).toEqual([]);
  });

  it("cover every public file and the client build's asset directory", () => {
    const publicFiles = readdirSync(new URL("../../public", import.meta.url));
    const segments = [...publicFiles.map((file) => loginShapedSegment(`/${file}`)), "assets"];

    expect(publicFiles.length).toBeGreaterThan(0);
    expect(segments.filter((segment) => segment === null || !isReservedLogin(segment))).toEqual([]);
  });

  it("leave the profile route itself unreserved", () => {
    expect(isReservedLogin("pondorasti")).toBe(false);
    expect(isReservedLogin("Stats")).toBe(true);
  });
});
