import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Layer, Scope } from "effect";

import { CleanupService } from "./cleanup/service";
import { Bucket } from "./cloudflare/bucket";
import { Database } from "./cloudflare/database";
import { AppConfig } from "./config";
import { Drizzle } from "./database";
import { makeApiFetch } from "./http/layer";
import { ServicesLive } from "./services";
import { RawUsageObjectStore } from "./usage/raw-store";

const CLEANUP_CRON = "17 * * * *";

const ApiWorker = Cloudflare.Worker(
  "api",
  {
    name: "tokenmaxxing-api",
    main: import.meta.filename,
    workersDev: false,
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

    // Binding calls are typed as needing alchemy's RuntimeContext; the
    // worker runtime supplies it per event, so the phantom only discharges
    // the type.
    const InfrastructureLive = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Drizzle.layer({ raw: connection.raw.pipe(Effect.provide(RuntimeContext.phantom)) }),
      RawUsageObjectStore.layer({
        put: (key, value, options) =>
          bucket.put(key, value, options).pipe(Effect.provide(RuntimeContext.phantom)),
        delete: (keys) => bucket.delete(keys).pipe(Effect.provide(RuntimeContext.phantom)),
      }),
    );

    // Every domain service, built once per isolate and shared by the cron
    // and the router. Like the router's, this scope is never closed: the
    // services must outlive the init closure, and nothing in the graph
    // registers finalizers that matter at shutdown.
    const services = yield* Layer.buildWithScope(
      ServicesLive.pipe(Layer.provideMerge(InfrastructureLive)),
      yield* Scope.make(),
    );

    // Hourly purge of expired sessions and CLI login requests.
    const cleanup = Context.get(services, CleanupService);
    yield* Cloudflare.Workers.cron(CLEANUP_CRON, (controller) =>
      cleanup.purgeExpired(new Date(controller.scheduledTime)),
    );

    // Built once per isolate. `fetch` must be the HttpEffect itself: an
    // Effect-valued `fetch` is re-run by alchemy on every request, which
    // would rebuild every handler, middleware, CORS and the OpenAPI spec.
    const fetch = yield* makeApiFetch(Layer.succeedContext(services));

    return { fetch };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.Workers.CronEventSourceLive,
    ]),
  ),
);

export default ApiWorker;
