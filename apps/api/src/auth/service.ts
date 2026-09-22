import { Context } from "effect";
import { Data, Effect } from "effect";
import { Option } from "effect";

import type { DatabaseError } from "../database";
import { generateToken, sha256Hex } from "./crypto";

/** Identity attached to requests after session resolution. */
interface CurrentUser {
  avatarUrl: string | null;
  id: string;
  login: string;
  name: string | null;
}

type OAuthProviderId = "github" | "google";

interface OAuthProfile {
  avatarUrl: string | null;
  email: string | null;
  emailVerified: boolean;
  login: string | null;
  name: string | null;
  provider: OAuthProviderId;
  providerAccountId: string;
}

interface UserAccountSummary {
  avatarUrl: string | null;
  email: string | null;
  emailVerified: boolean;
  login: string | null;
  name: string | null;
  provider: OAuthProviderId;
  providerAccountId: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class AccountLinkConflict extends Data.TaggedError("AccountLinkConflict")<{
  readonly provider: OAuthProviderId;
}> {}

interface AuthServiceShape {
  /** Resolves or links a provider identity, then mints a browser session.
   * Returns the RAW token (stored hashed). */
  signInWithProvider(
    profile: OAuthProfile,
    options?: { currentUser?: CurrentUser | undefined },
  ): Effect.Effect<{ token: string; user: CurrentUser }, AccountLinkConflict | DatabaseError, any>;
  resolveSession(rawToken: string): Effect.Effect<Option.Option<CurrentUser>, DatabaseError, any>;
  signOut(rawToken: string): Effect.Effect<void, DatabaseError, any>;
  listAccounts(userId: string): Effect.Effect<UserAccountSummary[], DatabaseError, any>;
}

interface AuthRepositoryShape {
  createUserWithAccount(input: {
    account: OAuthProfile;
    login: string;
  }): Effect.Effect<CurrentUser, DatabaseError, any>;
  findAccountUser(
    provider: OAuthProviderId,
    providerAccountId: string,
  ): Effect.Effect<Option.Option<CurrentUser>, DatabaseError, any>;
  findUserById(userId: string): Effect.Effect<Option.Option<CurrentUser>, DatabaseError, any>;
  findUsersByVerifiedEmail(email: string): Effect.Effect<CurrentUser[], DatabaseError, any>;
  insertSession(input: {
    expiresAt: Date;
    id: string;
    userId: string;
  }): Effect.Effect<void, DatabaseError, any>;
  /** Taken logins equal to `base` or of the form `${base}-…` (a superset is fine). */
  listLoginsLike(base: string): Effect.Effect<string[], DatabaseError, any>;
  linkAccount(
    userId: string,
    profile: OAuthProfile,
  ): Effect.Effect<CurrentUser, DatabaseError, any>;
  listAccounts(userId: string): Effect.Effect<UserAccountSummary[], DatabaseError, any>;
  mergeUsers(input: {
    sourceUserId: string;
    targetUserId: string;
  }): Effect.Effect<CurrentUser, DatabaseError, any>;
  findSessionUser(
    sessionId: string,
    now: Date,
  ): Effect.Effect<Option.Option<CurrentUser>, DatabaseError, any>;
  deleteSession(sessionId: string): Effect.Effect<void, DatabaseError, any>;
}

class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@tokenmaxxing/api/AuthService",
) {}

class AuthRepository extends Context.Service<AuthRepository, AuthRepositoryShape>()(
  "@tokenmaxxing/api/AuthRepository",
) {}

