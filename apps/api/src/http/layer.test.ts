import * as Http from "alchemy/Http";
import { Cause, Context, Effect, Layer, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MIN_USAGE_DATE_KEY, UserNotFound } from "@tokenmaxxing/api-contract";

import { AdminService } from "../admin/service";
import { SESSION_COOKIE } from "../auth/cookies";
import { sha256Hex } from "../auth/crypto";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig, type AppConfigShape } from "../config";
import { LeaderboardService } from "../leaderboard/service";
import { OAuthProviders } from "../oauth/registry";
import { latestUsageDateKey } from "../date-keys";
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

describe("api error responses through the worker bridge", () => {
  it("lets browsers read error envelopes (CORS applies to them too)", async () => {
    // CORS headers ride on a pre-response handler, which only the web
    // handler applies, so this goes through `serve`, not makeTestApp.
    const fetch = await buildFetch(makeHarness().services);

    for (const [path, status] of [
      ["/leaderboard?metric=bogus", 400],
      ["/profiles/missing/identity", 404],
      ["/nope", 404],
      ["/me", 401],
    ] as const) {
      const response = await serve(
        fetch,
        apiRequest(path, { origin: "https://tokenmaxxing.sh", "x-request-id": "req-err" }),
      );

      expect({ path, status: response.status }).toEqual({ path, status });
      expect(response.headers.get("access-control-allow-origin")).toBe("https://tokenmaxxing.sh");
      expect(response.headers.get("x-request-id")).toBe("req-err");
      expect(await response.json()).toMatchObject({ _tag: expect.any(String) });
    }

    const tooLarge = await serve(
      fetch,
      new Request("https://api.tokenmaxxing.sh/cli/login/start", {
        body: "{}",
        headers: {
          "content-length": String(64 * 1024 + 1),
          "content-type": "application/json",
          host: "api.tokenmaxxing.sh",
          origin: "https://tokenmaxxing.sh",
          "x-request-id": "req-err",
        },
        method: "POST",
      }),
    );

    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get("access-control-allow-origin")).toBe("https://tokenmaxxing.sh");
    expect(tooLarge.headers.get("x-request-id")).toBe("req-err");
    expect(await tooLarge.json()).toMatchObject({ _tag: "PayloadTooLarge" });
  });

  it("scopes CORS on actual responses to the serving deployment", async () => {
    const fetch = await buildFetch(makeHarness().services);
    const devWww = "http://tokenmaxxing.localhost:3002";
    const request = (host: string) =>
      serve(fetch, new Request(`https://${host}/health`, { headers: { host, origin: devWww } }));

    const granted = await request("api.tokenmaxxing.localhost:8788");
    const refused = await request("api.tokenmaxxing.sh");

    expect(granted.status).toBe(200);
    expect(granted.headers.get("access-control-allow-origin")).toBe(devWww);
    expect(granted.headers.get("access-control-allow-credentials")).toBe("true");
    expect(refused.status).toBe(200);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(refused.headers.get("vary")).toContain("Origin");
  });
});

