import * as Http from "alchemy/Http";
import { Context, Effect, Layer, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { UserNotFound } from "@tokenmaxxing/api-contract";

import { AdminService } from "../admin/service";
import { SESSION_COOKIE } from "../auth/cookies";
import { sha256Hex } from "../auth/crypto";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig, type AppConfigShape } from "../config";
import { LeaderboardService } from "../leaderboard/service";
import { OAuthProviders } from "../oauth/registry";
import { ProfilesService } from "../profiles/service";
import { ServicesLive } from "../services";
import { StatsService } from "../stats/service";
import { makeTestApp, TEST_CORS_ORIGIN, type TestApp } from "../testing/http";
import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { TokensService } from "../tokens/service";
import { RawUsageObjectStore } from "../usage/raw-store";
import { UsageService } from "../usage/service";
import { makeApiFetch, makeApiHttpEffect } from "./layer";

const config: AppConfigShape = {
  adminEmails: [],
  apiWorkerName: "tokenmaxxing-api",
  corsOrigins: ["https://tokenmaxxing.sh"],
  github: { clientId: "github-id", clientSecret: "github-secret" },
  google: { clientId: "google-id", clientSecret: "google-secret" },
  productName: "Tokenmaxxing",
};

describe("api router construction", () => {
  it("builds the layer graph once and reuses it across requests", async () => {
    const harness = makeHarness();
    const fetch = await buildFetch(harness.services);

    expect(harness.builds()).toBe(1);

    for (let index = 0; index < 3; index += 1) {
      const response = await serve(fetch, apiRequest("/health"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        product: "Tokenmaxxing",
        service: "tokenmaxxing-api",
      });
    }

    expect(harness.builds()).toBe(1);
  });

  it("documents the regression: an Effect-valued fetch rebuilds per request", async () => {
    const harness = makeHarness();
    // The previous worker wiring: alchemy re-runs this outer Effect per hit.
    const fetch = makeApiHttpEffect(harness.services).pipe(
      Effect.provide(FileSystem.layerNoop({})),
    );

    for (let index = 0; index < 3; index += 1) {
      await serve(fetch, apiRequest("/health"));
    }

    expect(harness.builds()).toBe(3);
  });
});

