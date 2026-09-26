import { Context, Effect, Exit, Layer, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AdminService } from "../admin/service";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig } from "../config";
import { makeApiHttpEffect } from "../http/layer";
import { LeaderboardService } from "../leaderboard/service";
import { OAuthProviders } from "../oauth/registry";
import { ProfilesService } from "../profiles/service";
import { StatsService } from "../stats/service";
import { TokensService } from "../tokens/service";
import { UsageService } from "../usage/service";
import { makeTestLogger, type TestLogger } from "./logger";

/**
 * The production HTTP stack (router, real middlewares, CORS, defect
 * recovery) over stub domain services. Methods a test does not stub die, so
 * an unexpected call surfaces as a 500 instead of silently passing. Logs are
 * captured in `logs` (and replayed if the test fails) instead of printed.
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
  readonly logs: TestLogger;
}

const TEST_CORS_ORIGIN = "https://tokenmaxxing.sh";

const testConfig: AppConfig["Service"] = {
  adminEmails: [],
  apiWorkerName: "tokenmaxxing-api-test",
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

  const context = Context.empty().pipe(
    Context.add(AdminService, admin),
    Context.add(AppConfig, testConfig),
    Context.add(AuthService, auth),
    Context.add(CliLoginService, cliLogin),
    Context.add(LeaderboardService, leaderboard),
    Context.add(OAuthProviders, stub<OAuthProviders["Service"]>("OAuthProviders")),
    Context.add(ProfilesService, profiles),
    Context.add(StatsService, stats),
    Context.add(TokensService, tokens),
    Context.add(UsageService, usage),
  );

  const logs = makeTestLogger();
  const scope = Effect.runSync(Scope.make());
  const httpEffect = await Effect.runPromise(
    makeApiHttpEffect(Layer.succeedContext(context)).pipe(
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
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
          Effect.scoped,
          Effect.map((response) => HttpServerResponse.toWeb(response)),
          Effect.provide(logs.layer),
        ) as Effect.Effect<Response>,
      ),
    logs,
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
