import {
  cliLoginRequests,
  cliTokens,
  devices,
  loginAliases,
  sessions,
  usageDays,
  usageRawBatches,
  usageSourceStats,
  userAccounts,
  users,
  type User,
  type UserAccount,
} from "@tokenmaxxing/db";
import { and, eq, exists, gt, isNull, like, lte, ne, or, type SQL } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";

import { DatabaseError, Drizzle, firstRow } from "../database";
import { GitHubAccountsLive } from "../oauth/github";
import { toAuthUser } from "../public-user";
import {
  AuthRepository,
  AuthService,
  LoginTaken,
  makeAuthService,
  type OAuthProfile,
  UserRecordMissing,
} from "./service";

const makeD1AuthRepository = Effect.fn("makeD1AuthRepository")(function* () {
  const database = yield* Drizzle;

  const updateUserFromProfile = Effect.fn("AuthRepository.updateUserFromProfile")(function* (
    userId: string,
    profile: OAuthProfile,
    now: Date,
  ) {
    const user = yield* findUserOrFail(userId);
    const next = {
      avatarUrl: user.avatarUrl ?? profile.avatarUrl,
      name: user.name ?? profile.name,
    };
    if (next.avatarUrl === user.avatarUrl && next.name === user.name) {
      return toAuthUser(user);
    }

    const [updated] = yield* database.use((db) =>
      db
        .update(users)
        .set({ ...next, updatedAt: now })
        .where(eq(users.id, userId))
        .returning(),
    );

    return toAuthUser(updated ?? { ...user, ...next, updatedAt: now });
  });

  return AuthRepository.of({
    createUserWithAccount: ({ account, login }) =>
      Effect.gen(function* () {
        const now = new Date();
        const user = {
          avatarUrl: account.avatarUrl,
          createdAt: now,
          id: crypto.randomUUID(),
          login,
          name: account.name,
          updatedAt: now,
        };

        yield* database.use((db) =>
          db.batch([
            db.insert(users).values(user),
            db.insert(userAccounts).values(accountInsert(user.id, account, now)),
          ]),
        );

        return toAuthUser(user);
      }),
    findAccountUser: (provider, providerAccountId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ user: users })
            .from(userAccounts)
            .innerJoin(users, eq(userAccounts.userId, users.id))
            .where(
              and(
                eq(userAccounts.provider, provider),
                eq(userAccounts.providerAccountId, providerAccountId),
              ),
            )
            .limit(1),
        );

        return firstRow(rows).pipe(Option.map((row) => toAuthUser(row.user)));
      }),
    findUserById: (userId) => findUserRow(userId).pipe(Effect.map(Option.map(toAuthUser))),
    findUsersByVerifiedEmail: (email) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ user: users })
            .from(userAccounts)
            .innerJoin(users, eq(userAccounts.userId, users.id))
            .where(and(eq(userAccounts.email, email), eq(userAccounts.emailVerified, true)))
            .orderBy(users.createdAt, users.login),
        );

        return rows.map((row) => toAuthUser(row.user));
      }),
    insertSession: (input) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db.insert(sessions).values({
            createdAt: new Date(),
            expiresAt: input.expiresAt,
            id: input.id,
            userId: input.userId,
          }),
        );
      }),
    listLoginsLike: (base, ownerId) =>
      Effect.gen(function* () {
        // LIKE is case-insensitive and `_` is a wildcard, so this can
        // over-match; callers compare lowercased exact strings. One
        // statement, so a login moving from users to login_aliases in a
        // concurrent rename is seen in exactly one of the two.
        const notOwnedBy = (
          column: typeof users.id | typeof loginAliases.userId,
        ): SQL | undefined => (ownerId === undefined ? undefined : ne(column, ownerId));
        const rows = yield* database.use((db) =>
          db
            .select({ login: users.login })
            .from(users)
            .where(
              and(
                or(like(users.login, base), like(users.login, `${base}-%`)),
                notOwnedBy(users.id),
              ),
            )
            .unionAll(
              db
                .select({ login: loginAliases.login })
                .from(loginAliases)
                .where(
                  and(
                    or(like(loginAliases.login, base), like(loginAliases.login, `${base}-%`)),
                    notOwnedBy(loginAliases.userId),
                  ),
                ),
            ),
        );

        return rows.map((row) => row.login);
      }),
    linkAccount: (userId, profile) =>
      Effect.gen(function* () {
        const now = new Date();
        const user = yield* updateUserFromProfile(userId, profile, now);
        yield* database.use((db) =>
          db
            .insert(userAccounts)
            .values(accountInsert(userId, profile, now))
            .onConflictDoUpdate({
              target: [userAccounts.provider, userAccounts.providerAccountId],
              set: {
                avatarUrl: profile.avatarUrl,
                email: profile.email,
                emailVerified: profile.emailVerified,
                login: profile.login,
                loginCheckedAt: accountInsert(userId, profile, now).loginCheckedAt,
                name: profile.name,
                updatedAt: now,
                userId,
              },
            }),
        );

        return user;
      }),
    listAccounts: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select()
            .from(userAccounts)
            .where(eq(userAccounts.userId, userId))
            .orderBy(userAccounts.provider),
        );

        return rows.map(toAccountProfile);
      }),
    renameUser: ({ from, githubAccount, to, userId }) =>
      Effect.gen(function* () {
        const now = new Date();
        // Every statement is conditioned on the login still being `from`, so
        // a rename that lost a race changes nothing. The users update runs
        // last: the unique index and the alias triggers abort the whole
        // batch when `to` was taken meanwhile.
        const stillFrom = (db: Parameters<Parameters<typeof database.use>[0]>[0]) =>
          exists(
            db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.id, userId), eq(users.login, from))),
          );
        const results = yield* database
          .use((db): Promise<unknown[]> => {
            const recordAlias = db
              .insert(loginAliases)
              .values({ createdAt: now, login: from.toLowerCase(), userId })
              .onConflictDoNothing();
            const releaseAlias = db
              .delete(loginAliases)
              .where(
                and(
                  eq(loginAliases.login, to.toLowerCase()),
                  eq(loginAliases.userId, userId),
                  stillFrom(db),
                ),
              );
            const rename = db
              .update(users)
              .set({ login: to, updatedAt: now })
              .where(and(eq(users.id, userId), eq(users.login, from)))
              .returning();
            if (githubAccount === undefined) {
              return db.batch([recordAlias, releaseAlias, rename]);
            }

            const storeAccountLogin = db
              .update(userAccounts)
              .set({ login: githubAccount.login, updatedAt: now })
              .where(
                and(
                  eq(userAccounts.provider, "github"),
                  eq(userAccounts.providerAccountId, githubAccount.providerAccountId),
                  eq(userAccounts.userId, userId),
                  stillFrom(db),
                ),
              );
            return db.batch([recordAlias, releaseAlias, storeAccountLogin, rename]);
          })
          .pipe(
            Effect.catchTag("DatabaseError", (error) =>
              Effect.fail(isLoginConflict(error.cause) ? new LoginTaken({ login: to }) : error),
            ),
          );

        // The recorded alias is right even when the swap missed: `from` was
        // this user's login when the caller read it.
        return firstRow(results.at(-1) as User[]).pipe(Option.map(toAuthUser));
      }),
    claimGitHubLoginChecks: (userId, staleBefore, now) =>
      database.use((db) =>
        db
          .update(userAccounts)
          .set({ loginCheckedAt: now })
          .where(
            and(
              eq(userAccounts.userId, userId),
              eq(userAccounts.provider, "github"),
              or(
                isNull(userAccounts.loginCheckedAt),
                lte(userAccounts.loginCheckedAt, staleBefore),
              ),
            ),
          )
          .returning({
            login: userAccounts.login,
            providerAccountId: userAccounts.providerAccountId,
          }),
      ),
    setGitHubAccountLogin: (providerAccountId, login) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db
            .update(userAccounts)
            .set({ login, updatedAt: new Date() })
            .where(
              and(
                eq(userAccounts.provider, "github"),
                eq(userAccounts.providerAccountId, providerAccountId),
              ),
            ),
        );
      }),
    mergeUsers: ({ sourceUserId, targetUserId }) =>
      Effect.gen(function* () {
        if (sourceUserId === targetUserId) {
          const target = yield* findUserOrFail(targetUserId);
          return toAuthUser(target);
        }

        const [source, target] = yield* Effect.all([
          findUserOrFail(sourceUserId),
          findUserOrFail(targetUserId),
        ]);
        const now = new Date();
        const shadowBan = mergedShadowBan(source, target);

        yield* database.use((db) =>
          db.batch([
            db
              .update(userAccounts)
              .set({ userId: targetUserId })
              .where(eq(userAccounts.userId, sourceUserId)),
            db
              .update(sessions)
              .set({ userId: targetUserId })
              .where(eq(sessions.userId, sourceUserId)),
            db
              .update(cliLoginRequests)
              .set({ userId: targetUserId })
              .where(eq(cliLoginRequests.userId, sourceUserId)),
            db
              .update(cliTokens)
              .set({ userId: targetUserId })
              .where(eq(cliTokens.userId, sourceUserId)),
            db
              .update(devices)
              .set({ userId: targetUserId })
              .where(eq(devices.userId, sourceUserId)),
            db
              .update(usageDays)
              .set({ userId: targetUserId })
              .where(eq(usageDays.userId, sourceUserId)),
            db
              .update(usageSourceStats)
              .set({ userId: targetUserId })
              .where(eq(usageSourceStats.userId, sourceUserId)),
            // Raw report objects stay at their keys: the row's objectKey is
            // the pointer, and the userId inside the key is provenance only.
            db
              .update(usageRawBatches)
              .set({ userId: targetUserId })
              .where(eq(usageRawBatches.userId, sourceUserId)),
            // The merged-away login and its history stay with the person:
            // its URLs redirect to the target and nobody else can take it.
            db
              .update(loginAliases)
              .set({ userId: targetUserId })
              .where(eq(loginAliases.userId, sourceUserId)),
            db
              .insert(loginAliases)
              .values({ createdAt: now, login: source.login.toLowerCase(), userId: targetUserId })
              .onConflictDoNothing(),
            db
              .update(users)
              .set({
                avatarUrl: target.avatarUrl ?? source.avatarUrl,
                name: target.name ?? source.name,
                ...shadowBan,
                updatedAt: now,
              })
              .where(eq(users.id, targetUserId)),
            db.delete(users).where(eq(users.id, sourceUserId)),
          ]),
        );

        const merged = yield* findUserOrFail(targetUserId);
        return toAuthUser(merged);
      }),
    findSessionUser: (sessionId, now) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ user: users })
            .from(sessions)
            .innerJoin(users, eq(sessions.userId, users.id))
            .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
            .limit(1),
        );

        return firstRow(rows).pipe(Option.map((row) => toAuthUser(row.user)));
      }),
    deleteSession: (sessionId) =>
      Effect.gen(function* () {
        yield* database.use((db) => db.delete(sessions).where(eq(sessions.id, sessionId)));
      }),
  });

  function findUserRow(userId: string) {
    return database
      .use((db) => db.select().from(users).where(eq(users.id, userId)).limit(1))
      .pipe(Effect.map(firstRow));
  }

  function findUserOrFail(userId: string) {
    return findUserRow(userId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new DatabaseError({ cause: new UserRecordMissing({ userId }) })),
          onSome: Effect.succeed,
        }),
      ),
    );
  }
});