describe("api cache headers", () => {
  it("marks viewer-independent public reads as shared-cacheable", async () => {
    const fetch = await buildFetch(makeHarness().services);

    const leaderboard = await serve(fetch, apiRequest("/leaderboard"));
    const identity = await serve(fetch, apiRequest("/profiles/visible/identity"));

    expect(leaderboard.status).toBe(200);
    expect(leaderboard.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    expect(identity.status).toBe(200);
    expect(identity.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("never marks failures or credentialed profile reads as shareable", async () => {
    const fetch = await buildFetch(makeHarness().services);

    const missing = await serve(fetch, apiRequest("/profiles/missing/identity"));
    const anonymous = await serve(fetch, apiRequest("/profiles/visible/daily"));
    const signedIn = await serve(
      fetch,
      apiRequest("/profiles/visible/daily", { cookie: `${SESSION_COOKIE}=session-token` }),
    );
    const health = await serve(fetch, apiRequest("/health"));

    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBeNull();
    expect(anonymous.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
    expect(health.headers.get("cache-control")).toBeNull();
  });
});

describe("API HTTP responses", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("CORS", () => {
    it("allows the trace-context and auth headers the web client sends", async () => {
      app = await makeTestApp();
      const requestedHeaders = [
        "authorization",
        "b3",
        "content-type",
        "traceparent",
        "tracestate",
        "x-request-id",
      ];

      const response = await app.fetch(
        new Request("https://api.tokenmaxxing.sh/me", {
          headers: {
            "access-control-request-headers": requestedHeaders.join(","),
            "access-control-request-method": "GET",
            origin: TEST_CORS_ORIGIN,
          },
          method: "OPTIONS",
        }),
      );

      expect(response.status).toBeLessThan(300);
      expect(response.headers.get("access-control-allow-origin")).toBe(TEST_CORS_ORIGIN);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      const allowedHeaders = (response.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase());
      expect(allowedHeaders).toEqual(expect.arrayContaining(requestedHeaders));
    });

    it("does not grant unknown origins", async () => {
      app = await makeTestApp();

      const response = await app.fetch(
        new Request("https://api.tokenmaxxing.sh/me", {
          headers: {
            "access-control-request-method": "GET",
            origin: "https://evil.example",
          },
          method: "OPTIONS",
        }),
      );

      expect(response.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
    });
  });

  describe("defect recovery", () => {
    it("answers an unexpected defect with an opaque 500 and logs it", async () => {
      const defect = new Error("D1 exploded: secret-table");
      app = await makeTestApp({ stats: { getStats: () => Effect.die(defect) } });

      const response = await app.fetch(new Request("https://api.tokenmaxxing.sh/stats"));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
      expect(app.logs.entries).toEqual([
        expect.objectContaining({ args: [defect], level: "Error", message: "request died" }),
      ]);
    });

    it("keeps schema decode failures as 400s", async () => {
      app = await makeTestApp();

      const response = await app.fetch(
        new Request("https://api.tokenmaxxing.sh/leaderboard?metric=bogus"),
      );

      expect(response.status).toBe(400);
      expect(app.logs.entries).toEqual([]);
    });
  });

  it("echoes the caller's x-request-id", async () => {
    app = await makeTestApp();

    const response = await app.fetch(
      new Request("https://api.tokenmaxxing.sh/health", { headers: { "x-request-id": "req-1" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-1");
  });
});

/**
 * Wiring smoke test: the real ServicesLive over a migrated in-memory D1,
 * served through the same build-once path the worker uses.
 */
describe("api wiring over real services", () => {
  let database: TestDatabase;
  let fetch: Effect.Effect<unknown, unknown, any>;

  beforeEach(async () => {
    database = makeTestDatabase();
    database.sqlite.exec(
      "insert into users (id, login, created_at, updated_at) values ('user_1', 'alex', 0, 0);",
    );
    fetch = await buildFetch(
      ServicesLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AppConfig, config),
            database.drizzleLayer,
            RawUsageObjectStore.layer({ delete: () => Effect.void, put: () => Effect.void }),
          ),
        ),
      ),
    );
  });

  afterEach(() => database.sqlite.close());

  it("guards session endpoints and resolves the session cookie", async () => {
    const anonymous = await serve(fetch, apiRequest("/me"));
    expect(anonymous.status).toBe(401);

    const token = "session-token";
    database.sqlite
      .prepare("insert into sessions (id, user_id, expires_at, created_at) values (?, ?, ?, 0)")
      .run(await Effect.runPromise(sha256Hex(token)), "user_1", Date.now() + 60_000);

    const signedIn = await serve(
      fetch,
      apiRequest("/me", { cookie: `${SESSION_COOKIE}=${token}` }),
    );
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({
      user: { avatarUrl: null, id: "user_1", login: "alex", name: null },
    });
  });

  it("serves raw OAuth routes from the provider registry", async () => {
    for (const [provider, host] of [
      ["github", "github.com"],
      ["google", "accounts.google.com"],
    ] as const) {
      const response = await serve(fetch, apiRequest(`/auth/${provider}/start?redirect=/settings`));

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.host).toBe(host);
      expect(location.searchParams.get("client_id")).toBe(`${provider}-id`);
      expect(location.searchParams.get("redirect_uri")).toBe(
        `https://api.tokenmaxxing.sh/auth/${provider}/callback`,
      );
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    }
  });

  it("redirects OAuth callbacks whose state does not match to www login", async () => {
    const response = await serve(fetch, apiRequest("/auth/github/callback?code=c&state=s"));
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(302);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("oauth_state_mismatch");
  });

  it("clears the session cookie on sign-out", async () => {
    const response = await serve(
      fetch,
      new Request("https://api.tokenmaxxing.sh/auth/signout", {
        headers: { cookie: `${SESSION_COOKIE}=unknown`, host: "api.tokenmaxxing.sh" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
  });
});

/** Stub services; AppConfig counts how often the router graph is built. */
function makeHarness() {
  let builds = 0;
  const appConfigLayer = Layer.effect(
    AppConfig,
    Effect.sync(() => {
      builds += 1;
      return config;
    }),
  );
  const profiles = ProfilesService.of({
    getDaily: () =>
      Effect.succeed({ days: [], range: { first: "2026-01-01", last: "2026-09-22" } }),
    getIdentity: (login) =>
      login === "visible"
        ? Effect.succeed({ avatarUrl: null, login })
        : Effect.fail(new UserNotFound({ login })),
    getProfile: () => Effect.die("unused"),
  });

  return {
    builds: () => builds,
    services: Layer.mergeAll(
      appConfigLayer,
      Layer.succeed(AdminService, stub(AdminService)),
      Layer.succeed(
        AuthService,
        AuthService.of({ ...stub(AuthService), resolveSession: () => Effect.succeedNone }),
      ),
      Layer.succeed(CliLoginService, stub(CliLoginService)),
      Layer.succeed(LeaderboardService, LeaderboardService.of({ list: () => Effect.succeed([]) })),
      Layer.succeed(OAuthProviders, stub(OAuthProviders)),
      Layer.succeed(ProfilesService, profiles),
      Layer.succeed(StatsService, stub(StatsService)),
      Layer.succeed(TokensService, stub(TokensService)),
      Layer.succeed(UsageService, stub(UsageService)),
    ),
  };
}

function buildFetch(services: Parameters<typeof makeApiFetch>[0]) {
  return Effect.runPromise(
    makeApiFetch(services).pipe(
      // Etag's layer wants a FileSystem; the worker gets one from alchemy's platform.
      Effect.provide(FileSystem.layerNoop({})),
    ),
  );
}

function apiRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.tokenmaxxing.sh${path}`, {
    headers: { host: "api.tokenmaxxing.sh", ...headers },
    redirect: "manual",
  });
}

/** Services (or methods) these requests never touch. */
function stub<I, S>(_key: Context.Key<I, S>): S {
  return {} as S;
}

/**
 * Mirrors alchemy's per-request bridge: `safeHttpEffect` over the worker's
 * `fetch`, run through Effect's web handler (fresh scope, pre-response
 * handlers applied).
 */
function serve(fetch: Effect.Effect<unknown, unknown, any>, request: Request): Promise<Response> {
  const handler = HttpEffect.toWebHandler(
    Http.safeHttpEffect(fetch as Parameters<typeof Http.safeHttpEffect>[0]) as Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >,
  );
  return handler(request);
}
