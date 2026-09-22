import { Context } from "effect";
import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";
import { Scope } from "effect";
import * as Path from "effect/Path";
import {
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import {
  CurrentCliIdentity,
  CurrentUser,
  DEFAULT_LEADERBOARD_METRIC,
  DEFAULT_LEADERBOARD_WINDOW,
  TokenmaxxingApi,
} from "@tokenmaxxing/api-contract";
import type { Authorization, CliAuth } from "@tokenmaxxing/api-contract";

import { AppConfig } from "../config";
import { cookieScopeFor, sessionTokenFrom } from "../auth/cookies";
import { AdminService } from "../admin/service";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import type { Drizzle } from "../database";
import { LeaderboardService } from "../leaderboard/service";
import { ProfilesService } from "../profiles/service";
import { STATS_CACHE_TTL_SECONDS, StatsService } from "../stats/service";
import { TokensService } from "../tokens/service";
import { UsageService } from "../usage/service";
import { oauthRoutesLayer } from "./routes/oauth";

/**
 * Handler layers, one per contract group — pure pass-throughs over the
 * domain services. Groups whose milestone has not landed yet die with
 * "not implemented"; the contract still serves and typechecks end-to-end.
 */

const healthHandlers = HttpApiBuilder.group(TokenmaxxingApi, "health", (handlers) =>
  handlers.handle("status", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return {
        ok: true,
        product: config.productName,
        service: config.apiWorkerName,
      };
    }),
  ),
);

const meHandlers = HttpApiBuilder.group(TokenmaxxingApi, "me", (handlers) =>
  handlers
    .handle("me", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        return { user };
      }),
    )
    .handle("listAccounts", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const auth = yield* AuthService;
        return { accounts: yield* auth.listAccounts(user.id).pipe(Effect.orDie) };
      }),
    )
    .handle("describeCliLogin", ({ query }) =>
      Effect.gen(function* () {
        const cliLogin = yield* CliLoginService;
        return yield* cliLogin.describe(query.code);
      }),
    )
    .handle("approveCliLogin", ({ payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const cliLogin = yield* CliLoginService;
        const { deviceName } = yield* cliLogin.approve(user, payload.code);
        return { deviceName, ok: true };
      }),
    )
    .handle("listDevices", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const tokens = yield* TokensService;
        return { devices: yield* tokens.listDevices(user.id) };
      }),
    )
    .handle("deleteDevice", ({ params }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const tokens = yield* TokensService;
        yield* tokens.deleteDevice(user.id, params.deviceId);
        return { ok: true };
      }),
    )
    .handle("listTokens", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const tokens = yield* TokensService;
        return { tokens: yield* tokens.listTokens(user.id) };
      }),
    )
    .handle("revokeToken", ({ params }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const tokens = yield* TokensService;
        yield* tokens.revokeToken(user.id, params.tokenId);
        return { ok: true };
      }),
    ),
);

const cliLoginHandlers = HttpApiBuilder.group(TokenmaxxingApi, "cliLogin", (handlers) =>
  handlers
    .handle("start", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const scope = cookieScopeFor(request.headers["host"] ?? "");
        const cliLogin = yield* CliLoginService;
        return yield* cliLogin.start(payload, scope.wwwOrigin);
      }),
    )
    .handle("poll", ({ payload }) =>
      Effect.gen(function* () {
        const cliLogin = yield* CliLoginService;
        return yield* cliLogin.poll(payload);
      }),
    ),
);

const usageHandlers = HttpApiBuilder.group(TokenmaxxingApi, "usage", (handlers) =>
  handlers
    .handle("checkIn", ({ payload }) =>
      Effect.gen(function* () {
        const identity = yield* CurrentCliIdentity;
        const usage = yield* UsageService;
        return yield* usage.checkIn(identity, payload.device, payload.service);
      }),
    )
    .handle("ingest", ({ payload }) =>
      Effect.gen(function* () {
        const identity = yield* CurrentCliIdentity;
        const usage = yield* UsageService;
        return yield* usage.ingestRaw(
          identity,
          payload.device,
          payload.reports,
          payload.sourceStats,
        );
      }),
    )
    .handle("sync", ({ payload }) =>
      Effect.gen(function* () {
        const identity = yield* CurrentCliIdentity;
        const usage = yield* UsageService;
        return yield* usage.syncBatch(identity, payload.device, payload.days, payload.sourceStats);
      }),
    )
    .handle("logout", () =>
      Effect.gen(function* () {
        const identity = yield* CurrentCliIdentity;
        const tokens = yield* TokensService;
        // Already-revoked is fine — logout is idempotent from the CLI's view.
        yield* tokens
          .revokeToken(identity.user.id, identity.tokenId)
          .pipe(Effect.catchTag("TokenNotFound", () => Effect.void));
        return { ok: true };
      }),
    ),
);