const AuthRepositoryLive = Layer.effect(AuthRepository, makeD1AuthRepository());

const AuthServiceLive = Layer.effect(AuthService, makeAuthService()).pipe(
  Layer.provide([AuthRepositoryLive, GitHubAccountsLive]),
);

function accountInsert(userId: string, profile: OAuthProfile, now: Date) {
  return {
    avatarUrl: profile.avatarUrl,
    createdAt: now,
    email: profile.email,
    emailVerified: profile.emailVerified,
    login: profile.login,
    // A sign-in just read the GitHub login, so the daily check can wait.
    loginCheckedAt: profile.provider === "github" ? now : null,
    name: profile.name,
    provider: profile.provider,
    providerAccountId: profile.providerAccountId,
    updatedAt: now,
    userId,
  };
}

/**
 * Whether a failed rename batch hit a login someone else holds: the unique
 * index on users.login, or the alias triggers (`login_reserved`). Walks the
 * cause chain, since drizzle and D1 each wrap the SQLite error.
 */
function isLoginConflict(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (
      current.message.includes("login_reserved") ||
      current.message.includes("UNIQUE constraint failed: users.login")
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

function mergedShadowBan(
  source: Pick<User, "shadowBannedAt" | "shadowBannedByUserId">,
  target: Pick<User, "shadowBannedAt" | "shadowBannedByUserId">,
) {
  const selected = target.shadowBannedAt !== null ? target : source;
  return {
    shadowBannedAt: selected.shadowBannedAt,
    shadowBannedByUserId: selected.shadowBannedByUserId,
  };
}

/** The public identity slice of a users row — every repository that joins
 * users returns this shape. */
function toAccountProfile(account: UserAccount): OAuthProfile {
  return {
    avatarUrl: account.avatarUrl,
    email: account.email,
    emailVerified: account.emailVerified,
    login: account.login,
    name: account.name,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
  };
}

export { AuthRepositoryLive, AuthServiceLive, mergedShadowBan };