async function expectEnvelope(response: Response, status: number, tag: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("x-request-id")).toEqual(expect.any(String));
  const body = (await response.json()) as { _tag: string; message: string };
  expect(body).toEqual({ _tag: tag, message: expect.any(String) });
  return body;
}

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
      expect(allowedHeaders).toEqual(expect.arrayContaining(requestedHeaders)); // Browsers cache the preflight rather than repeating it per request.
      expect(response.headers.get("access-control-max-age")).toBe("7200");
    });

    const PROD_HOST = "api.tokenmaxxing.sh";
    const DEV_HOST = "api.tokenmaxxing.localhost:8788";
    const PROD_WWW = "https://tokenmaxxing.sh";
    const DEV_WWW = "http://tokenmaxxing.localhost:3002";

    function preflight(host: string, origin: string) {
      return new Request(`https://${host}/me`, {
        headers: { "access-control-request-method": "GET", host, origin },
        method: "OPTIONS",
      });
    }

    it.each([
      ["prod", PROD_HOST, PROD_WWW],
      ["dev", DEV_HOST, DEV_WWW],
      // The local dev provider proxies with a rewritten loopback Host.
      ["proxied dev", "127.0.0.1:8788", DEV_WWW],
    ])("grants the %s deployment's own www", async (_deployment, host, origin) => {
      app = await makeTestApp();

      const response = await app.fetch(preflight(host, origin));

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-max-age")).toBe("7200");
    });

    it.each([
      ["local dev www on the prod host", PROD_HOST, DEV_WWW],
      ["prod www on the dev host", DEV_HOST, PROD_WWW],
      ["another origin on the prod host", PROD_HOST, "https://evil.example"],
      ["another origin on the dev host", DEV_HOST, "https://evil.example"],
      ["a look-alike subdomain", PROD_HOST, "https://tokenmaxxing.sh.evil.example"],
      ["an opaque origin", PROD_HOST, "null"],
    ])("does not grant %s", async (_from, host, origin) => {
      app = await makeTestApp();

      const response = await app.fetch(preflight(host, origin));

      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("error envelope", () => {
    /** Every non-2xx answer: a JSON `{ _tag, message }` body with a request id. */
    function post(path: string, body: string | null, contentType = "application/json") {
      return new Request(`https://api.tokenmaxxing.sh${path}`, {
        body,
        headers: body === null ? {} : { "content-type": contentType },
        method: "POST",
      });
    }

    it("answers an unexpected defect with an opaque 500 and logs it", async () => {
      const defect = new Error("D1 exploded: secret-table");
      app = await makeTestApp({ stats: { getStats: () => Effect.die(defect) } });

      const response = await app.fetch(new Request("https://api.tokenmaxxing.sh/stats"));

      const body = await expectEnvelope(response, 500, "InternalServerError");
      expect(JSON.stringify(body)).not.toContain("secret-table");
      expect(app.logs.entries).toEqual([
        expect.objectContaining({ level: "Error", message: "request died" }),
      ]);
      expect(Cause.squash(app.logs.entries[0]!.cause)).toBe(defect);
    });

    it("answers a response the contract cannot encode with a 500, not a 400", async () => {
      app = await makeTestApp({
        stats: { getStats: () => Effect.succeed({ bogus: true } as never) },
      });

      const response = await app.fetch(new Request("https://api.tokenmaxxing.sh/stats"));

      await expectEnvelope(response, 500, "InternalServerError");
      expect(app.logs.entries).toEqual([
        expect.objectContaining({ level: "Error", message: "request died" }),
      ]);
    });

    it("answers a fault in a raw route with the same 500", async () => {
      // makeTestApp's OAuth registry is an unstubbed Proxy: the route dies.
      app = await makeTestApp();

      const response = await app.fetch(
        new Request("https://api.tokenmaxxing.sh/auth/github/start"),
      );

      await expectEnvelope(response, 500, "InternalServerError");
      expect(app.logs.entries).toEqual([
        expect.objectContaining({ level: "Error", message: "request died" }),
      ]);
    });

    it.each([
      ["/leaderboard?metric=bogus", "Invalid query parameter `metric`."],
      ["/leaderboard?window=forever", "Invalid query parameter `window`."],
      ["/profiles/alex/daily?since=2026-02-30", "Invalid query parameter `since`."],
      ["/profiles/alex/daily?until=tomorrow", "Invalid query parameter `until`."],
    ])("answers GET %s with a 400 naming the field", async (path, message) => {
      app = await makeTestApp();

      const response = await app.fetch(new Request(`https://api.tokenmaxxing.sh${path}`));

      expect(await expectEnvelope(response, 400, "BadRequest")).toEqual({
        _tag: "BadRequest",
        message,
      });
      expect(app.logs.entries).toEqual([]);
    });

    it.each([
      ["malformed JSON", "{", "Invalid request body."],
      ["an empty body", "", "Invalid request body."],
      ["null", "null", "Invalid request body."],
      ["an array", "[]", "Invalid request body."],
      ["a wrongly typed field", '{"deviceName":1,"flow":"device_code"}', expect.any(String)],
    ])("answers a CLI login start with %s with a 400", async (_name, body, message) => {
      app = await makeTestApp();

      const response = await app.fetch(post("/cli/login/start", body));

      expect(await expectEnvelope(response, 400, "BadRequest")).toEqual({
        _tag: "BadRequest",
        message,
      });
      expect(app.logs.entries).toEqual([]);
    });

    it("answers undeclared properties (the strict CLI re-decode) with a 400", async () => {
      app = await makeTestApp();

      const response = await app.fetch(
        post("/cli/login/poll", JSON.stringify({ deviceCode: "code", extra: true })),
      );

      const body = await expectEnvelope(response, 400, "BadRequest");
      expect(body.message).toMatch(/^Invalid request body/);
      expect(app.logs.entries).toEqual([]);
    });

    it("answers a non-JSON content-type with a 415", async () => {
      app = await makeTestApp();

      const response = await app.fetch(post("/cli/login/poll", "deviceCode=code", "text/plain"));

      await expectEnvelope(response, 415, "UnsupportedMediaType");
    });

    it("answers an unknown path with a 404", async () => {
      app = await makeTestApp();

      const response = await app.fetch(new Request("https://api.tokenmaxxing.sh/nope"));

      await expectEnvelope(response, 404, "RouteNotFound");
      expect(response.headers.get("allow")).toBeNull();
    });

    it("answers a path rejected for an over-long param with a 404, not a 405", async () => {
      app = await makeTestApp();

      // The router caps params at 100 chars; GET is still the right method.
      const response = await app.fetch(
        new Request(`https://api.tokenmaxxing.sh/profiles/${"a".repeat(101)}`),
      );

      await expectEnvelope(response, 404, "RouteNotFound");
      expect(response.headers.get("allow")).toBeNull();
    });

    it.each([
      ["GET", "/cli/login/poll", "POST"],
      ["DELETE", "/health", "GET, HEAD"],
      ["POST", "/profiles/alex", "GET, HEAD"],
      ["GET", "/auth/signout", "POST"],
      ["POST", "/auth/github/start", "GET, HEAD"],
      ["PUT", "/openapi.json", "GET, HEAD"],
    ])("answers %s %s with a 405 listing the allowed methods", async (method, path, allow) => {
      app = await makeTestApp();

      const response = await app.fetch(
        new Request(`https://api.tokenmaxxing.sh${path}`, { method }),
      );

      await expectEnvelope(response, 405, "MethodNotAllowed");
      expect(response.headers.get("allow")).toBe(allow);
    });
  });

  it("serves the anonymous profile view when the viewer lookup fails", async () => {
    const getIdentity = vi.fn((login: string, _viewerId: string | null) =>
      Effect.succeed({ avatarUrl: null, login }),
    );
    app = await makeTestApp({
      auth: { resolveSession: () => Effect.die(new Error("D1 down")) },
      profiles: { getIdentity },
    });

    const response = await app.fetch(
      new Request("https://api.tokenmaxxing.sh/profiles/alex/identity", {
        headers: { cookie: `${SESSION_COOKIE}=session-token` },
      }),
    );

    expect(response.status).toBe(200);
    expect(getIdentity).toHaveBeenCalledWith("alex", null);
    expect(app.logs.entries).toEqual([
      expect.objectContaining({
        level: "Warn",
        message: "viewer lookup failed; serving the anonymous view",
      }),
    ]);
  });

  it("echoes the caller's x-request-id", async () => {
    app = await makeTestApp();

    const response = await app.fetch(
      new Request("https://api.tokenmaxxing.sh/health", { headers: { "x-request-id": "req-1" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-1");
  });

  it("replaces an oversized or odd x-request-id with a minted one", async () => {
    app = await makeTestApp();

    for (const requestId of ["r".repeat(129), "has space", "<script>", "a/b", "caf\u00e9"]) {
      const response = await app.fetch(
        new Request("https://api.tokenmaxxing.sh/health", {
          headers: { "x-request-id": requestId },
        }),
      );

      const echoed = response.headers.get("x-request-id");
      expect(echoed).not.toBe(requestId);
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  describe("request body limits", () => {
    const start = (body: string, headers: Record<string, string> = {}) =>
      new Request("https://api.tokenmaxxing.sh/cli/login/start", {
        body,
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      });

    it("rejects a declared Content-Length over the limit without reading the body", async () => {
      app = await makeTestApp();

      const response = await app.fetch(start("{}", { "content-length": String(64 * 1024 + 1) }));

      expect(await expectEnvelope(response, 413, "PayloadTooLarge")).toEqual({
        _tag: "PayloadTooLarge",
        message: "Request body exceeds the 65536-byte limit.",
      });
    });

    it("caps bodies without a Content-Length while streaming them", async () => {
      app = await makeTestApp();

      const response = await app.fetch(start(JSON.stringify({ padding: "x".repeat(64 * 1024) })));

      await expectEnvelope(response, 413, "PayloadTooLarge");
    });

    it("passes bodies within the limit through to the handler", async () => {
      app = await makeTestApp({
        cliLogin: {
          start: () =>
            Effect.succeed({
              code: "ABCD-1234",
              expiresAt: "2026-06-21T18:10:00.000Z",
              intervalSeconds: 2,
              userCode: "ABCD-1234",
              verificationUri: "https://tokenmaxxing.sh/login/cli?code=ABCD-1234",
            }),
        },
      });
      const body = JSON.stringify({
        deviceId: "7d0f3a52-5f0a-4f39-9d7c-3b8f1c2a9e11",
        deviceName: "fixture-host",
        devicePlatform: "darwin",
      });

      const headerSets: Array<Record<string, string>> = [
        {},
        { "content-length": String(body.length) },
      ];
      for (const headers of headerSets) {
        expect((await app.fetch(start(body, headers))).status).toBe(200);
      }
    });

    it("lets usage uploads through well past the default limit", async () => {
      app = await makeTestApp();
      const upload = (headers: Record<string, string>) =>
        app!.fetch(
          new Request("https://api.tokenmaxxing.sh/usage/ingest", {
            body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
          }),
        );

      // Past the body limit, the request reaches CLI auth (401), not a 413.
      expect((await upload({})).status).toBe(401);
      expect((await upload({ "content-length": String(16 * 1024 * 1024 + 1) })).status).toBe(413);
    });
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

  it("finds profiles whatever the login's case", async () => {
    const response = await serve(fetch, apiRequest("/profiles/ALEX"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { login: "alex" } });
  });

  it("clamps profile daily ranges and rejects inverted ones as 400s", async () => {
    const ceiling = latestUsageDateKey(new Date());
    const absurd = await serve(
      fetch,
      apiRequest("/profiles/alex/daily?since=0001-01-01&until=9999-12-31"),
    );
    const inverted = await serve(
      fetch,
      apiRequest("/profiles/alex/daily?since=2026-06-02&until=2026-06-01"),
    );

    expect(absurd.status).toBe(200);
    expect(await absurd.json()).toMatchObject({
      range: { firstDate: MIN_USAGE_DATE_KEY, lastDate: ceiling },
    });
    expect(inverted.status).toBe(400);
    expect(await inverted.json()).toEqual({
      _tag: "BadRequest",
      message: "Invalid date range: `since` (2026-06-02) is after `until` (2026-06-01).",
    });
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
      Effect.succeed({ days: [], range: { firstDate: "2026-01-01", lastDate: "2026-09-22" } }),
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
