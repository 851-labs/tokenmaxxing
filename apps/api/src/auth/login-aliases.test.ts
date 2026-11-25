import { Effect, Exit, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { GitHubAccounts } from "../oauth/github";
import { buildService } from "../testing/effect";
import { seedAccount, seedLoginAlias, seedUser } from "../testing/seed";
import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { AuthRepositoryLive } from "./d1";
import {
  AuthRepository,
  AuthService,
  GITHUB_LOGIN_CHECK_INTERVAL_MS,
  makeAuthService,
  type OAuthProfile,
} from "./service";

/**
 * Login history against the real schema: the rename batch, the alias
 * triggers and the daily GitHub check claim, as D1 runs them.
 */

let database: TestDatabase;

beforeEach(() => {
  database = makeTestDatabase();
});

afterEach(() => database.close());

function makeRepository() {
  return buildService(
    AuthRepository,
    AuthRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
  );
}

function makeService(github: GitHubAccounts["Service"]) {
  return buildService(
    AuthService,
    Layer.effect(AuthService, makeAuthService()).pipe(
      Layer.provide([
        AuthRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
        Layer.succeed(GitHubAccounts, github),
      ]),
    ),
  );
}

function aliases() {
  return database.sqlite
    .prepare("select login, user_id as userId from login_aliases order by login")
    .all();
}

function loginOf(userId: string) {
  return database.sqlite.prepare("select login from users where id = ?").get(userId)?.login;
}

function githubLoginOf(providerAccountId: string) {
  return database.sqlite
    .prepare(
      "select login from user_accounts where provider = 'github' and provider_account_id = ?",
    )
    .get(providerAccountId)?.login;
}

const githubProfile: OAuthProfile = {
  avatarUrl: null,
  email: null,
  emailVerified: false,
  login: "newcomer",
  name: null,
  provider: "github",
  providerAccountId: "999",
};

describe("D1 renameUser", () => {
  beforeEach(() => {
    seedUser(database.sqlite, { id: "alex", login: "alex" });
    seedAccount(database.sqlite, { login: "alex", providerAccountId: "1", userId: "alex" });
  });

  it("renames, records the old login and stores the GitHub login in one batch", async () => {
    const repository = await makeRepository();

    const renamed = await Effect.runPromise(
      repository.renameUser({
        from: "alex",
        githubAccount: { login: "Alex-Dev", providerAccountId: "1" },
        to: "alex-dev",
        userId: "alex",
      }),
    );

    expect(Option.map(renamed, (user) => user.login)).toEqual(Option.some("alex-dev"));
    expect(aliases()).toEqual([{ login: "alex", userId: "alex" }]);
    expect(githubLoginOf("1")).toBe("Alex-Dev");
  });

  it("changes nothing when the login already moved on (compare-and-swap)", async () => {
    const repository = await makeRepository();
    const rename = (to: string) =>
      repository.renameUser({
        from: "alex",
        githubAccount: { login: to, providerAccountId: "1" },
        to,
        userId: "alex",
      });

    // Two checks that both read "alex" before either wrote; D1 runs their
    // batches one after the other.
    const first = await Effect.runPromise(rename("alex-one"));
    const second = await Effect.runPromise(rename("alex-two"));

    expect(Option.isSome(first)).toBe(true);
    expect(Option.isNone(second)).toBe(true);
    expect(loginOf("alex")).toBe("alex-one");
    expect(githubLoginOf("1")).toBe("alex-one");
    expect(aliases()).toEqual([{ login: "alex", userId: "alex" }]);
  });

  it("fails with LoginTaken, writing nothing, when the login was claimed meanwhile", async () => {
    seedUser(database.sqlite, { id: "taker", login: "alex-dev" });
    seedUser(database.sqlite, { id: "former", login: "frank-new" });
    seedLoginAlias(database.sqlite, "frank", "former");
    const repository = await makeRepository();

    const onCurrent = await Effect.runPromiseExit(
      repository.renameUser({ from: "alex", to: "alex-dev", userId: "alex" }),
    );
    const onAlias = await Effect.runPromiseExit(
      repository.renameUser({ from: "alex", to: "frank", userId: "alex" }),
    );
    const onAliasOtherCase = await Effect.runPromiseExit(
      repository.renameUser({ from: "alex", to: "Frank", userId: "alex" }),
    );

    for (const exit of [onCurrent, onAlias, onAliasOtherCase]) {
      expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
        error: { _tag: "LoginTaken" },
      });
    }
    expect(loginOf("alex")).toBe("alex");
    expect(aliases()).toEqual([{ login: "frank", userId: "former" }]);
  });

  it("lets a user take back their own old login", async () => {
    seedLoginAlias(database.sqlite, "alex-old", "alex");
    const repository = await makeRepository();

    await Effect.runPromise(
      repository.renameUser({ from: "alex", to: "alex-old", userId: "alex" }),
    );

    expect(loginOf("alex")).toBe("alex-old");
    expect(aliases()).toEqual([{ login: "alex", userId: "alex" }]);
  });
});

