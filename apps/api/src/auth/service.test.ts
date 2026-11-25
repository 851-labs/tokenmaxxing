import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { AuthUser, OAuthProviderId } from "@tokenmaxxing/api-contract";

import { DatabaseError } from "../database";
import { GitHubAccounts, GitHubLookupFailed } from "../oauth/github";
import { makeTestLogger } from "../testing/logger";
import {
  AccountLinkConflict,
  AuthRepository,
  LoginTaken,
  makeAuthService,
  type OAuthProfile,
} from "./service";
import { UserId } from "@tokenmaxxing/api-contract";

describe("AuthService provider linking", () => {
  it("creates Google-only users from the verified email slug", async () => {
    const { service } = await makeTestAuth();

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "Alex+Work@example.com" })),
    );

    expect(result.user.login).toBe("alex-work");
  });

  it("adds a numeric suffix when a generated login is taken", async () => {
    const { service, store } = await makeTestAuth();
    store.users.set("existing", currentUser({ id: "existing", login: "alex" }));

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "alex@example.com" })),
    );

    expect(result.user.login).toBe("alex-2");
  });

  it("takes the lowest free suffix from one lookup of taken logins", async () => {
    const { service, store } = await makeTestAuth();
    for (const login of ["alex", "alex-2", "alex-3", "alex-5", "alexa-4"]) {
      store.users.set(login, currentUser({ id: login, login }));
    }

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "alex@example.com" })),
    );

    expect(result.user.login).toBe("alex-4");
  });

  it("never mints a login that a site route owns", async () => {
    const { service, store } = await makeTestAuth();
    store.users.set("stats-2", currentUser({ id: "stats-2", login: "stats-2" }));

    const stats = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "Stats", providerAccountId: "1" })),
    );
    const settings = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "settings@example.com" })),
    );

    expect(stats.user.login).toBe("stats-3");
    expect(settings.user.login).toBe("settings-2");
  });

  it("treats a taken login as taken whatever its case", async () => {
    const { service, store } = await makeTestAuth();
    store.users.set("legacy", currentUser({ id: "legacy", login: "Alex" }));

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "alex@example.com" })),
    );

    expect(result.user.login).toBe("alex-2");
  });

  it("auto-links a verified email when it belongs to exactly one existing user", async () => {
    const { service, store } = await makeTestAuth();
    const user = currentUser({ id: UserId.make("user_github"), login: "alex" });
    store.users.set(user.id, user);
    store.accounts.set(accountKey("github", "123"), {
      profile: githubProfile({ email: "alex@example.com", providerAccountId: "123" }),
      userId: user.id,
    });

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "alex@example.com" })),
    );

    expect(result.user.id).toBe(user.id);
    expect(store.accounts.get(accountKey("google", "google_123"))?.userId).toBe(user.id);
  });

  it("merges verified-email duplicates into the oldest matching user", async () => {
    const { service, store } = await makeTestAuth();
    const first = currentUser({ id: "first", login: "first" });
    const second = currentUser({ id: "second", login: "second" });
    store.users.set(first.id, first);
    store.users.set(second.id, second);
    store.accounts.set(accountKey("github", "first"), {
      profile: githubProfile({ email: "shared@example.com", providerAccountId: "first" }),
      userId: first.id,
    });
    store.accounts.set(accountKey("github", "second"), {
      profile: githubProfile({ email: "shared@example.com", providerAccountId: "second" }),
      userId: second.id,
    });

    const result = await Effect.runPromise(
      service.signInWithProvider(
        googleProfile({ email: "shared@example.com", providerAccountId: "google" }),
      ),
    );

    expect(result.user.id).toBe(first.id);
    expect(store.users.has(second.id)).toBe(false);
    expect(store.accounts.get(accountKey("github", "second"))?.userId).toBe(first.id);
    expect(store.accounts.get(accountKey("google", "google"))?.userId).toBe(first.id);
  });

  it("signs an existing provider duplicate into the oldest verified-email profile", async () => {
    const { service, store } = await makeTestAuth();
    const first = currentUser({ id: "first", login: "first" });
    const second = currentUser({ id: "second", login: "second" });
    store.users.set(first.id, first);
    store.users.set(second.id, second);
    store.accounts.set(accountKey("github", "github"), {
      profile: githubProfile({ email: "shared@example.com", providerAccountId: "github" }),
      userId: first.id,
    });
    store.accounts.set(accountKey("google", "google_123"), {
      profile: googleProfile({ email: "shared@example.com" }),
      userId: second.id,
    });

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "shared@example.com" })),
    );

    expect(result.user.id).toBe(first.id);
    expect(store.users.has(second.id)).toBe(false);
    expect(store.accounts.get(accountKey("google", "google_123"))?.userId).toBe(first.id);
  });

  it("links a new provider to the current session user", async () => {
    const { service, store } = await makeTestAuth();
    const user = currentUser({ id: "current", login: "current" });
    store.users.set(user.id, user);

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "new@example.com" }), {
        currentUser: user,
      }),
    );

    expect(result.user.id).toBe(user.id);
    expect(store.accounts.get(accountKey("google", "google_123"))?.userId).toBe(user.id);
  });

  it("rejects linking a provider account that belongs to another user", async () => {
    const { service, store } = await makeTestAuth();
    const current = currentUser({ id: "current", login: "current" });
    const other = currentUser({ id: "other", login: "other" });
    store.users.set(current.id, current);
    store.users.set(other.id, other);
    store.accounts.set(accountKey("google", "google_123"), {
      profile: googleProfile({ email: "other@example.com" }),
      userId: other.id,
    });

    await expect(
      Effect.runPromise(
        service.signInWithProvider(googleProfile({ email: "other@example.com" }), {
          currentUser: current,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountLinkConflict);
  });

  it("merges an existing provider duplicate into the current session user", async () => {
    const { service, store } = await makeTestAuth();
    const current = currentUser({ id: "current", login: "current" });
    const duplicate = currentUser({ id: "duplicate", login: "current-2" });
    store.users.set(current.id, current);
    store.users.set(duplicate.id, duplicate);
    store.accounts.set(accountKey("github", "github"), {
      profile: githubProfile({ email: "alex@example.com", providerAccountId: "github" }),
      userId: current.id,
    });
    store.accounts.set(accountKey("google", "google_123"), {
      profile: googleProfile({ email: "alex@example.com" }),
      userId: duplicate.id,
    });

    const result = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "alex@example.com" }), {
        currentUser: current,
      }),
    );

    expect(result.user.id).toBe(current.id);
    expect(store.users.has(duplicate.id)).toBe(false);
    expect(store.accounts.get(accountKey("google", "google_123"))?.userId).toBe(current.id);
  });
});

