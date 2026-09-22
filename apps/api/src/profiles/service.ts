import { Context } from "effect";
import { Effect } from "effect";
import { Option } from "effect";

import { DEFAULT_LEADERBOARD_WINDOW, UserNotFound, utcDateKey } from "@tokenmaxxing/api-contract";
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
import { latestUsageDateKey } from "../usage/date-window";

/**
 * Public profile dashboards: lifetime stats for the header cards plus the
 * per-day series the charts consume, grouped by model or source.
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
  leaderboardRank(input: {
    since: string | null;
    until: string;
    userId: string;
  }): Effect.Effect<number | null, DatabaseError, any>;
  /**
   * Lifetime stats over days up to `until` (inclusive); `today` is the UTC
   * day key the current streak is measured against.
   */
  stats(
    userId: string,
    window: { today: string; until: string },
  ): Effect.Effect<ProfileStatsWithoutRank, DatabaseError, any>;
  /** `query.until` is always set: the requested bound capped at the ingest ceiling. */
  daily(
    userId: string,
    query: DailyQuery & { until: string },
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
      const now = new Date();
      const until = latestUsageDateKey(now);
      const [stats, leaderboardRank] = yield* Effect.all(
        [
          repository.stats(user.id, { today: utcDateKey(now), until }),
          repository.leaderboardRank({
            since: windowStart(DEFAULT_LEADERBOARD_WINDOW, now),
            until,
            userId: user.id,
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.orDie);

      return { stats: { ...stats, leaderboardRank }, user };
    }),
    getDaily: Effect.fn("ProfilesService.getDaily")(function* (login, query, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const now = new Date();
      const ceiling = latestUsageDateKey(now);
      const until = query.until === undefined || query.until > ceiling ? ceiling : query.until;
      const days = yield* repository.daily(user.id, { ...query, until }).pipe(Effect.orDie);

      return {
        days,
        range: profileDailyRange(query, now),
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
  return utcDateKey(now);
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
