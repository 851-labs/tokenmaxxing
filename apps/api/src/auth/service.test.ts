import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { AuthUser, OAuthProviderId } from "@tokenmaxxing/api-contract";

import { AccountLinkConflict, AuthRepository, makeAuthService, type OAuthProfile } from "./service";
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

  it("follows a GitHub username change on the next sign-in", async () => {
    const { service, store } = await makeTestAuth();
    const first = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "alex" })),
    );

    const renamed = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "Alex-Dev" })),
    );

    expect(renamed.user.id).toBe(first.user.id);
    expect(renamed.user.login).toBe("alex-dev");
    expect(store.users.get(first.user.id)?.login).toBe("alex-dev");
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

  it("never renames onto a Google-made, differently cased or reserved login", async () => {
    const { service, store } = await makeTestAuth();
    const google = await Effect.runPromise(
      service.signInWithProvider(googleProfile({ email: "bob@example.com" })),
    );
    store.users.set("legacy", currentUser({ id: "legacy", login: "Carol" }));
    const github = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "gh@example.com", login: "alex" })),
    );

    const toBob = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ email: "gh@example.com", login: "bob" })),
    );
    // A second account renames from its own GitHub name, so each step starts clean.
    await Effect.runPromise(
      service.signInWithProvider(
        githubProfile({ email: "c@example.com", login: "dave", providerAccountId: "gh_2" }),
      ),
    );
    const toCarol = await Effect.runPromise(
      service.signInWithProvider(
        githubProfile({ email: "c@example.com", login: "carol", providerAccountId: "gh_2" }),
      ),
    );
    await Effect.runPromise(
      service.signInWithProvider(
        githubProfile({ email: "s@example.com", login: "erin", providerAccountId: "gh_3" }),
      ),
    );
    const toStats = await Effect.runPromise(
      service.signInWithProvider(
        githubProfile({ email: "s@example.com", login: "stats", providerAccountId: "gh_3" }),
      ),
    );

    expect(google.user.login).toBe("bob");
    expect(toBob.user).toMatchObject({ id: github.user.id, login: "bob-2" });
    expect(store.users.get(google.user.id)?.login).toBe("bob");
    expect(toCarol.user.login).toBe("carol-2");
    expect(toStats.user.login).not.toBe("stats");
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
  });

  it("ignores a GitHub username change that only changes case", async () => {
    const { service } = await makeTestAuth();
    await Effect.runPromise(service.signInWithProvider(githubProfile({ login: "alex" })));

    const result = await Effect.runPromise(
      service.signInWithProvider(githubProfile({ login: "ALEX" })),
    );

    expect(result.user.login).toBe("alex");
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

interface AccountRecord {
  profile: OAuthProfile;
  userId: string;
}

interface TestStore {
  accounts: Map<string, AccountRecord>;
  nextUser: number;
  sessions: { id: string; userId: string }[];
  users: Map<string, AuthUser>;
}

async function makeTestAuth() {
  const store: TestStore = {
    accounts: new Map(),
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
    listLoginsLike: (base) =>
      Effect.sync(() =>
        [...store.users.values()]
          .map((user) => user.login)
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
    renameUser: (userId, login) =>
      Effect.sync(() => {
        const user = store.users.get(userId);
        if (user === undefined) {
          throw new Error(`missing test user ${userId}`);
        }

        const renamed = { ...user, login };
        store.users.set(userId, renamed);
        return renamed;
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
  const service = await Effect.runPromise(
    makeAuthService().pipe(Effect.provideService(AuthRepository, repository)),
  );

  return { service, store };
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