describe("AuthService GitHub rename on sign-in", () => {
  it("follows a GitHub username change and keeps the old login as an alias", async () => {
    const { service, store } = await makeTestAuth();
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );

    const renamed = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "Alex-Dev" })),
    );

    expect(renamed.user).toMatchObject({ id: first.user.id, login: "alex-dev" });
    expect(store.users.get(first.user.id)?.login).toBe("alex-dev");
    expect(store.aliases.get("alex")).toBe(first.user.id);
  });

  it("suffixes the new login when another user already holds it", async () => {
    const { service, store } = await makeTestAuth();
    store.users.set("squatter", currentUser({ id: "squatter", login: "alex-dev" }));
    await Effect.runPromise(service.signInWithProvider(githubProfile({ login: "alex" })));

    const renamed = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex-dev" })),
    );

    expect(renamed.user.login).toBe("alex-dev-2");
  });

  it("never renames onto a Google-made, differently cased, reserved or aliased login", async () => {
    const { service, store } = await makeTestAuth();
    const google = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "bob@example.com" })),
    );
    store.users.set("legacy", currentUser({ id: "legacy", login: "Carol" }));
    store.users.set("former", currentUser({ id: "former", login: "frank-new" }));
    store.aliases.set("frank", "former");
    const github = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "gh@example.com", login: "alex" })),
    );

    const toBob = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "gh@example.com", login: "bob" })),
    );
    // Each further account renames from its own GitHub name, so each step starts clean.
    const rename = async (id: string, from: string, to: string) => {
      const profile = { email: `${id}@example.com`, providerAccountId: id };
      await Effect.runPromise(
        service.signInWithProvider(githubProfile({ ...profile, login: from })),
      );
      return Effect.runPromise(
        service.signInWithProvider(githubProfile({ ...profile, login: to })),
      );
    };
    const toCarol = await rename("gh_2", "dave", "carol");
    const toStats = await rename("gh_3", "erin", "stats");
    const toFrank = await rename("gh_4", "gina", "frank");

    expect(google.user.login).toBe("bob");
    expect(toBob.user).toMatchObject({ id: github.user.id, login: "bob-2" });
    expect(store.users.get(google.user.id)?.login).toBe("bob");
    expect(toCarol.user.login).toBe("carol-2");
    expect(toStats.user.login).not.toBe("stats");
    expect(toFrank.user.login).toBe("frank-2");
    expect(store.aliases.get("frank")).toBe("former");
    const logins = [...store.users.values()].map((user) => user.login.toLowerCase());
    expect(new Set(logins).size).toBe(logins.length);
  });

  it("keeps a login that was not taken from the old GitHub username", async () => {
    const { service, store } = await makeTestAuth();
    store.users.set("other", currentUser({ id: "other", login: "alex" }));
    // Got "alex-2" at signup because "alex" was taken.
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "me@example.com", login: "alex" })),
    );

    const renamed = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "me@example.com", login: "alex-dev" })),
    );

    expect(first.user.login).toBe("alex-2");
    expect(renamed.user.login).toBe("alex-2");
    expect(store.aliases.size).toBe(0);
  });

  it("ignores a GitHub username change that only changes case", async () => {
    const { service, store } = await makeTestAuth();
    await Effect.runPromise(service.signInWithProvider(githubProfile({ login: "alex" })));

    const result = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "ALEX" })),
    );

    expect(result.user.login).toBe("alex");
    expect(store.aliases.size).toBe(0);
  });

  it("takes back the user's own old login when GitHub renames back", async () => {
    const { service, store } = await makeTestAuth();
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );
    await Effect.runPromise(service.signInWithProvider(githubProfile({ login: "alex-dev" })));

    const back = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );

    expect(back.user).toMatchObject({ id: first.user.id, login: "alex" });
    expect([...store.aliases]).toEqual([["alex-dev", first.user.id]]);
  });

  it("does not let another signup take an old login", async () => {
    const { service } = await makeTestAuth();
    const solo = { email: null, emailVerified: false };
    await Effect.runPromise(service.signInWithProvider(githubProfile(solo)));
    await Effect.runPromise(
      service.signInWithProvider(githubProfile({ ...solo, login: "alex-dev" })),
    );

    const newcomer = await Effect.runPromise(
      service.signInWithProvider(
        githubProfile({ ...solo, login: "Alex", providerAccountId: "github_999" }),
      ),
    );

    expect(newcomer.user.login).toBe("alex-2");
  });

  it("retries with a fresh pick when the free login is taken mid-rename", async () => {
    const { repository, service, store } = await makeTestAuth();
    await Effect.runPromise(service.signInWithProvider(githubProfile({ login: "alex" })));
    // The first availability read is stale: someone signs up as "alex-dev" right after it.
    const listLoginsLike = repository.listLoginsLike;
    let reads = 0;
    repository.listLoginsLike = (base, ownerId) =>
      listLoginsLike(base, ownerId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            reads += 1;
            if (reads === 1) {
              store.users.set("racer", currentUser({ id: "racer", login: "alex-dev" }));
            }
          }),
        ),
      );

    const renamed = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex-dev" })),
    );

    expect(renamed.user.login).toBe("alex-dev-2");
    expect(reads).toBe(2);
  });

  it("still signs in when the rename fails", async () => {
    const { repository, service } = await makeTestAuth();
    await Effect.runPromise(service.signInWithProvider(githubProfile({ login: "alex" })));
    repository.renameUser = () => Effect.fail(new DatabaseError({ cause: new Error("D1 down") }));
    const logs = makeTestLogger();

    const result = await Effect.runPromise(
      service
        .signInWithProvider(githubProfile({ login: "alex-dev" }))
        .pipe(Effect.provide(logs.layer)),
    );

    expect(result.user.login).toBe("alex");
    expect(logs.entries.map((entry) => entry.message)).toEqual([
      "GitHub rename follow failed on sign-in",
    ]);
  });
});

