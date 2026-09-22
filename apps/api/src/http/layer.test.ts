import * as Http from "alchemy/Http";
import { Context, Effect, Layer, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { UserNotFound } from "@tokenmaxxing/api-contract";

import { AdminService } from "../admin/service";
import { SESSION_COOKIE } from "../auth/cookies";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig, type AppConfigShape } from "../config";
import { Drizzle } from "../database";
import { LeaderboardService } from "../leaderboard/service";
import { ProfilesService } from "../profiles/service";
import { StatsService } from "../stats/service";
import { makeTestApp, TEST_CORS_ORIGIN, type TestApp } from "../testing/http";
import { TokensService } from "../tokens/service";
import { UsageService } from "../usage/service";
import { makeApiFetch, makeApiHttpEffect } from "./layer";
import { AuthorizationLive } from "./middleware/authorization";
import { CliAuthLive } from "./middleware/cli-auth";

const config: AppConfigShape = {
  apiWorkerName: "tokenmaxxing-api",
  corsOrigins: ["https://tokenmaxxing.sh"],
  github: { clientId: "github-id", clientSecret: "github-secret" },
  google: { clientId: "google-id", clientSecret: "google-secret" },
  productName: "Tokenmaxxing",
};

describe("api router construction", () => {
  it("builds the layer graph once and reuses it across requests", async () => {
    const harness = makeHarness();
    const fetch = await buildFetch(harness);

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
    const fetch = makeApiHttpEffect(harness.options).pipe(
      Effect.map((httpEffect) => httpEffect.pipe(Effect.provide(harness.requestServices))),
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
    const fetch = await buildFetch(makeHarness());

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
    const fetch = await buildFetch(makeHarness());

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
    it("answers an unexpected defect with an opaque 500", async () => {
      app = await makeTestApp({
        stats: { getStats: () => Effect.die(new Error("D1 exploded: secret-table")) },
      });

      const response = await app.fetch(new Request("https://api.tokenmaxxing.sh/stats"));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
    });

    it("keeps schema decode failures as 400s", async () => {
      app = await makeTestApp();

      const response = await app.fetch(
        new Request("https://api.tokenmaxxing.sh/leaderboard?metric=bogus"),
      );

      expect(response.status).toBe(400);
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

function makeHarness() {
  let builds = 0;
  const appConfigLayer = Layer.effect(
    AppConfig,
    Effect.sync(() => {
      builds += 1;
      return config;
    }),
  );
  const auth = AuthService.of({
    ...stub(AuthService),
    resolveSession: () => Effect.succeedNone,
  });
  const leaderboard = LeaderboardService.of({ list: () => Effect.succeed([]) });
  const profiles = ProfilesService.of({
    getDaily: () =>
      Effect.succeed({ days: [], range: { first: "2026-01-01", last: "2026-09-22" } }),
    getIdentity: (login) =>
      login === "visible"
        ? Effect.succeed({ avatarUrl: null, login })
        : Effect.fail(new UserNotFound({ login })),
    getProfile: () => Effect.die("unused"),
  });
  const tokens = stub(TokensService);

  return {
    builds: () => builds,
    options: {
      adminServiceLayer: Layer.succeed(AdminService, stub(AdminService)),
      appConfigLayer,
      authServiceLayer: Layer.succeed(AuthService, auth),
      cliLoginServiceLayer: Layer.succeed(CliLoginService, stub(CliLoginService)),
      drizzleLayer: Layer.succeed(Drizzle, stub(Drizzle)),
      leaderboardServiceLayer: Layer.succeed(LeaderboardService, leaderboard),
      middlewareLayer: Layer.mergeAll(AuthorizationLive, CliAuthLive),
      profilesServiceLayer: Layer.succeed(ProfilesService, profiles),
      statsServiceLayer: Layer.succeed(StatsService, stub(StatsService)),
      tokensServiceLayer: Layer.succeed(TokensService, tokens),
      usageServiceLayer: Layer.succeed(UsageService, stub(UsageService)),
    },
    requestServices: Context.empty().pipe(
      Context.add(AppConfig, config),
      Context.add(AuthService, auth),
      Context.add(LeaderboardService, leaderboard),
      Context.add(ProfilesService, profiles),
      Context.add(TokensService, tokens),
    ),
  };
}

function buildFetch(harness: ReturnType<typeof makeHarness>) {
  return Effect.runPromise(
    makeApiFetch(harness.options, harness.requestServices).pipe(
      // Etag's layer wants a FileSystem; the worker gets one from alchemy's platform.
      Effect.provide(FileSystem.layerNoop({})),
    ),
  );
}

function apiRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.tokenmaxxing.sh${path}`, { headers });
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