const makeAuthService = Effect.fn("makeAuthService")(function* () {
  const repository = yield* AuthRepository;

  const mintSession = Effect.fn("AuthService.mintSession")(function* (user: CurrentUser) {
    const token = yield* Effect.sync(() => generateToken());
    const id = yield* sha256Hex(token);
    yield* repository.insertSession({
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      id,
      userId: user.id,
    });

    return { token, user };
  });

  return AuthService.of({
    signInWithProvider: Effect.fn("AuthService.signInWithProvider")(
      function* (rawProfile, options) {
        const profile = normalizeOAuthProfile(rawProfile);
        const existing = yield* repository.findAccountUser(
          profile.provider,
          profile.providerAccountId,
        );
        // Looked up once, before any merge. Each branch below only ever
        // folds a user that is already in this list into another one that
        // is (or into the linking target), so re-querying after a merge
        // yields this list minus the merged-away user — which the branches
        // exclude explicitly — in the same createdAt/login order.
        const emailUsers = yield* verifiedEmailUsers(profile);
        if (Option.isSome(existing)) {
          if (options?.currentUser !== undefined && options.currentUser.id !== existing.value.id) {
            const emailUserIds = new Set(emailUsers.map((user) => user.id));
            const canMerge =
              emailUserIds.has(existing.value.id) && emailUserIds.has(options.currentUser.id);
            if (!canMerge) {
              return yield* Effect.fail(new AccountLinkConflict({ provider: profile.provider }));
            }

            yield* repository.mergeUsers({
              sourceUserId: existing.value.id,
              targetUserId: options.currentUser.id,
            });
            const user = yield* repository.linkAccount(options.currentUser.id, profile);
            const merged = yield* mergeUsersInto(user, emailUsers, existing.value.id);
            return yield* mintSession(merged);
          }

          const target = emailUsers[0] ?? existing.value;
          if (target.id !== existing.value.id) {
            yield* repository.mergeUsers({
              sourceUserId: existing.value.id,
              targetUserId: target.id,
            });
          }
          const user = yield* repository.linkAccount(target.id, profile);
          const merged = yield* mergeUsersInto(user, emailUsers, existing.value.id);
          return yield* mintSession(merged);
        }

        if (options?.currentUser !== undefined) {
          const user = yield* repository.linkAccount(options.currentUser.id, profile);
          const merged = yield* mergeUsersInto(user, emailUsers);
          return yield* mintSession(merged);
        }

        if (emailUsers.length > 0) {
          const user = yield* repository.linkAccount(emailUsers[0]!.id, profile);
          const merged = yield* mergeUsersInto(user, emailUsers);
          return yield* mintSession(merged);
        }

        const login = yield* nextAvailableLogin(loginBaseFromProfile(profile));
        const user = yield* repository.createUserWithAccount({ account: profile, login });
        return yield* mintSession(user);
      },
    ),
    resolveSession: Effect.fn("AuthService.resolveSession")(function* (rawToken) {
      const id = yield* sha256Hex(rawToken);
      return yield* repository.findSessionUser(id, new Date());
    }),
    signOut: Effect.fn("AuthService.signOut")(function* (rawToken) {
      const id = yield* sha256Hex(rawToken);
      yield* repository.deleteSession(id);
    }),
    listAccounts: Effect.fn("AuthService.listAccounts")(function* (userId) {
      return yield* repository.listAccounts(userId);
    }),
  });

  function verifiedEmailUsers(profile: OAuthProfile) {
    if (!profile.emailVerified || profile.email === null) {
      return Effect.succeed([]);
    }

    return Effect.gen(function* () {
      const users = yield* repository.findUsersByVerifiedEmail(profile.email!);
      return [...new Map(users.map((user) => [user.id, user])).values()];
    });
  }

  /** Folds every verified-email user (except the target and an already
   * merged-away user) into `target`, in createdAt/login order. */
  function mergeUsersInto(
    target: CurrentUser,
    emailUsers: readonly CurrentUser[],
    mergedAwayUserId?: string,
  ) {
    return Effect.gen(function* () {
      let merged = target;

      for (const user of emailUsers) {
        if (user.id !== target.id && user.id !== mergedAwayUserId) {
          merged = yield* repository.mergeUsers({
            sourceUserId: user.id,
            targetUserId: target.id,
          });
        }
      }

      return merged;
    });
  }

  function nextAvailableLogin(base: string) {
    return Effect.gen(function* () {
      const taken = new Set(yield* repository.listLoginsLike(base));
      for (let suffix = 1; suffix < 10_000; suffix += 1) {
        const candidate = suffix === 1 ? base : `${base}-${suffix}`;
        if (!taken.has(candidate)) {
          return candidate;
        }
      }

      return `${base}-${crypto.randomUUID().slice(0, 8)}`;
    });
  }
});

function normalizeOAuthProfile(profile: OAuthProfile): OAuthProfile {
  return {
    ...profile,
    email: profile.email === null ? null : profile.email.trim().toLowerCase(),
    login: normalizeNullableString(profile.login),
    name: normalizeNullableString(profile.name),
  };
}

function normalizeNullableString(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function loginBaseFromProfile(profile: OAuthProfile): string {
  const raw =
    profile.provider === "github" && profile.login !== null
      ? profile.login
      : (profile.email?.split("@", 1)[0] ?? profile.login ?? "user");

  return slugifyLogin(raw);
}

function slugifyLogin(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^[-_]+|[-_]+$/g, "");

  return slug.length === 0 ? "user" : slug;
}

export { AccountLinkConflict, AuthRepository, AuthService, makeAuthService };

export type {
  AuthRepositoryShape,
  AuthServiceShape,
  CurrentUser,
  OAuthProfile,
  OAuthProviderId,
  UserAccountSummary,
};
