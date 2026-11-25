import { Context, Data, Effect, Option } from "effect";

import { isReservedLogin } from "@tokenmaxxing/api-contract";
import type { AuthUser, OAuthProviderId, UserAccountSummary } from "@tokenmaxxing/api-contract";

import { type DatabaseError, firstRow } from "../database";
import { GitHubAccounts } from "../oauth/github";
import { generateToken, sha256Hex } from "./crypto";

/** A provider identity exactly as linking stores it on the account. */
type OAuthProfile = typeof UserAccountSummary.Type;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often CLI activity may re-check a user's GitHub login. */
const GITHUB_LOGIN_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Fresh free-login picks a rename tries before giving up until next time. */
const RENAME_ATTEMPTS = 3;

class AccountLinkConflict extends Data.TaggedError("AccountLinkConflict")<{
  readonly provider: OAuthProviderId;
}> {}

/** The login a rename picked was taken (or reserved as someone's alias)
 * between the availability check and the write. */
class LoginTaken extends Data.TaggedError("LoginTaken")<{
  readonly login: string;
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
  /**
   * Follows a GitHub rename for a user seen through the CLI, at most once a
   * day per user, so users who rarely sign in on the web converge too.
   * Never fails: a GitHub or database hiccup only logs.
   */
  refreshGitHubLogin(userId: string): Effect.Effect<void>;
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
  /**
   * Unavailable logins equal to `base` or of the form `${base}-…` (a
   * superset is fine): current logins and every alias. `ownerId`'s own
   * login and aliases are left out, since they stay theirs to take.
   */
  listLoginsLike(base: string, ownerId?: string): Effect.Effect<string[], DatabaseError>;
  linkAccount(userId: string, profile: OAuthProfile): Effect.Effect<AuthUser, DatabaseError>;
  listAccounts(userId: string): Effect.Effect<(typeof UserAccountSummary.Type)[], DatabaseError>;
  /**
   * Renames `userId` from `from` to `to` in one batch, recording `from` as an
   * alias (and releasing `to` if it was their own alias). Compare-and-swap:
   * none when the user's login is no longer `from`. With `githubAccount`,
   * that account's stored login is updated in the same batch, only if the
   * rename happens. Fails with LoginTaken when `to` was claimed meanwhile.
   */
  renameUser(input: {
    from: string;
    githubAccount?: { login: string; providerAccountId: string } | undefined;
    to: string;
    userId: string;
  }): Effect.Effect<Option.Option<AuthUser>, DatabaseError | LoginTaken>;
  /**
   * Claims the user's GitHub accounts whose login was last checked at or
   * before `staleBefore` by stamping them `now`, and returns them. A claim
   * is atomic, so concurrent CLI requests check an account once.
   */
  claimGitHubLoginChecks(
    userId: string,
    staleBefore: Date,
    now: Date,
  ): Effect.Effect<{ login: string | null; providerAccountId: string }[], DatabaseError>;
  /** Stores a GitHub account's current login without renaming anyone. */
  setGitHubAccountLogin(
    providerAccountId: string,
    login: string,
  ): Effect.Effect<void, DatabaseError>;
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
  const github = yield* GitHubAccounts;

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
        // Read before linkAccount overwrites the stored provider login.
        const previousLogin = yield* previousGitHubLogin(profile, owner);
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
        const renamed =
          previousLogin === null || profile.login === null
            ? merged
            : yield* followGitHubLogin(merged, {
                next: profile.login,
                previous: previousLogin,
                // linkAccount already stored the new GitHub login.
                storeOn: null,
              }).pipe(
                // A failed rename never fails the sign-in.
                Effect.catchCause((cause) =>
                  Effect.logWarning("GitHub rename follow failed on sign-in", cause).pipe(
                    Effect.as(merged),
                  ),
                ),
              );
        return yield* mintSession(renamed);
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
    refreshGitHubLogin: Effect.fn("AuthService.refreshGitHubLogin")(
      function* (userId) {
        const now = new Date();
        const accounts = yield* repository.claimGitHubLoginChecks(
          userId,
          new Date(now.getTime() - GITHUB_LOGIN_CHECK_INTERVAL_MS),
          now,
        );
        for (const account of accounts) {
          const current = yield* github
            .currentLogin(account.providerAccountId)
            .pipe(
              Effect.catchTag("GitHubLookupFailed", (error) =>
                (error.reason === "rate-limited"
                  ? Effect.logInfo("GitHub login check rate-limited; retrying tomorrow")
                  : Effect.logWarning("GitHub login check failed", error)
                ).pipe(Effect.as(Option.none<string>())),
              ),
            );
          if (Option.isNone(current) || current.value === account.login) {
            continue;
          }

          const user = yield* repository.findUserById(userId);
          if (Option.isNone(user)) {
            return;
          }
          yield* followGitHubLogin(user.value, {
            next: current.value,
            previous: account.login,
            storeOn: account.providerAccountId,
          });
        }
      },
      (effect) =>
        Effect.catchCause(effect, (cause) => Effect.logWarning("GitHub login check failed", cause)),
    ),
  });

  /** The GitHub login stored on this identity at its last sign-in, if any. */
  function previousGitHubLogin(profile: OAuthProfile, owner: Option.Option<AuthUser>) {
    if (profile.provider !== "github" || Option.isNone(owner)) {
      return Effect.succeed(null);
    }

    return repository
      .listAccounts(owner.value.id)
      .pipe(
        Effect.map(
          (accounts) =>
            accounts.find(
              (account) =>
                account.provider === "github" &&
                account.providerAccountId === profile.providerAccountId,
            )?.login ?? null,
        ),
      );
  }

  /**
   * Renames `user` after their GitHub login changed from `previous` to
   * `next`, but only while their login is still the one derived from
   * `previous`: a login that came from Google, got a suffix, or differs only
   * in case is left alone. The new login is the next free one built from
   * `next` (taken, aliased and reserved names get a suffix; the user's own
   * old logins are theirs to take back). `storeOn` names the GitHub account
   * whose stored login moves to `next`, together with the rename; when the
   * rename keeps losing a race, the stored login stays old so the next check
   * tries again.
   */
  function followGitHubLogin(
    user: AuthUser,
    input: { next: string; previous: string | null; storeOn: string | null },
  ) {
    return Effect.gen(function* () {
      const base = followedLoginBase(user.login, input.previous, input.next);
      const storeLogin =
        input.storeOn === null
          ? Effect.void
          : repository.setGitHubAccountLogin(input.storeOn, input.next);
      if (base === null) {
        yield* storeLogin;
        return user;
      }

      for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
        const login = yield* nextAvailableLogin(base, user.id);
        if (login === user.login) {
          yield* storeLogin;
          return user;
        }

        const renamed = yield* repository
          .renameUser({
            from: user.login,
            githubAccount:
              input.storeOn === null
                ? undefined
                : { login: input.next, providerAccountId: input.storeOn },
            to: login,
            userId: user.id,
          })
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("LoginTaken", () => Effect.succeed(Option.none())),
          );
        if (Option.isSome(renamed)) {
          if (Option.isSome(renamed.value)) {
            return renamed.value.value;
          }
          // The login moved on concurrently; whoever moved it decided.
          return Option.getOrElse(yield* repository.findUserById(user.id), () => user);
        }
      }

      yield* Effect.logWarning("GitHub rename lost the race for a free login", {
        base,
        userId: user.id,
      });
      return user;
    });
  }

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

  /**
   * `base`, else `base-2`, `base-3`, … — skipping taken, aliased and reserved
   * logins. `ownerId`'s own login and aliases count as free.
   */
  function nextAvailableLogin(base: string, ownerId?: string) {
    return Effect.gen(function* () {
      const taken = new Set(
        (yield* repository.listLoginsLike(base, ownerId)).map((login) => login.toLowerCase()),
      );
      for (let suffix = 1; suffix < 10_000; suffix += 1) {
        const candidate = suffix === 1 ? base : `${base}-${suffix}`;
        if (!taken.has(candidate) && !isReservedLogin(candidate)) {
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

/**
 * The login base a GitHub rename moves a user to, or null to leave them be:
 * only while their login is still the slug of the old GitHub login, and only
 * when the slug actually changes (not for a case-only rename).
 */
function followedLoginBase(
  currentLogin: string,
  previousGitHubLogin: string | null,
  nextGitHubLogin: string,
): string | null {
  if (previousGitHubLogin === null) {
    return null;
  }

  const previous = slugifyLogin(previousGitHubLogin);
  const next = slugifyLogin(nextGitHubLogin);
  return next === previous || currentLogin.toLowerCase() !== previous ? null : next;
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
  followedLoginBase,
  GITHUB_LOGIN_CHECK_INTERVAL_MS,
  LoginTaken,
  makeAuthService,
  SESSION_TTL_MS,
  UserRecordMissing,
};

export type { AuthRepositoryShape, AuthServiceShape, OAuthProfile };