describe("D1 alias reservation", () => {
  beforeEach(() => {
    seedUser(database.sqlite, { id: "alex", login: "alex-dev" });
    seedLoginAlias(database.sqlite, "alex", "alex");
  });

  it("rejects a new user holding someone's old login, whatever its case", async () => {
    const repository = await makeRepository();

    const exact = await Effect.runPromiseExit(
      repository.createUserWithAccount({ account: githubProfile, login: "alex" }),
    );
    const cased = await Effect.runPromiseExit(
      repository.createUserWithAccount({ account: githubProfile, login: "ALEX" }),
    );

    expect(Exit.isFailure(exact)).toBe(true);
    expect(Exit.isFailure(cased)).toBe(true);
    expect(database.sqlite.prepare("select count(*) as count from users").get()?.count).toBe(1);
  });

  it("counts aliases as taken, except the owner's own", async () => {
    seedUser(database.sqlite, { id: "other", login: "alex-2" });
    const repository = await makeRepository();

    const forSignup = await Effect.runPromise(repository.listLoginsLike("alex"));
    const forOwner = await Effect.runPromise(repository.listLoginsLike("alex", "alex"));

    expect(forSignup.sort()).toEqual(["alex", "alex-2", "alex-dev"]);
    expect(forOwner).toEqual(["alex-2"]);
  });

  it("gives a signup the next free login past an alias", async () => {
    const service = await makeService({ currentLogin: () => Effect.succeedNone });

    const signedIn = await Effect.runPromise(
      service.signInWithProvider({ ...githubProfile, login: "Alex" }),
    );

    expect(signedIn.user.login).toBe("alex-2");
  });
});

describe("D1 GitHub login checks", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const dayAgo = new Date(now.getTime() - GITHUB_LOGIN_CHECK_INTERVAL_MS);

  beforeEach(() => {
    seedUser(database.sqlite, { id: "alex", login: "alex" });
    seedAccount(database.sqlite, { login: "alex", providerAccountId: "1", userId: "alex" });
    seedAccount(database.sqlite, { provider: "google", providerAccountId: "g", userId: "alex" });
  });

  it("claims each GitHub account at most once a day", async () => {
    const repository = await makeRepository();

    const first = await Effect.runPromise(repository.claimGitHubLoginChecks("alex", dayAgo, now));
    const again = await Effect.runPromise(repository.claimGitHubLoginChecks("alex", dayAgo, now));
    const tomorrow = new Date(now.getTime() + GITHUB_LOGIN_CHECK_INTERVAL_MS);
    const nextDay = await Effect.runPromise(
      repository.claimGitHubLoginChecks("alex", now, tomorrow),
    );

    expect(first).toEqual([{ login: "alex", providerAccountId: "1" }]);
    expect(again).toEqual([]);
    expect(nextDay).toEqual([{ login: "alex", providerAccountId: "1" }]);
  });

  it("counts a sign-in as today's check", async () => {
    const repository = await makeRepository();
    await Effect.runPromise(
      repository.linkAccount("alex", { ...githubProfile, login: "alex", providerAccountId: "1" }),
    );

    const claimed = await Effect.runPromise(
      repository.claimGitHubLoginChecks("alex", new Date(Date.now() - 1000), new Date()),
    );

    expect(claimed).toEqual([]);
  });

  it("follows a rename once, however many CLI requests race for the check", async () => {
    const lookups: string[] = [];
    const service = await makeService({
      currentLogin: (accountId) =>
        Effect.sync(() => {
          lookups.push(accountId);
          return Option.some("Alex-Dev");
        }),
    });

    await Effect.runPromise(
      Effect.all([service.refreshGitHubLogin("alex"), service.refreshGitHubLogin("alex")], {
        concurrency: "unbounded",
      }),
    );

    expect(lookups).toEqual(["1"]);
    expect(loginOf("alex")).toBe("alex-dev");
    expect(githubLoginOf("1")).toBe("Alex-Dev");
    expect(aliases()).toEqual([{ login: "alex", userId: "alex" }]);
  });
});
