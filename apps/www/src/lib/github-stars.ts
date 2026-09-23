import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

import { GITHUB_REPO } from "./site";

/** Server-only: the browser gets the count via SSR (or this same-origin RPC). */
const getGithubStars = createServerFn({ method: "GET" }).handler(async () => {
  const { cachedGithubStars } = await import("./github-stars.server");

  return cachedGithubStars();
});

/** Stars for the footer badge; null when GitHub is unavailable. */
const githubStarsQueryOptions = queryOptions({
  queryKey: ["github-stars", GITHUB_REPO],
  queryFn: () => getGithubStars(),
  staleTime: 60 * 60 * 1000,
});

export { githubStarsQueryOptions };
