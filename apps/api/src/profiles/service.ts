import { Context, Effect, Option } from "effect";

import {
  DEFAULT_LEADERBOARD_WINDOW,
  MIN_USAGE_DATE_KEY,
  BadRequest,
  UserNotFound,
} from "@tokenmaxxing/api-contract";
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
import { latestUsageDateKey, shiftDayKey, utcDayKey, yearStartOf } from "../date-keys";
import { toPublicUser } from "../public-user";
import { leaderboardWindowStart } from "../usage/ranking";

/**
 * Public profile dashboards: lifetime stats for the header cards plus the
 * per-day series the charts consume, grouped by model or source. Without an
 * explicit `since`, charts cover the current UTC year to date.
 */

/** Longest span one daily request may cover (about three years of days). */
const MAX_DAILY_RANGE_DAYS = 3 * 366;

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
  ): Effect.Effect<ProfileDailyResponse, BadRequest | UserNotFound>;
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
  /** Both bounds are always set: see {@link profileDailyBounds}. */
  daily(
    userId: string,
    query: DailyQuery & { since: string; until: string },
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
      const bounds = yield* profileDailyBounds(query, now);
      const days = yield* repository
        .daily(user.id, { groupBy: query.groupBy, ...bounds })
        .pipe(Effect.orDie);

      return { days, range: profileDailyRange(query, bounds, days, now) };
    }),
  });
});

/**
 * The inclusive day-key bounds a daily query reads. `until` is capped at the
 * ingest ceiling (UTC today + 1, where a device's local day can already be);
 * `since` defaults to Jan 1 of the range's year and is floored at the ingest
 * floor ({@link MIN_USAGE_DATE_KEY}) and so a request never spans more than
 * {@link MAX_DAILY_RANGE_DAYS} (never past `until`, so the range stays
 * ordered). A `since` after the capped `until` is an inverted range, not an
 * empty one.
 */
function profileDailyBounds(
  query: Pick<DailyQuery, "since" | "until">,
  now: Date,
): Effect.Effect<{ since: string; until: string }, BadRequest> {
  const ceiling = latestUsageDateKey(now);
  const until = query.until === undefined || query.until > ceiling ? ceiling : query.until;
  if (query.since !== undefined && query.since > until) {
    return Effect.fail(
      new BadRequest({
        message: `Invalid date range: \`since\` (${query.since}) is after \`until\` (${until}).`,
      }),
    );
  }

  const today = utcDayKey(now);
  const spanFloor = shiftDayKey(until, -(MAX_DAILY_RANGE_DAYS - 1));
  const lowest = spanFloor > MIN_USAGE_DATE_KEY ? spanFloor : MIN_USAGE_DATE_KEY;
  const floor = lowest > until ? until : lowest;
  const requested = query.since ?? yearStartOf(until < today ? until : today);

  return Effect.succeed({ since: requested < floor ? floor : requested, until });
}

/**
 * The chart range reported with the rows: it always covers every row
 * returned, so charts that enumerate it never drop a day the stats count.
 * An explicit `until` is echoed (capped); otherwise the range ends on UTC
 * today, or on the latest returned day when the user's local day already
 * runs ahead of UTC.
 */
function profileDailyRange(
  query: Pick<DailyQuery, "until">,
  bounds: { since: string; until: string },
  days: readonly Pick<ProfileDailyRow, "date">[],
  now: Date,
): ProfileDailyResponse["range"] {
  if (query.until !== undefined) {
    return { firstDate: bounds.since, lastDate: bounds.until };
  }

  let lastDate = utcDayKey(now);
  for (const candidate of [bounds.since, days.at(-1)?.date]) {
    if (candidate !== undefined && candidate > lastDate) {
      lastDate = candidate;
    }
  }

  return { firstDate: bounds.since, lastDate };
}

export {
  makeProfilesService,
  MAX_DAILY_RANGE_DAYS,
  profileDailyBounds,
  profileDailyRange,
  ProfilesRepository,
  ProfilesService,
};

export type { ProfilesRepositoryShape };