const leaderboardHandlers = HttpApiBuilder.group(TokenmaxxingApi, "leaderboard", (handlers) =>
  handlers.handle("list", ({ query }) =>
    Effect.gen(function* () {
      const leaderboard = yield* LeaderboardService;
      const metric = query.metric ?? DEFAULT_LEADERBOARD_METRIC;
      const window = query.window ?? DEFAULT_LEADERBOARD_WINDOW;

      const entries = yield* leaderboard.list(metric, window);
      yield* cacheControl(PUBLIC_READ_CACHE_CONTROL);
      return { entries, metric, window };
    }),
  ),
);

const profilesHandlers = HttpApiBuilder.group(TokenmaxxingApi, "profiles", (handlers) =>
  handlers
    .handle("identity", ({ params }) =>
      Effect.gen(function* () {
        const profiles = yield* ProfilesService;
        const identity = yield* profiles.getIdentity(params.login);
        yield* cacheControl(PUBLIC_READ_CACHE_CONTROL);
        return identity;
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const profiles = yield* ProfilesService;
        const profile = yield* profiles.getProfile(params.login, yield* optionalCurrentUserId());
        yield* cacheControl(yield* viewerCacheControl());
        return profile;
      }),
    )
    .handle("daily", ({ params, query }) =>
      Effect.gen(function* () {
        const profiles = yield* ProfilesService;
        const daily = yield* profiles.getDaily(
          params.login,
          {
            groupBy: query.groupBy ?? "model",
            since: query.since,
            until: query.until,
          },
          yield* optionalCurrentUserId(),
        );
        yield* cacheControl(yield* viewerCacheControl());
        return daily;
      }),
    ),
);

function optionalCurrentUserId() {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = sessionTokenFrom(request);
    if (token === null) {
      return null;
    }

    const auth = yield* AuthService;
    const user = yield* auth
      .resolveSession(token)
      .pipe(Effect.catchCause(() => Effect.succeedNone));
    return Option.isSome(user) ? user.value.id : null;
  });
}

/**
 * Cache policy for public reads. `s-maxage` only addresses shared caches
 * (browsers ignore it) and stale-while-revalidate lets them refresh in the
 * background. Registered after the handler succeeded, and applied to 200s
 * only, so failures (404 for unknown or hidden profiles) are never cached.
 */
const PUBLIC_READ_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";
const STATS_CACHE_CONTROL = `public, s-maxage=${STATS_CACHE_TTL_SECONDS}, stale-while-revalidate=600`;
const PRIVATE_CACHE_CONTROL = "private, no-store";

function cacheControl(value: string) {
  return HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      response.status === 200
        ? HttpServerResponse.setHeader(response, "cache-control", value)
        : response,
    ),
  );
}

/**
 * Profile reads resolve the viewer (a shadow-banned owner still sees their
 * own profile), so a request carrying credentials must never be shared.
 */
function viewerCacheControl() {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return sessionTokenFrom(request) === null ? PUBLIC_READ_CACHE_CONTROL : PRIVATE_CACHE_CONTROL;
  });
}

const statsHandlers = HttpApiBuilder.group(TokenmaxxingApi, "stats", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const stats = yield* StatsService;
      const response = yield* stats.getStats();
      yield* cacheControl(STATS_CACHE_CONTROL);
      return response;
    }),
  ),
);

const adminHandlers = HttpApiBuilder.group(TokenmaxxingApi, "admin", (handlers) =>
  handlers
    .handle("listUsers", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const admin = yield* AdminService;
        return yield* admin.listUsers(user.id);
      }),
    )
    .handle("shadowBanUser", ({ params }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const admin = yield* AdminService;
        return yield* admin.shadowBanUser(user.id, params.userId);
      }),
    )
    .handle("shadowUnbanUser", ({ params }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const admin = yield* AdminService;
        return yield* admin.shadowUnbanUser(user.id, params.userId);
      }),
    ),
);

const handlersLayer = Layer.mergeAll(
  adminHandlers,
  healthHandlers,
  meHandlers,
  cliLoginHandlers,
  usageHandlers,
  leaderboardHandlers,
  statsHandlers,
  profilesHandlers,
);

