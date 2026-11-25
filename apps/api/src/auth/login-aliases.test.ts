import { Effect, Exit, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { DatabaseError, Drizzle } from "../database";
import { GitHubAccounts } from "../oauth/github";
import { makeTestLogger } from "../testing/logger";
import { buildService } from "../testing/effect";
import { seedAccount, seedLoginAlias, seedUser } from "../testing/seed";
import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { AuthRepositoryLive, MAX_LOGIN_ALIASES } from "./d1";
import {
  AuthRepository,
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

function makeService(
  github: GitHubAccounts["Service"],
  overrides: Partial<AuthRepository["Service"]> = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* AuthRepository;
      return yield* makeAuthService().pipe(
        Effect.provideService(AuthRepository, AuthRepository.of({ ...live, ...overrides })),
        Effect.provideService(GitHubAccounts, github),
      );
    }).pipe(Effect.provide(AuthRepositoryLive.pipe(Layer.provide(database.drizzleLayer)))),
  );
}

/**
 * The repository over a Drizzle that runs `race` (raw SQL standing in for
 * another request) just before its `call`-th database round trip.
 */
async function makeRacingRepository(call: number, race: () => void) {
  const inner = await buildService(Drizzle, database.drizzleLayer);
  let calls = 0;
  const racing = Drizzle.of({
    use: (run) =>
      Effect.suspend(() => {
        calls += 1;
        if (calls === call) {
          race();
        }
        return inner.use(run);
      }),
  });

  return buildService(
    AuthRepository,
    AuthRepositoryLive.pipe(Layer.provide(Layer.succeed(Drizzle, racing))),
  );
}

function checkedAtOf(providerAccountId: string) {
  return database.sqlite
    .prepare(
      "select login_checked_at as checkedAt from user_accounts where provider = 'github' and provider_account_id = ?",
    )
    .get(providerAccountId)?.checkedAt;
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

describe("D1 alias cap", () => {
  it(`keeps a user's ${MAX_LOGIN_ALIASES} most recent old logins and releases the rest`, async () => {
    seedUser(database.sqlite, { id: "alex", login: "alex" });
    const repository = await makeRepository();
    const logins = ["alex", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    for (const [index, to] of logins.slice(1).entries()) {
      await Effect.runPromise(repository.renameUser({ from: logins[index]!, to, userId: "alex" }));
    }

    expect(aliases().map((alias) => alias.login)).toEqual(["a2", "a3", "a4", "a5", "a6"]);
    // A released login is free again.
    const signup = await Effect.runPromise(
      repository.createUserWithAccount({ account: githubProfile, login: "alex" }),
    );
    expect(signup.login).toBe("alex");
  });

  it("caps the surviving user after a merge, keeping the newest", async () => {
    seedUser(database.sqlite, { id: "source", login: "source" });
    seedUser(database.sqlite, { id: "target", login: "target" });
    for (const [index, login] of ["s1", "s2", "s3", "s4"].entries()) {
      seedLoginAlias(database.sqlite, login, "source", index + 1);
    }
    for (const [index, login] of ["t1", "t2", "t3"].entries()) {
      seedLoginAlias(database.sqlite, login, "target", index + 5);
    }
    const repository = await makeRepository();

    await Effect.runPromise(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "target" }),
    );

    expect(aliases()).toEqual(
      ["s4", "source", "t1", "t2", "t3"].map((login) => ({ login, userId: "target" })),
    );
  });
});

describe("D1 mergeUsers alias", () => {
  it("reserves the merged-away user's login as it is when the batch runs", async () => {
    seedUser(database.sqlite, { id: "source", login: "alex" });
    seedUser(database.sqlite, { id: "target", login: "target" });
    // Calls 1 and 2 read both users; the merge batch is call 3. A rename of
    // the source lands between those reads and the batch.
    const repository = await makeRacingRepository(3, () => {
      database.sqlite.exec(
        "update users set login = 'alex-dev' where id = 'source';" +
          "insert into login_aliases (login, user_id, created_at) values ('alex', 'source', 1);",
      );
    });

    await Effect.runPromise(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "target" }),
    );

    expect(aliases()).toEqual([
      { login: "alex", userId: "target" },
      { login: "alex-dev", userId: "target" },
    ]);
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

  it("lets the next check retry a rename that failed during sign-in", async () => {
    database.sqlite.exec("delete from user_accounts; delete from users;");
    const github = { currentLogin: () => Effect.succeed(Option.some("alex-dev")) };
    const healthy = await makeService(github);
    const signedUp = await Effect.runPromise(
      healthy.signInWithProvider({ ...githubProfile, login: "alex", providerAccountId: "1" }),
    );
    const failing = await makeService(github, {
      renameUser: () => Effect.fail(new DatabaseError({ cause: new Error("D1 down") })),
    });
    const logs = makeTestLogger();

    const signedIn = await Effect.runPromise(
      failing
        .signInWithProvider({ ...githubProfile, login: "alex-dev", providerAccountId: "1" })
        .pipe(Effect.provide(logs.layer)),
    );

    expect(signedIn.user.login).toBe("alex");
    // The old GitHub login is back and the check is due, so nothing is lost.
    expect(githubLoginOf("1")).toBe("alex");
    expect(checkedAtOf("1")).toBeNull();
    expect(logs.entries.map((entry) => entry.message)).toEqual([
      "GitHub rename follow failed on sign-in",
    ]);

    await Effect.runPromise(healthy.refreshGitHubLogin(signedUp.user.id));

    expect(loginOf(signedUp.user.id)).toBe("alex-dev");
    expect(githubLoginOf("1")).toBe("alex-dev");
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
