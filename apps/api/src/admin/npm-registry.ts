import { Cache, Context, Data, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * Reads the published CLI's dist-tags from the npm registry so the admin
 * fleet view can flag outdated devices. Successful lookups are cached per
 * isolate for LATEST_RELEASE_TTL; failures are never cached, and a failed
 * lookup degrades to "no known release" rather than failing the page.
 */

const NPM_PACKAGE_URL = "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing";
const LATEST_RELEASE_TTL = Duration.minutes(5);
const REGISTRY_TIMEOUT = Duration.seconds(5);
const RELEASE_CHANNELS = ["latest", "alpha", "beta", "rc"] as const;

type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

type LatestCliVersions = Record<ReleaseChannel, string | null>;

interface LatestCliRelease {
  publishedAt: string | null;
  version: string | null;
  versions: LatestCliVersions;
}

class NpmRegistryError extends Data.TaggedError("NpmRegistryError")<{
  readonly cause: unknown;
}> {}

/** The slice of an npm packument this client reads; other fields are ignored. */
const RegistryPackument = Schema.Struct({
  "dist-tags": Schema.optional(
    Schema.Struct({
      alpha: Schema.optional(Schema.String),
      beta: Schema.optional(Schema.String),
      latest: Schema.optional(Schema.String),
      rc: Schema.optional(Schema.String),
    }),
  ),
  // Values are ISO strings except npm's `unpublished` bookkeeping entry.
  time: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  version: Schema.optional(Schema.String),
});

const decodeRegistryPackument = Schema.decodeUnknownOption(RegistryPackument);

interface NpmRegistryShape {
  readonly latestCliRelease: Effect.Effect<LatestCliRelease>;
}

class NpmRegistry extends Context.Service<NpmRegistry, NpmRegistryShape>()(
  "@tokenmaxxing/api/NpmRegistry",
) {}

const makeNpmRegistry = Effect.fn("makeNpmRegistry")(function* (
  options: { timeout?: Duration.Input | undefined } = {},
) {
  const http = yield* HttpClient.HttpClient;

  const fetchLatestCliRelease = http
    .get(NPM_PACKAGE_URL, { headers: { accept: "application/json" } })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map(latestReleaseFromRegistryBody),
      Effect.timeout(options.timeout ?? REGISTRY_TIMEOUT),
      Effect.mapError((cause) => new NpmRegistryError({ cause })),
    );

  const cache = yield* Cache.makeWith((_url: string) => fetchLatestCliRelease, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LATEST_RELEASE_TTL : Duration.zero),
  });

  return NpmRegistry.of({
    latestCliRelease: Cache.get(cache, NPM_PACKAGE_URL).pipe(
      Effect.catch((error) =>
        Effect.logWarning("npm registry lookup failed", error).pipe(
          Effect.as(noLatestCliRelease()),
        ),
      ),
    ),
  });
});

const NpmRegistryLive = Layer.effect(NpmRegistry, makeNpmRegistry()).pipe(
  Layer.provide(FetchHttpClient.layer),
);

function latestReleaseFromRegistryBody(body: unknown): LatestCliRelease {
  const packument = decodeRegistryPackument(body);
  if (Option.isNone(packument)) {
    return noLatestCliRelease();
  }

  const distTags = packument.value["dist-tags"];
  const versions = emptyLatestCliVersions();
  for (const channel of RELEASE_CHANNELS) {
    versions[channel] = nonEmpty(distTags?.[channel]);
  }

  const latest = versions.latest ?? nonEmpty(packument.value.version);
  if (latest === null) {
    return noLatestCliRelease();
  }

  return {
    publishedAt: nonEmpty(packument.value.time?.[latest]),
    version: latest,
    versions: { ...versions, latest },
  };
}

function noLatestCliRelease(): LatestCliRelease {
  return { publishedAt: null, version: null, versions: emptyLatestCliVersions() };
}

function emptyLatestCliVersions(): LatestCliVersions {
  return { alpha: null, beta: null, latest: null, rc: null };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export {
  latestReleaseFromRegistryBody,
  makeNpmRegistry,
  noLatestCliRelease,
  NpmRegistry,
  NpmRegistryError,
  NpmRegistryLive,
  RELEASE_CHANNELS,
};

export type { LatestCliRelease, NpmRegistryShape, ReleaseChannel };
