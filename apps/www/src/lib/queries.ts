import { queryOptions } from "@tanstack/react-query";
import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";

import { runApi } from "./api";

/**
 * queryOptions for every server read — components compose these with
 * useQuery/useMutation; query keys are the single source of cache identity.
 */

const meQueryOptions = queryOptions({
  queryKey: ["me"],
  queryFn: () => runApi((client) => client.me.me()),
  retry: false,
  staleTime: 60_000,
});

const devicesQueryOptions = queryOptions({
  queryKey: ["me", "devices"],
  queryFn: () => runApi((client) => client.me.listDevices()),
});

const accountsQueryOptions = queryOptions({
  queryKey: ["me", "accounts"],
  queryFn: () => runApi((client) => client.me.listAccounts()),
});

const tokensQueryOptions = queryOptions({
  queryKey: ["me", "tokens"],
  queryFn: () => runApi((client) => client.me.listTokens()),
});

const adminUsersQueryOptions = queryOptions({
  queryKey: ["admin", "users"],
  queryFn: () => runApi((client) => client.admin.listUsers()),
  staleTime: 30_000,
});

const statsQueryOptions = queryOptions({
  queryKey: ["stats"],
  queryFn: () => runApi((client) => client.stats.get()),
  staleTime: 30_000,
});

function leaderboardQueryOptions(
  metric: typeof LeaderboardMetric.Type,
  window: typeof LeaderboardWindow.Type,
) {
  return queryOptions({
    queryKey: ["leaderboard", metric, window],
    queryFn: () => runApi((client) => client.leaderboard.list({ query: { metric, window } })),
    staleTime: 30_000,
  });
}

function profileQueryOptions(login: string) {
  return queryOptions({
    queryKey: ["profile", login],
    queryFn: () => runApi((client) => client.profiles.get({ params: { login } })),
    staleTime: 30_000,
  });
}

/** The pending CLI login a user is about to approve (device details). */
function cliLoginRequestQueryOptions(code: string) {
  return queryOptions({
    queryKey: ["me", "cliLogin", code],
    queryFn: () => runApi((client) => client.me.describeCliLogin({ query: { code } })),
    retry: false,
  });
}

function profileDailyQueryOptions(login: string) {
  return queryOptions({
    queryKey: ["profile", login, "daily"],
    queryFn: () =>
      runApi((client) => client.profiles.daily({ params: { login }, query: { groupBy: "model" } })),
    staleTime: 30_000,
  });
}

export {
  adminUsersQueryOptions,
  accountsQueryOptions,
  cliLoginRequestQueryOptions,
  devicesQueryOptions,
  leaderboardQueryOptions,
  meQueryOptions,
  profileDailyQueryOptions,
  profileQueryOptions,
  statsQueryOptions,
  tokensQueryOptions,
};
