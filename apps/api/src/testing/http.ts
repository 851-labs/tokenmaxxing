import { Context, Effect, Exit, Layer, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AdminService } from "../admin/service";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig } from "../config";
import { Drizzle } from "../database";
import { makeApiHttpEffect } from "../http/layer";
import { AuthorizationLive } from "../http/middleware/authorization";
import { CliAuthLive } from "../http/middleware/cli-auth";
import { LeaderboardService } from "../leaderboard/service";
import { ProfilesService } from "../profiles/service";
import { StatsService } from "../stats/service";
import { TokensService } from "../tokens/service";
import { UsageService } from "../usage/service";

/**
 * The production HTTP stack (router, real middlewares, CORS, defect
 * recovery) over stub domain services. Methods a test does not stub die, so
 * an unexpected call surfaces as a 500 instead of silently passing.
 */

interface TestAppServices {
  admin?: Partial<AdminService["Service"]>;
  auth?: Partial<AuthService["Service"]>;
  cliLogin?: Partial<CliLoginService["Service"]>;
  leaderboard?: Partial<LeaderboardService["Service"]>;
  profiles?: Partial<ProfilesService["Service"]>;
  stats?: Partial<StatsService["Service"]>;
  tokens?: Partial<TokensService["Service"]>;
  usage?: Partial<UsageService["Service"]>;
}

interface TestApp {
  close(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

const TEST_CORS_ORIGIN = "https://tokenmaxxing.sh";

const testConfig: AppConfig["Service"] = {
  apiWorkerName: "tokenmaxxing-api-test",
  corsOrigins: [TEST_CORS_ORIGIN],
  github: { clientId: "github-id", clientSecret: "github-secret" },
  google: { clientId: "google-id", clientSecret: "google-secret" },
  productName: "Tokenmaxxing",
};

async function makeTestApp(services: TestAppServices = {}): Promise<TestApp> {
  const admin = stub<AdminService["Service"]>("AdminService", services.admin);
  const auth = stub<AuthService["Service"]>("AuthService", services.auth);
  const cliLogin = stub<CliLoginService["Service"]>("CliLoginService", services.cliLogin);
  const leaderboard = stub<LeaderboardService["Service"]>(
    "LeaderboardService",
    services.leaderboard,
  );
  const profiles = stub<ProfilesService["Service"]>("ProfilesService", services.profiles);
  const stats = stub<StatsService["Service"]>("StatsService", services.stats);
  const tokens = stub<TokensService["Service"]>("TokensService", services.tokens);
  const usage = stub<UsageService["Service"]>("UsageService", services.usage);

  // Mirrors worker.ts: handlers also resolve services per request.
  const requestServices = Context.empty().pipe(
    Context.add(AdminService, admin),
    Context.add(AppConfig, testConfig),
    Context.add(AuthService, auth),
    Context.add(CliLoginService, cliLogin),
    Context.add(LeaderboardService, leaderboard),
    Context.add(ProfilesService, profiles),
    Context.add(StatsService, stats),
    Context.add(TokensService, tokens),
    Context.add(UsageService, usage),
  );

  const scope = Effect.runSync(Scope.make());
  const httpEffect = await Effect.runPromise(
    makeApiHttpEffect({
      adminServiceLayer: Layer.succeed(AdminService, admin),
      appConfigLayer: Layer.succeed(AppConfig, testConfig),
      authServiceLayer: Layer.succeed(AuthService, auth),
      cliLoginServiceLayer: Layer.succeed(CliLoginService, cliLogin),
      drizzleLayer: Layer.succeed(
        Drizzle,
        Drizzle.of({ use: () => Effect.die("Drizzle is not available in HTTP tests") }),
      ),
      leaderboardServiceLayer: Layer.succeed(LeaderboardService, leaderboard),
      middlewareLayer: Layer.mergeAll(AuthorizationLive, CliAuthLive),
      profilesServiceLayer: Layer.succeed(ProfilesService, profiles),
      statsServiceLayer: Layer.succeed(StatsService, stats),
      tokensServiceLayer: Layer.succeed(TokensService, tokens),
      usageServiceLayer: Layer.succeed(UsageService, usage),
    }).pipe(
      // HttpApiBuilder.layer declares FileSystem for file responses; no
      // route under test serves files.
      Effect.provide(FileSystem.layerNoop({})),
      Effect.provideService(Scope.Scope, scope),
    ),
  );

  return {
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    fetch: (request) =>
      Effect.runPromise(
        httpEffect.pipe(
          Effect.provide(requestServices),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
          Effect.scoped,
          Effect.map((response) => HttpServerResponse.toWeb(response)),
        ) as Effect.Effect<Response>,
      ),
  };
}

function stub<S extends object>(name: string, implementation: Partial<S> = {}): S {
  return new Proxy(implementation, {
    get: (target, property) =>
      property in target
        ? target[property as keyof typeof target]
        : () => Effect.die(`${name}.${String(property)} is not stubbed`),
  }) as S;
}

export { makeTestApp, TEST_CORS_ORIGIN };

export type { TestApp, TestAppServices };
