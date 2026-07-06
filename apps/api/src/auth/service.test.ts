import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Option } from "effect";

import {
  AuthRepository,
  makeAuthService,
  type CurrentUser,
  type OAuthProfile,
  type OAuthProviderId,
  type UserAccountSummary,
} from "./service";

describe("AuthService provider linking", () => {
  it("creates Google-only users from the verified email slug", async () => {
    const { service } = await makeTestAuth();

    const result = await runAuth(
      service.signInWithProvider(googleProfile({ email: "Alex+Work@example.com" })),
    );

    expect(result.user.login).toBe("alex-work");
  });

  it("adds a numeric suffix when a generated login is taken", async () => {
    const { service, store } = await makeTestAuth();
    store.users.set("existing", currentUser({ id: "existing", login: "alex" }));

    const result = await runAuth(
      service.signInWithProvider(googleProfile({ email: "alex@example.com" })),
    );

    expect(result.user.login).toBe("alex-2");
  });

  it("auto-links a verified email when it belongs to exactly one existing user", async () => {
    const { service, store } = await makeTestAuth();
    const user = currentUser({ id: "user_github", login: "alex" });
    store.users.set(user.id, user);
    store.accounts.set(accountKey("github", "123"), {
      profile: githubProfile({ email: "alex@example.com", providerAccountId: "123" }),
      userId: user.id,
    });

    const result = await runAuth(
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

    const result = await runAuth(
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

    const result = await runAuth(
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

    const result = await runAuth(
      service.signInWithProvider(googleProfile({ email: "new@example.com" }), {
        currentUser: user,
      }),
    );

    expect(result.user.id).toBe(user.id);
    expect(store.accounts.get(accountKey("google", "google_123"))?.userId).toBe(user.id);
  });

  it("merges a provider account owned by another profile into the current session user", async () => {
    const { service, store } = await makeTestAuth();
    const current = currentUser({ id: "current", login: "current" });
    const other = currentUser({ id: "other", login: "other" });
    store.users.set(current.id, current);
    store.users.set(other.id, other);
    store.accounts.set(accountKey("google", "google_123"), {
      profile: googleProfile({ email: "other@example.com" }),
      userId: other.id,
    });

    const result = await runAuth(
      service.signInWithProvider(googleProfile({ email: "other@example.com" }), {
        currentUser: current,
      }),
    );

    expect(result.user.id).toBe(current.id);
    expect(store.users.has(other.id)).toBe(false);
    expect(store.accounts.get(accountKey("google", "google_123"))?.userId).toBe(current.id);
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

    const result = await runAuth(
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
  users: Map<string, CurrentUser>;
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
    isLoginTaken: (login) =>
      Effect.sync(() => [...store.users.values()].some((user) => user.login === login)),
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
          .map(({ profile }) => toSummary(profile)),
      ),
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

function runAuth<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}

function currentUser(input: {
  avatarUrl?: string | null;
  id: string;
  login: string;
  name?: string | null;
}): CurrentUser {
  return {
    avatarUrl: input.avatarUrl ?? null,
    id: input.id,
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

function toSummary(profile: OAuthProfile): UserAccountSummary {
  return {
    avatarUrl: profile.avatarUrl,
    email: profile.email,
    emailVerified: profile.emailVerified,
    login: profile.login,
    name: profile.name,
    provider: profile.provider,
    providerAccountId: profile.providerAccountId,
  };
}
