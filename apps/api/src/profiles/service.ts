import { Context, Effect, Option } from "effect";

import { DEFAULT_LEADERBOARD_WINDOW, UserNotFound } from "@tokenmaxxing/api-contract";
import type {
  AuthUser,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileDailyRow,
  ProfileIdentityResponse,
  ProfileResponse,
  ProfileStats,
  UserId,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";
import { latestUsageDateKey, utcDayKey, yearStartDayKey } from "../date-keys";
import { toPublicUser } from "../public-user";
import { leaderboardWindowStart } from "../usage/ranking";

/**
 * Public profile dashboards: lifetime stats for the header cards plus the
 * per-day series the charts consume, grouped by model or source. Without an
 * explicit `since`, charts cover the current UTC year to date.
 */

interface DailyQuery {
  groupBy: ProfileDailyGroupBy;
  since?: string | undefined;
  until?: string | undefined;
}

interface ProfilesServiceShape {
  getIdentity(
    login: string,
    viewerUserId: UserId | null,
  ): Effect.Effect<ProfileIdentityResponse, UserNotFound>;
  getProfile(
    login: string,
    viewerUserId: UserId | null,
  ): Effect.Effect<ProfileResponse, UserNotFound>;
  getDaily(
    login: string,
    query: DailyQuery,
    viewerUserId: UserId | null,
  ): Effect.Effect<ProfileDailyResponse, UserNotFound>;
}

interface ProfileUser {
  shadowBanned: boolean;
  /** Internal identity; responses expose it only as a PublicUser. */
  user: AuthUser;
}

type ProfileStatsWithoutRank = Omit<ProfileStats, "leaderboardRank">;

interface ProfilesRepositoryShape {
  findUserByLogin(login: string): Effect.Effect<Option.Option<ProfileUser>, DatabaseError>;
  leaderboardRank(input: {
    since: string | null;
    until: string;
    userId: string;
  }): Effect.Effect<number | null, DatabaseError>;
  /**
   * Lifetime stats over days up to `until` (inclusive); `today` is the UTC
   * day key the current streak is measured against.
   */
  stats(
    userId: string,
    window: { today: string; until: string },
  ): Effect.Effect<ProfileStatsWithoutRank, DatabaseError>;
  /** `query.until` is always set: the requested bound capped at the ingest ceiling. */
  daily(
    userId: string,
    query: DailyQuery & { until: string },
  ): Effect.Effect<ProfileDailyRow[], DatabaseError>;
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
    viewerUserId: UserId | null,
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
    getIdentity: Effect.fn("ProfilesService.getIdentity")(function* (login, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      return { avatarUrl: user.avatarUrl, login: user.login };
    }),
    getProfile: Effect.fn("ProfilesService.getProfile")(function* (login, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const now = new Date();
      const until = latestUsageDateKey(now);
      const [stats, leaderboardRank] = yield* Effect.all(
        [
          repository.stats(user.id, { today: utcDayKey(now), until }),
          repository.leaderboardRank({
            since: leaderboardWindowStart(DEFAULT_LEADERBOARD_WINDOW, now),
            until,
            userId: user.id,
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.orDie);

      return { stats: { ...stats, leaderboardRank }, user: toPublicUser(user) };
    }),
    getDaily: Effect.fn("ProfilesService.getDaily")(function* (login, query, viewerUserId) {
      const user = yield* requireUser(login, viewerUserId);
      const now = new Date();
      const ceiling = latestUsageDateKey(now);
      const until = query.until === undefined || query.until > ceiling ? ceiling : query.until;
      const range = profileDailyRange(query, now);
      // The reported range.firstDate is also the query's lower bound, so
      // charts never receive rows before the range they draw.
      const days = yield* repository
        .daily(user.id, { ...query, since: range.firstDate, until })
        .pipe(Effect.orDie);

      return { days, range };
    }),
  });
});

function profileDailyRange(
  query: Pick<DailyQuery, "since" | "until">,
  now: Date,
): ProfileDailyResponse["range"] {
  return {
    firstDate: query.since ?? yearStartDayKey(now),
    lastDate: query.until ?? utcDayKey(now),
  };
}

export { makeProfilesService, profileDailyRange, ProfilesRepository, ProfilesService };

export type { ProfilesRepositoryShape };
