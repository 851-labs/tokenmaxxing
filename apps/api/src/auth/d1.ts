import {
  cliLoginRequests,
  cliTokens,
  devices,
  sessions,
  usageDays,
  usageSourceStats,
  userAccounts,
  users,
  type User,
  type UserAccount,
} from "@tokenmaxxing/db";
import { and, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";

import { Drizzle } from "../database";
import {
  AuthRepository,
  type CurrentUser,
  type OAuthProfile,
  type OAuthProviderId,
  type UserAccountSummary,
} from "./service";

const makeD1AuthRepository = Effect.fn("makeD1AuthRepository")(function* () {
  const database = yield* Drizzle;

  const updateUserFromProfile = Effect.fn("AuthRepository.updateUserFromProfile")(function* (
    userId: string,
    profile: OAuthProfile,
    now: Date,
  ) {
    const rows = yield* database.use((db) =>
      db.select().from(users).where(eq(users.id, userId)).limit(1),
    );
    const user = rows[0];
    if (user === undefined) {
      return yield* Effect.die(`missing user ${userId}`);
    }

    const next = {
      avatarUrl: user.avatarUrl ?? profile.avatarUrl,
      name: user.name ?? profile.name,
    };
    if (next.avatarUrl === user.avatarUrl && next.name === user.name) {
      return toCurrentUser(user);
    }

    const [updated] = yield* database.use((db) =>
      db
        .update(users)
        .set({ ...next, updatedAt: now })
        .where(eq(users.id, userId))
        .returning(),
    );

    return toCurrentUser(updated ?? { ...user, ...next, updatedAt: now });
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

        return toCurrentUser(user);
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
        const row = rows[0];

        return row === undefined ? Option.none() : Option.some(toCurrentUser(row.user));
      }),
    findUserById: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db.select().from(users).where(eq(users.id, userId)).limit(1),
        );
        const row = rows[0];

        return row === undefined ? Option.none() : Option.some(toCurrentUser(row));
      }),
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

        return rows.map((row) => toCurrentUser(row.user));
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
    isLoginTaken: (login) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db.select({ id: users.id }).from(users).where(eq(users.login, login)).limit(1),
        );

        return rows.length > 0;
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
                name: profile.name,
                starredTokenmaxxing: profile.starredTokenmaxxing,
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

        return rows.map(toUserAccountSummary);
      }),
    mergeUsers: ({ sourceUserId, targetUserId }) =>
      Effect.gen(function* () {
        if (sourceUserId === targetUserId) {
          const target = yield* findUserOrDie(targetUserId);
          return toCurrentUser(target);
        }

        const [source, target] = yield* Effect.all([
          findUserOrDie(sourceUserId),
          findUserOrDie(targetUserId),
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

        const merged = yield* findUserOrDie(targetUserId);
        return toCurrentUser(merged);
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
        const row = rows[0];

        return row === undefined ? Option.none() : Option.some(toCurrentUser(row.user));
      }),
    deleteSession: (sessionId) =>
      Effect.gen(function* () {
        yield* database.use((db) => db.delete(sessions).where(eq(sessions.id, sessionId)));
      }),
  });

  function findUserOrDie(userId: string) {
    return Effect.gen(function* () {
      const rows = yield* database.use((db) =>
        db.select().from(users).where(eq(users.id, userId)).limit(1),
      );
      const user = rows[0];
      if (user === undefined) {
        return yield* Effect.die(`missing user ${userId}`);
      }

      return user;
    });
  }
});

const AuthRepositoryLive = Layer.effect(AuthRepository, makeD1AuthRepository());

function accountInsert(userId: string, profile: OAuthProfile, now: Date) {
  return {
    avatarUrl: profile.avatarUrl,
    createdAt: now,
    email: profile.email,
    emailVerified: profile.emailVerified,
    login: profile.login,
    name: profile.name,
    provider: profile.provider,
    providerAccountId: profile.providerAccountId,
    starredTokenmaxxing: profile.starredTokenmaxxing ?? false,
    updatedAt: now,
    userId,
  };
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

function toCurrentUser(user: Pick<User, "avatarUrl" | "id" | "login" | "name">): CurrentUser {
  return { avatarUrl: user.avatarUrl, id: user.id, login: user.login, name: user.name };
}

function toUserAccountSummary(account: UserAccount): UserAccountSummary {
  return {
    avatarUrl: account.avatarUrl,
    email: account.email,
    emailVerified: account.emailVerified,
    login: account.login,
    name: account.name,
    provider: account.provider as OAuthProviderId,
    providerAccountId: account.providerAccountId,
  };
}

export { AuthRepositoryLive, mergedShadowBan };