describe("AuthService.refreshGitHubLogin", () => {
  it("follows a rename by account id and stores the new GitHub login", async () => {
    const { githubLogins, service, store } = await makeTestAuth();
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );
    githubLogins.set("github_123", "alex-dev");

    await Effect.runPromise(service.refreshGitHubLogin(first.user.id));

    expect(store.users.get(first.user.id)?.login).toBe("alex-dev");
    expect(store.aliases.get("alex")).toBe(first.user.id);
    expect(store.accounts.get(accountKey("github", "github_123"))?.profile.login).toBe("alex-dev");
  });

  it("stores the new GitHub login without renaming a login it did not derive", async () => {
    const { githubLogins, service, store } = await makeTestAuth();
    const user = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "sam@example.com" })),
    );
    await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "sam@example.com", login: "alex" })),
    );
    githubLogins.set("github_123", "alex-dev");

    await Effect.runPromise(service.refreshGitHubLogin(user.user.id));

    expect(store.users.get(user.user.id)?.login).toBe("sam");
    expect(store.accounts.get(accountKey("github", "github_123"))?.profile.login).toBe("alex-dev");
  });

  it("keeps the stored GitHub login when the rename keeps losing, so it retries later", async () => {
    const { githubLogins, repository, service, store } = await makeTestAuth();
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );
    githubLogins.set("github_123", "alex-dev");
    repository.renameUser = ({ to }) => Effect.fail(new LoginTaken({ login: to }));
    const logs = makeTestLogger();

    await Effect.runPromise(
      service.refreshGitHubLogin(first.user.id).pipe(Effect.provide(logs.layer)),
    );

    expect(store.users.get(first.user.id)?.login).toBe("alex");
    expect(store.accounts.get(accountKey("github", "github_123"))?.profile.login).toBe("alex");
    expect(logs.entries.map((entry) => entry.message)).toEqual([
      "GitHub rename lost the race for a free login",
    ]);
  });

  it("degrades quietly when GitHub fails or rate-limits", async () => {
    const { githubFailures, service, store } = await makeTestAuth();
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );
    const logs = makeTestLogger();
    githubFailures.push(
      new GitHubLookupFailed({ reason: "rate-limited", status: 403 }),
      new GitHubLookupFailed({ reason: "status", status: 502 }),
    );

    for (let check = 0; check < 2; check += 1) {
      await Effect.runPromise(
        service.refreshGitHubLogin(first.user.id).pipe(Effect.provide(logs.layer)),
      );
    }

    expect(store.users.get(first.user.id)?.login).toBe("alex");
    expect(logs.entries.map((entry) => [entry.level, entry.message])).toEqual([
      ["Info", "GitHub login check rate-limited; retrying tomorrow"],
      ["Warn", "GitHub login check failed"],
    ]);
  });

  it("never fails, even when the database does", async () => {
    const { repository, service } = await makeTestAuth();
    repository.claimGitHubLoginChecks = () =>
      Effect.fail(new DatabaseError({ cause: new Error("D1 down") }));
    const logs = makeTestLogger();

    await Effect.runPromise(service.refreshGitHubLogin("anyone").pipe(Effect.provide(logs.layer)));

    expect(logs.entries.map((entry) => entry.message)).toEqual(["GitHub login check failed"]);
  });
});

