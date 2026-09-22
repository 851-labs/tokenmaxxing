import { Context, Data, Effect, Option } from "effect";

import type { AuthUser, OAuthProviderId, UserAccountSummary } from "@tokenmaxxing/api-contract";

import { type DatabaseError, firstRow } from "../database";
import { generateToken, sha256Hex } from "./crypto";

/** A provider identity exactly as linking stores it on the account. */
type OAuthProfile = typeof UserAccountSummary.Type;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class AccountLinkConflict extends Data.TaggedError("AccountLinkConflict")<{
  readonly provider: OAuthProviderId;
}> {}

/** A user row the flow just read or wrote vanished mid-flight — an
 * integrity fault, reported inside a DatabaseError. */
class UserRecordMissing extends Data.TaggedError("UserRecordMissing")<{
  readonly userId: string;
}> {}

/**
 * Browser identity. Persistence faults die here (the service boundary);
 * the only failure callers handle is a provider identity that belongs to
 * someone else.
 */
interface AuthServiceShape {
  /** Resolves or links a provider identity, then mints a browser session.
   * Returns the RAW token (stored hashed). */
  signInWithProvider(
    profile: OAuthProfile,
    options?: { currentUser?: AuthUser | undefined },
  ): Effect.Effect<{ token: string; user: AuthUser }, AccountLinkConflict>;
  resolveSession(rawToken: string): Effect.Effect<Option.Option<AuthUser>>;
  signOut(rawToken: string): Effect.Effect<void>;
  listAccounts(userId: string): Effect.Effect<(typeof UserAccountSummary.Type)[]>;
}

interface AuthRepositoryShape {
  createUserWithAccount(input: {
    account: OAuthProfile;
    login: string;
  }): Effect.Effect<AuthUser, DatabaseError>;
  findAccountUser(
    provider: OAuthProviderId,
    providerAccountId: string,
  ): Effect.Effect<Option.Option<AuthUser>, DatabaseError>;
  findUserById(userId: string): Effect.Effect<Option.Option<AuthUser>, DatabaseError>;
  findUsersByVerifiedEmail(email: string): Effect.Effect<AuthUser[], DatabaseError>;
  insertSession(input: {
    expiresAt: Date;
    id: string;
    userId: string;
  }): Effect.Effect<void, DatabaseError>;
  /** Taken logins equal to `base` or of the form `${base}-…` (a superset is fine). */
  listLoginsLike(base: string): Effect.Effect<string[], DatabaseError>;
  linkAccount(userId: string, profile: OAuthProfile): Effect.Effect<AuthUser, DatabaseError>;
  listAccounts(userId: string): Effect.Effect<(typeof UserAccountSummary.Type)[], DatabaseError>;
  mergeUsers(input: {
    sourceUserId: string;
    targetUserId: string;
  }): Effect.Effect<AuthUser, DatabaseError>;
  findSessionUser(
    sessionId: string,
    now: Date,
  ): Effect.Effect<Option.Option<AuthUser>, DatabaseError>;
  deleteSession(sessionId: string): Effect.Effect<void, DatabaseError>;
}

class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@tokenmaxxing/api/AuthService",
) {}

class AuthRepository extends Context.Service<AuthRepository, AuthRepositoryShape>()(
  "@tokenmaxxing/api/AuthRepository",
) {}

const makeAuthService = Effect.fn("makeAuthService")(function* () {
  const repository = yield* AuthRepository;

  const mintSession = Effect.fn("AuthService.mintSession")(function* (user: AuthUser) {
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
        const owner = yield* repository.findAccountUser(
          profile.provider,
          profile.providerAccountId,
        );
        // Looked up once, before any merge. Linking only ever folds a user
        // that is already in this list into another one that is (or into
        // the linking target), so re-querying after a merge would yield this
        // list minus the merged-away owner — which mergeUsersInto excludes
        // explicitly — in the same createdAt/login order.
        const emailUsers = yield* verifiedEmailUsers(profile);
        const target = yield* linkTarget(profile, owner, emailUsers, options?.currentUser);
        if (Option.isNone(target)) {
          const login = yield* nextAvailableLogin(loginBaseFromProfile(profile));
          const user = yield* repository.createUserWithAccount({ account: profile, login });
          return yield* mintSession(user);
        }

        const user = yield* repository.linkAccount(target.value, profile);
        const merged = yield* mergeUsersInto(
          user,
          emailUsers,
          Option.getOrUndefined(Option.map(owner, (existing) => existing.id)),
        );
        return yield* mintSession(merged);
      },
      (effect) => Effect.catchTag(effect, "DatabaseError", Effect.die),
    ),
    resolveSession: Effect.fn("AuthService.resolveSession")(function* (rawToken) {
      const id = yield* sha256Hex(rawToken);
      return yield* repository.findSessionUser(id, new Date()).pipe(Effect.orDie);
    }),
    signOut: Effect.fn("AuthService.signOut")(function* (rawToken) {
      const id = yield* sha256Hex(rawToken);
      yield* repository.deleteSession(id).pipe(Effect.orDie);
    }),
    listAccounts: Effect.fn("AuthService.listAccounts")(function* (userId) {
      return yield* repository.listAccounts(userId).pipe(Effect.orDie);
    }),
  });

  /**
   * The user a provider identity attaches to; none means a brand-new user.
   * When the identity already belongs to a different user than the target,
   * that owner is merged into the target first.
   */
  function linkTarget(
    profile: OAuthProfile,
    owner: Option.Option<AuthUser>,
    emailUsers: readonly AuthUser[],
    currentUser: AuthUser | undefined,
  ) {
    return Effect.gen(function* () {
      if (Option.isNone(owner)) {
        if (currentUser !== undefined) {
          return Option.some(currentUser.id);
        }

        return firstRow(emailUsers).pipe(Option.map((user) => user.id));
      }

      let target: AuthUser;
      if (currentUser !== undefined && currentUser.id !== owner.value.id) {
        // Linking someone else's identity is only allowed when both users
        // share this verified email — i.e. they are the same person.
        const emailUserIds = new Set(emailUsers.map((user) => user.id));
        if (!emailUserIds.has(owner.value.id) || !emailUserIds.has(currentUser.id)) {
          return yield* Effect.fail(new AccountLinkConflict({ provider: profile.provider }));
        }
        target = currentUser;
      } else {
        target = emailUsers[0] ?? owner.value;
      }

      if (target.id !== owner.value.id) {
        yield* repository.mergeUsers({ sourceUserId: owner.value.id, targetUserId: target.id });
      }
      return Option.some(target.id);
    });
  }

  function verifiedEmailUsers(profile: OAuthProfile) {
    const email = profile.emailVerified ? profile.email : null;
    if (email === null) {
      return Effect.succeed([]);
    }

    return Effect.gen(function* () {
      const users = yield* repository.findUsersByVerifiedEmail(email);
      return [...new Map(users.map((user) => [user.id, user])).values()];
    });
  }

  /** Folds every verified-email user (except the target and an already
   * merged-away user) into `target`, in createdAt/login order. */
  function mergeUsersInto(
    target: AuthUser,
    emailUsers: readonly AuthUser[],
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

export {
  AccountLinkConflict,
  AuthRepository,
  AuthService,
  makeAuthService,
  SESSION_TTL_MS,
  UserRecordMissing,
};

export type { AuthRepositoryShape, AuthServiceShape, OAuthProfile };
