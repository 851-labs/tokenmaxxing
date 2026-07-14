import * as Cloudflare from "alchemy/Cloudflare";
import { Context } from "effect";
import { Effect } from "effect";
import { Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AdminRepositoryLive } from "./admin/d1";
import { AdminService, makeAdminService } from "./admin/service";
import { AuthRepositoryLive } from "./auth/d1";
import { AuthService, makeAuthService } from "./auth/service";
import { Bucket } from "./cloudflare/bucket";
import { Database } from "./cloudflare/database";
import { CliLoginRepositoryLive } from "./clilogin/d1";
import { CliLoginService, makeCliLoginService } from "./clilogin/service";
import { AppConfig } from "./config";
import { Drizzle } from "./database";
import { GitHubClient, makeGitHubClient } from "./github/client";
import { GoogleClient, makeGoogleClient } from "./google/client";
import { LeaderboardRepositoryLive } from "./leaderboard/d1";
import { LeaderboardService, makeLeaderboardService } from "./leaderboard/service";
import { makeProfilesService, ProfilesService } from "./profiles/service";
import { ProfilesRepositoryLive } from "./profiles/d1";
import { StatsRepositoryLive } from "./stats/d1";
import { makeStatsService, StatsService } from "./stats/service";
import { AuthorizationLive } from "./http/middleware/authorization";
import { CliAuthLive } from "./http/middleware/cli-auth";
import { makeApiHttpEffect } from "./http/layer";
import { makeTokensService, TokensService } from "./tokens/service";
import { TokensRepositoryLive } from "./tokens/d1";
import { RawUsageObjectStore } from "./usage/raw-store";
import { makeUsageService, UsageService } from "./usage/service";
import { UsageRepositoryLive } from "./usage/d1";

const ApiWorker = Cloudflare.Worker(
  "api",
  {
    name: "tokenmaxxing-api",
    main: import.meta.filename,
    url: false,
    compatibility: {
      date: "2026-06-02",
      flags: ["nodejs_compat"],
    },
    domain: "api.tokenmaxxing.sh",
    observability: {
      enabled: true,
    },
    dev: {
      port: 8788,
      strictPort: true,
    },
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
    const connection = yield* Cloudflare.D1.QueryDatabase(Database);

    // Config reads stay in this outer Effect so alchemy's deploy-time
    // binding discovery sees them (secrets bind as secret_text).
    const config = yield* AppConfig.fromEnv;
    const appConfigLayer = Layer.succeed(AppConfig, config);
    const drizzleLayer = Drizzle.layer(connection);
    const rawUsageObjectStoreLayer = RawUsageObjectStore.layer(bucket);
    const usageRepositoryLayer = UsageRepositoryLive.pipe(
      Layer.provide(Layer.mergeAll(drizzleLayer, rawUsageObjectStoreLayer)),
    );

    const auth = yield* makeAuthService().pipe(
      Effect.provide(AuthRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const cliLogin = yield* makeCliLoginService().pipe(
      Effect.provide(CliLoginRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const tokens = yield* makeTokensService().pipe(
      Effect.provide(TokensRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const github = yield* makeGitHubClient().pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(AppConfig, config),
    );
    const google = yield* makeGoogleClient().pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(AppConfig, config),
    );
    const usage = yield* makeUsageService().pipe(Effect.provide(usageRepositoryLayer));
    const admin = yield* makeAdminService().pipe(
      Effect.provide(AdminRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const leaderboard = yield* makeLeaderboardService().pipe(
      Effect.provide(LeaderboardRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const profiles = yield* makeProfilesService().pipe(
      Effect.provide(ProfilesRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );
    const stats = yield* makeStatsService().pipe(
      Effect.provide(StatsRepositoryLive.pipe(Layer.provide(drizzleLayer))),
    );

    // Handlers and raw routes (OAuth) resolve these services at request
    // time, not layer-build time — this context rides along with every
    // routed request.
    const rawRouteServices = Context.empty().pipe(
      Context.add(AdminService, admin),
      Context.add(AppConfig, config),
      Context.add(AuthService, auth),
      Context.add(CliLoginService, cliLogin),
      Context.add(GitHubClient, github),
      Context.add(GoogleClient, google),
      Context.add(LeaderboardService, leaderboard),
      Context.add(ProfilesService, profiles),
      Context.add(StatsService, stats),
      Context.add(TokensService, tokens),
      Context.add(UsageService, usage),
    );

    return {
      fetch: makeApiHttpEffect({
        adminServiceLayer: Layer.succeed(AdminService, admin),
        appConfigLayer,
        authServiceLayer: Layer.succeed(AuthService, auth),
        cliLoginServiceLayer: Layer.succeed(CliLoginService, cliLogin),
        drizzleLayer,
        leaderboardServiceLayer: Layer.succeed(LeaderboardService, leaderboard),
        profilesServiceLayer: Layer.succeed(ProfilesService, profiles),
        statsServiceLayer: Layer.succeed(StatsService, stats),
        middlewareLayer: Layer.mergeAll(AuthorizationLive, CliAuthLive),
        tokensServiceLayer: Layer.succeed(TokensService, tokens),
        usageServiceLayer: Layer.succeed(UsageService, usage),
      }).pipe(Effect.map((apiHttpEffect) => apiHttpEffect.pipe(Effect.provide(rawRouteServices)))),
    };
  }).pipe(
    Effect.provide([Cloudflare.D1.QueryDatabaseBinding, Cloudflare.R2.ReadWriteBucketBinding]),
  ),
);

export default ApiWorker;