interface AccountRecord {
  profile: OAuthProfile;
  userId: string;
}

interface TestStore {
  accounts: Map<string, AccountRecord>;
  /** Lowercased old login → owner id. */
  aliases: Map<string, string>;
  nextUser: number;
  sessions: { id: string; userId: string }[];
  users: Map<string, AuthUser>;
}

async function makeTestAuth() {
  const store: TestStore = {
    accounts: new Map(),
    aliases: new Map(),
    nextUser: 1,
    sessions: [],
    users: new Map(),
  };
  const repository = AuthRepository.of({
    createUserWithAccount: ({ account, login }) =>
      Effect.sync(() => {
        const user = currentUser({
          avatarUrl: account.avatarUrl,
          id: `user_${store.nextUser++}`,
          login,
          name: account.name,
        });
        store.users.set(user.id, user);
        store.accounts.set(accountKey(account.provider, account.providerAccountId), {
          profile: account,
          userId: user.id,
        });
        return user;
      }),
    findAccountUser: (provider, providerAccountId) =>
      Effect.sync(() => {
        const account = store.accounts.get(accountKey(provider, providerAccountId));
        const user = account === undefined ? undefined : store.users.get(account.userId);

        return user === undefined ? Option.none() : Option.some(user);
      }),
    findUserById: (userId) =>
      Effect.sync(() => {
        const user = store.users.get(userId);
        return user === undefined ? Option.none() : Option.some(user);
      }),
    findUsersByVerifiedEmail: (email) =>
      Effect.sync(() =>
        [...store.accounts.values()].flatMap((account) => {
          if (account.profile.email !== email || !account.profile.emailVerified) {
            return [];
          }

          const user = store.users.get(account.userId);
          return user === undefined ? [] : [user];
        }),
      ),
    insertSession: ({ id, userId }) =>
      Effect.sync(() => {
        store.sessions.push({ id, userId });
      }),
    listLoginsLike: (base, ownerId) =>
      Effect.sync(() =>
        [
          ...[...store.users.values()]
            .filter((user) => user.id !== ownerId)
            .map((user) => user.login),
          ...[...store.aliases].filter(([, userId]) => userId !== ownerId).map(([login]) => login),
        ]
          // Case-insensitive, like the D1 repository's LIKE.
          .filter((login) => {
            const lower = login.toLowerCase();
            return lower === base || lower.startsWith(`${base}-`);
          }),
      ),
    linkAccount: (userId, profile) =>
      Effect.sync(() => {
        const user = store.users.get(userId);
        if (user === undefined) {
          throw new Error(`missing test user ${userId}`);
        }

        store.accounts.set(accountKey(profile.provider, profile.providerAccountId), {
          profile,
          userId,
        });
        return user;
      }),
    listAccounts: (userId) =>
      Effect.sync(() =>
        [...store.accounts.values()]
          .filter((account) => account.userId === userId)
          .map(({ profile }) => profile),
      ),
    renameUser: ({ from, githubAccount, to, userId }) =>
      Effect.suspend(() => {
        const user = store.users.get(userId);
        if (user?.login !== from) {
          return Effect.succeed(Option.none());
        }
        const lower = to.toLowerCase();
        const holder = store.aliases.get(lower);
        const taken = [...store.users.values()].some(
          (other) => other.id !== userId && other.login === to,
        );
        if (taken || (holder !== undefined && holder !== userId)) {
          return Effect.fail(new LoginTaken({ login: to }));
        }

        store.aliases.set(from.toLowerCase(), userId);
        store.aliases.delete(lower);
        if (githubAccount !== undefined) {
          const account = store.accounts.get(accountKey("github", githubAccount.providerAccountId));
          if (account !== undefined) {
            account.profile = { ...account.profile, login: githubAccount.login };
          }
        }
        const renamed = { ...user, login: to };
        store.users.set(userId, renamed);
        return Effect.succeed(Option.some(renamed));
      }),
    claimGitHubLoginChecks: (userId) =>
      Effect.sync(() =>
        [...store.accounts.values()]
          .filter((account) => account.userId === userId && account.profile.provider === "github")
          .map(({ profile }) => ({
            login: profile.login,
            providerAccountId: profile.providerAccountId,
          })),
      ),
    setGitHubAccountLogin: (providerAccountId, login) =>
      Effect.sync(() => {
        const account = store.accounts.get(accountKey("github", providerAccountId));
        if (account !== undefined) {
          account.profile = { ...account.profile, login };
        }
      }),
    mergeUsers: ({ sourceUserId, targetUserId }) =>
      Effect.sync(() => {
        const target = store.users.get(targetUserId);
        if (target === undefined) {
          throw new Error(`missing test user ${targetUserId}`);
        }

        for (const account of store.accounts.values()) {
          if (account.userId === sourceUserId) {
            account.userId = targetUserId;
          }
        }
        for (const session of store.sessions) {
          if (session.userId === sourceUserId) {
            session.userId = targetUserId;
          }
        }
        store.users.delete(sourceUserId);

        return target;
      }),
    findSessionUser: (sessionId) =>
      Effect.sync(() => {
        const session = store.sessions.find((entry) => entry.id === sessionId);
        const user = session === undefined ? undefined : store.users.get(session.userId);

        return user === undefined ? Option.none() : Option.some(user);
      }),
    deleteSession: (sessionId) =>
      Effect.sync(() => {
        store.sessions = store.sessions.filter((entry) => entry.id !== sessionId);
      }),
  });
  const githubLogins = new Map<string, string>();
  /** Failures the next GitHub lookups return, in order. */
  const githubFailures: GitHubLookupFailed[] = [];
  // Mutable, so a test can swap one method for a racing or failing version;
  // the service calls through this object.
  const mutableRepository: { -readonly [K in keyof typeof repository]: (typeof repository)[K] } = {
    ...repository,
  };
  const service = await Effect.runPromise(
    makeAuthService().pipe(
      Effect.provideService(AuthRepository, delegating(mutableRepository)),
      Effect.provideService(GitHubAccounts, {
        currentLogin: (accountId) => {
          const failure = githubFailures.shift();
          return failure === undefined
            ? Effect.succeed(Option.fromUndefinedOr(githubLogins.get(accountId)))
            : Effect.fail(failure);
        },
      }),
    ),
  );

  return { githubFailures, githubLogins, repository: mutableRepository, service, store };
}

/** A repository that looks each method up on `target` at call time. */
function delegating<S extends object>(target: S): S {
  return new Proxy(target, {
    get: (object, property) => {
      const value = object[property as keyof S];
      return typeof value === "function" ? (...args: unknown[]) => value(...args) : value;
    },
  });
}

function currentUser(input: {
  avatarUrl?: string | null;
  id: string;
  login: string;
  name?: string | null;
}): AuthUser {
  return {
    avatarUrl: input.avatarUrl ?? null,
    id: UserId.make(input.id),
    login: input.login,
    name: input.name ?? null,
  };
}

function githubProfile(input: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    avatarUrl: null,
    email: "alex@example.com",
    emailVerified: true,
    login: "alex",
    name: null,
    provider: "github",
    providerAccountId: "github_123",
    ...input,
  };
}

function googleProfile(input: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    avatarUrl: null,
    email: "alex@example.com",
    emailVerified: true,
    login: null,
    name: null,
    provider: "google",
    providerAccountId: "google_123",
    ...input,
  };
}

function accountKey(provider: OAuthProviderId, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}
