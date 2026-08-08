import { Context } from "effect";
import { Effect } from "effect";
import { Option } from "effect";

import { DEFAULT_LEADERBOARD_WINDOW, UserNotFound } from "@tokenmaxxing/api-contract";
import type {
  AuthUser,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileDailyRow,
  ProfileIdentityResponse,
  ProfileResponse,
  ProfileStats,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";
import { windowStart } from "../leaderboard/service";
import { ProfileBadges, type GitHubBadgeIdentity } from "./badges";

/**
 * Public profile dashboards: lifetime stats for the header cards plus the
 * per-day series the charts consume, grouped by model, source, or device.
 */

const PROFILE_CHART_START = "2026-01-01";

interface DailyQuery {
  groupBy: typeof ProfileDailyGroupBy.Type;
  since?: string | undefined;
  until?: string | undefined;
}

interface ProfilesServiceShape {
  getIdentity(login: string): Effect.Effect<typeof ProfileIdentityResponse.Type, UserNotFound, any>;
  getProfile(
    login: string,
    viewerUserId: string | null,
  ): Effect.Effect<typeof ProfileResponse.Type, UserNotFound, any>;
  getDaily(
    login: string,
    query: DailyQuery,
    viewerUserId: string | null,
  ): Effect.Effect<typeof ProfileDailyResponse.Type, UserNotFound, any>;
}

interface ProfileUser {
  shadowBanned: boolean;
  user: typeof AuthUser.Type;
}

type ProfileStatsWithoutRank = Omit<typeof ProfileStats.Type, "leaderboardRank">;

interface ProfilesRepositoryShape {
  findUserByLogin(login: string): Effect.Effect<Option.Option<ProfileUser>, DatabaseError, any>;
  githubIdentity(userId: string): Effect.Effect<GitHubBadgeIdentity | null, DatabaseError, any>;
  leaderboardRank(input: {
    since: string | null;
    userId: string;
  }): Effect.Effect<number | null, DatabaseError, any>;
  stats(userId: string): Effect.Effect<ProfileStatsWithoutRank, DatabaseError, any>;
  daily(
    userId: string,
    query: DailyQuery,
  ): Effect.Effect<(typeof ProfileDailyRow.Type)[], DatabaseError, any>;
}

class ProfilesService extends Context.Service<ProfilesService, ProfilesServiceShape>()(
  "@tokenmaxxing/api/ProfilesService",
) {}

class ProfilesRepository extends Context.Service<ProfilesRepository, ProfilesRepositoryShape>()(
  "@tokenmaxxing/api/ProfilesRepository",
) {}

const makeProfilesService = Effect.fn("makeProfilesService")(function* () {
  const repository = yield* ProfilesRepository;
  const profileBadges = yield* ProfileBadges;

  const requireUser = Effect.fn("ProfilesService.requireUser")(function* (
    login: string,
    viewerUserId: string | null,
  ) {
    const result = yield* repository.findUserByLogin(login).pipe(Effect.orDie);
    if (
      Option.isNone(result) ||
      (result.value.shadowBanned && result.value.user.id !== viewerUserId)
    ) {
      return yield* Effect.fail(new UserNotFound({ login }));
    }

    return result.value.user;
  });

  return ProfilesService.of({
    getIdentity: Effect.fn("ProfilesService.getIdentity")(function* (login) {
      const user = yield* requireUser(login, null);
      return { avatarUrl: user.avatarUrl, login: user.login };
    }),
    getProfile: Effect.fn("ProfilesService.getProfile")(function* (login, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const [stats, leaderboardRank, badges] = yield* Effect.all(
        [
          repository.stats(user.id),
          repository.leaderboardRank({
            since: windowStart(DEFAULT_LEADERBOARD_WINDOW, new Date()),
            userId: user.id,
          }),
          repository.githubIdentity(user.id).pipe(
            Effect.orDie,
            Effect.flatMap((identity) => profileBadges.resolve(identity)),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.orDie);

      return { badges, stats: { ...stats, leaderboardRank }, user };
    }),
    getDaily: Effect.fn("ProfilesService.getDaily")(function* (login, query, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const days = yield* repository.daily(user.id, query).pipe(Effect.orDie);

      return {
        days,
        range: profileDailyRange(query, new Date()),
      };
    }),
  });
});

function profileDailyRange(query: Pick<DailyQuery, "since" | "until">, now: Date) {
  return {
    first: query.since ?? PROFILE_CHART_START,
    last: query.until ?? todayKeyUtc(now),
  };
}

function todayKeyUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export {
  makeProfilesService,
  PROFILE_CHART_START,
  profileDailyRange,
  ProfilesRepository,
  ProfilesService,
  todayKeyUtc,
};

export type { ProfilesRepositoryShape };
