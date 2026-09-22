import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";

import { runApi } from "./api";

/**
 * queryOptions for every server read — components compose these with
 * useQuery/useMutation. `queryKeys` is the single source of cache identity;
 * invalidate through it (or `invalidatePublicViews`) rather than literals.
 */

const queryKeys = {
  adminUsers: ["admin", "users"],
  /** A pending CLI login's device details, by its user code. */
  cliLoginRequest: (code: string) => ["me", "cliLogin", code] as const,
  devices: ["me", "devices"],
  leaderboard: ["leaderboard"],
  leaderboardList: (metric: LeaderboardMetric, window: LeaderboardWindow) =>
    ["leaderboard", metric, window] as const,
  me: ["me"],
  /** Prefix of both the profile summary and its daily rows. */
  profile: (login: string) => ["profile", login] as const,
  profileDaily: (login: string) => ["profile", login, "daily"] as const,
  stats: ["stats"],
  tokens: ["me", "tokens"],
} as const;

const meQueryOptions = queryOptions({
  queryKey: queryKeys.me,
  queryFn: () => runApi((client) => client.me.me()),
  retry: false,
  staleTime: 60_000,
});

const devicesQueryOptions = queryOptions({
  queryKey: queryKeys.devices,
  queryFn: () => runApi((client) => client.me.listDevices()),
});

const tokensQueryOptions = queryOptions({
  queryKey: queryKeys.tokens,
  queryFn: () => runApi((client) => client.me.listTokens()),
});

const adminUsersQueryOptions = queryOptions({
  queryKey: queryKeys.adminUsers,
  queryFn: () => runApi((client) => client.admin.listUsers()),
  staleTime: 30_000,
});

const statsQueryOptions = queryOptions({
  queryKey: queryKeys.stats,
  queryFn: () => runApi((client) => client.stats.get()),
  staleTime: 30_000,
});

function leaderboardQueryOptions(metric: LeaderboardMetric, window: LeaderboardWindow) {
  return queryOptions({
    queryKey: queryKeys.leaderboardList(metric, window),
    queryFn: () => runApi((client) => client.leaderboard.list({ query: { metric, window } })),
    staleTime: 30_000,
  });
}

function profileQueryOptions(login: string) {
  return queryOptions({
    queryKey: queryKeys.profile(login),
    queryFn: () => runApi((client) => client.profiles.get({ params: { login } })),
    staleTime: 30_000,
  });
}

function cliLoginRequestQueryOptions(code: string) {
  return queryOptions({
    queryKey: queryKeys.cliLoginRequest(code),
    queryFn: () => runApi((client) => client.me.describeCliLogin({ query: { code } })),
    retry: false,
  });
}

function profileDailyQueryOptions(login: string) {
  return queryOptions({
    queryKey: queryKeys.profileDaily(login),
    queryFn: () =>
      runApi((client) => client.profiles.daily({ params: { login }, query: { groupBy: "model" } })),
    staleTime: 30_000,
  });
}

/**
 * Refresh every public surface a usage or visibility change can move: the
 * leaderboard, aggregate stats, and (when known) the affected profile.
 */
async function invalidatePublicViews(queryClient: QueryClient, login?: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard }),
    queryClient.invalidateQueries({ queryKey: queryKeys.stats }),
    login === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: queryKeys.profile(login) }),
  ]);
}

export {
  adminUsersQueryOptions,
  cliLoginRequestQueryOptions,
  devicesQueryOptions,
  invalidatePublicViews,
  leaderboardQueryOptions,
  meQueryOptions,
  profileDailyQueryOptions,
  profileQueryOptions,
  queryKeys,
  statsQueryOptions,
  tokensQueryOptions,
};