interface ApiLayerOptions {
  adminServiceLayer: Layer.Layer<AdminService>;
  appConfigLayer: Layer.Layer<AppConfig>;
  authServiceLayer: Layer.Layer<AuthService>;
  cliLoginServiceLayer: Layer.Layer<CliLoginService>;
  drizzleLayer: Layer.Layer<Drizzle>;
  leaderboardServiceLayer: Layer.Layer<LeaderboardService>;
  profilesServiceLayer: Layer.Layer<ProfilesService>;
  statsServiceLayer: Layer.Layer<StatsService>;
  middlewareLayer: Layer.Layer<Authorization | CliAuth, never, AuthService | TokensService>;
  tokensServiceLayer: Layer.Layer<TokensService>;
  usageServiceLayer: Layer.Layer<UsageService>;
}

function makeApiLayer(options: ApiLayerOptions) {
  const apiLayer = Layer.mergeAll(
    HttpApiBuilder.layer(TokenmaxxingApi, { openapiPath: "/openapi.json" }),
    oauthRoutesLayer,
  );

  return apiLayer.pipe(
    Layer.provide(handlersLayer),
    Layer.provide(options.middlewareLayer),
    Layer.provide(requestIdLayer),
    Layer.provide(corsLayer),
    Layer.provide(options.cliLoginServiceLayer),
    Layer.provide(options.adminServiceLayer),
    Layer.provide(options.leaderboardServiceLayer),
    Layer.provide(options.profilesServiceLayer),
    Layer.provide(options.statsServiceLayer),
    Layer.provide(options.tokensServiceLayer),
    Layer.provide(options.usageServiceLayer),
    Layer.provide(options.authServiceLayer),
    Layer.provide(options.drizzleLayer),
    Layer.provide(options.appConfigLayer),
  );
}

function makeApiHttpEffect(options: ApiLayerOptions) {
  return makeApiLayer(options).pipe(
    Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
    HttpRouter.toHttpEffect,
    Effect.map(recoverDefects),
  );
}

/**
 * Builds the router, handlers, middleware, CORS and OpenAPI spec exactly
 * once and returns the per-request handler. The worker's `fetch` must be the
 * returned HttpEffect itself, never an Effect that builds one: alchemy
 * re-runs an Effect-valued `fetch` on every request, which would rebuild the
 * whole layer graph per request.
 *
 * The built layer lives in its own scope that is never closed — the router
 * must outlive the init closure (whose scope we cannot name in types) and
 * every request, and workerd has no isolate-teardown hook anyway. Nothing in
 * the graph registers finalizers that matter at shutdown.
 */
function makeApiFetch<R>(options: ApiLayerOptions, requestServices: Context.Context<R>) {
  return Effect.gen(function* () {
    const routerScope = yield* Scope.make();
    const httpEffect = yield* makeApiHttpEffect(options).pipe(Scope.provide(routerScope));
    return httpEffect.pipe(Effect.provideContext(requestServices));
  });
}

/**
 * Schema decode failures respond with their own 400; every other defect
 * (store/decode faults died at the service boundary, bugs) is logged and
 * answered with an opaque 500 — internals never reach the wire.
 */
function recoverDefects<E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return Effect.catchDefect(httpEffect, (defect) =>
    HttpApiError.HttpApiSchemaError.is(defect)
      ? HttpServerRespondable.toResponse(defect)
      : Effect.logError("request died", defect).pipe(
          Effect.as(HttpServerResponse.empty({ status: 500 })),
        ),
  );
}

const corsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return HttpRouter.middleware(
      HttpMiddleware.cors({
        allowedOrigins: config.corsOrigins,
        // The Effect-derived client propagates trace context as BOTH W3C
        // traceparent and compact B3 (HttpTraceContext.toHeaders); a missing
        // entry here fails the preflight and the app reads every authed
        // call as signed-out.
        allowedHeaders: [
          "authorization",
          "b3",
          "content-type",
          "traceparent",
          "tracestate",
          "x-request-id",
        ],
        allowedMethods: ["DELETE", "GET", "PATCH", "POST", "PUT", "OPTIONS"],
        credentials: true,
      }),
      { global: true },
    );
  }),
);

/** Mints/propagates x-request-id; logs carry it via annotations. */
const requestIdLayer = HttpRouter.middleware(
  (httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const requestId = request.headers["x-request-id"] ?? crypto.randomUUID();
      const response = yield* httpApp.pipe(Effect.annotateLogs("requestId", requestId));
      return HttpServerResponse.setHeader(response, "x-request-id", requestId);
    }),
  { global: true },
);

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: HttpPlatform.makeCompressionWeb({
    algorithms: ["gzip", "deflate"],
    transform: HttpPlatform.compressionTransformWeb,
  }),
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export { makeApiFetch, makeApiHttpEffect };
