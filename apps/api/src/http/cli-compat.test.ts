import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CliUpgradeRequired,
  DeviceId,
  LoginCodeNotFound,
  TokenId,
  TokenmaxxingApi,
  type UsageDayInput,
  UserId,
} from "@tokenmaxxing/api-contract";

import { AdminService } from "../admin/service";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig } from "../config";
import { LeaderboardService } from "../leaderboard/service";
import { OAuthProviders } from "../oauth/registry";
import { ProfilesService } from "../profiles/service";
import { StatsService } from "../stats/service";
import {
  CCUSAGE_FIXTURE_SOURCES,
  ccusageDailyCommand,
  ccusageDailyFixture,
} from "../testing/ccusage-fixtures";
import { makeTestLogger, type TestLogger } from "../testing/logger";
import { TokensService } from "../tokens/service";
import { makeUsageService, UsageRepository, UsageService } from "../usage/service";
import { makeApiHttpEffect } from "./layer";

/**
 * Replays every recorded CLI request (packages/api-contract/fixtures/
 * cli-requests: `current/` is captured from apps/cli by its own tests,
 * `legacy/` mirrors published releases) through the real router, auth
 * middleware, and payload decoding. A contract change that would break a
 * CLI already in the wild fails here, not in production.
 */

interface CliRequestFixture {
  body?: unknown;
  cli: string;
  endpoint: string;
  method: string;
  path: string;
}

const fixtureRoot = join(
  import.meta.dirname,
  "../../../../packages/api-contract/fixtures/cli-requests",
);

const fixtures: Array<{ file: string; fixture: CliRequestFixture }> = ["current", "legacy"].flatMap(
  (directory) =>
    readdirSync(join(fixtureRoot, directory))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => ({
        file: `${directory}/${file}`,
        fixture: JSON.parse(
          readFileSync(join(fixtureRoot, directory, file), "utf8"),
        ) as CliRequestFixture,
      })),
);

/**
 * Frozen copies of the response and error decoders released CLIs bundle (the
 * pre-cleanup contract; older releases require a subset of these fields).
 * Released CLIs ignore unknown fields, so the server may add fields but must
 * never drop, rename or retype one of these, or change an error `_tag`. Never
 * update these to match the current contract — they are the compatibility
 * target.
 */
const ReleasedAuthUser = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  id: Schema.String,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
});

const ReleasedSyncUsageResponse = Schema.Struct({
  received: Schema.Number,
  syncedAt: Schema.String,
  upserted: Schema.Number,
});

const RELEASED_CLI_RESPONSES: Record<string, Schema.Top> = {
  "cliLogin.poll": Schema.Union([
    Schema.Struct({ status: Schema.Literal("pending") }),
    Schema.Struct({
      status: Schema.Literal("complete"),
      token: Schema.String,
      user: ReleasedAuthUser,
    }),
  ]),
  "cliLogin.start": Schema.Struct({
    code: Schema.String,
    deviceCode: Schema.optional(Schema.String),
    expiresAt: Schema.String,
    intervalSeconds: Schema.Number,
    userCode: Schema.String,
    verificationUri: Schema.String,
  }),
  "me.me": Schema.Struct({ user: ReleasedAuthUser }),
  "usage.checkIn": Schema.Struct({ checkedInAt: Schema.String }),
  "usage.ingest": ReleasedSyncUsageResponse,
  "usage.logout": Schema.Struct({ ok: Schema.Boolean }),
  "usage.sync": ReleasedSyncUsageResponse,
};

const RELEASED_CLI_ERRORS: Record<string, Schema.Top> = {
  CliUpgradeRequired: Schema.TaggedStruct("CliUpgradeRequired", { message: Schema.String }),
  DeviceMissing: Schema.TaggedStruct("DeviceMissing", { message: Schema.String }),
  LoginCodeExpired: Schema.TaggedStruct("LoginCodeExpired", { code: Schema.String }),
  LoginCodeNotFound: Schema.TaggedStruct("LoginCodeNotFound", { code: Schema.String }),
  Unauthorized: Schema.TaggedStruct("Unauthorized", { message: Schema.String }),
};

function decodeReleased(schema: Schema.Top | undefined, body: unknown) {
  expect(schema).toBeDefined();
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(body);
}

/** A typed CLI error: same status and tag, decodable by released CLIs, and
 * carrying the human-readable `message` every wire error now has. */
async function expectCliError(response: Response, status: number, tag: string) {
  const body = (await response.json()) as { _tag?: unknown; message?: unknown };

  expect(response.status).toBe(status);
  expect(body._tag).toBe(tag);
  expect(typeof body.message).toBe("string");
  decodeReleased(RELEASED_CLI_ERRORS[tag], body);
}

const user = {
  avatarUrl: null,
  id: UserId.make("user_123"),
  login: "alex",
  name: null,
};

const usageRepository = {
  checkInDevice: vi.fn(() => Effect.void),
  pruneChunk: vi.fn(() => Effect.void),
  touchDevice: vi.fn(() => Effect.void),
  upsertChunk: vi.fn(() => Effect.void),
  upsertRawReports: vi.fn(() => Effect.void),
  upsertSourceStats: vi.fn(() => Effect.void),
};

let scope: Scope.Closeable;
let handle: (request: Request) => Promise<Response>;
let logs: TestLogger;

beforeAll(async () => {
  const tokens = TokensService.of({
    deleteDevice: () => Effect.void,
    listDevices: () => Effect.succeed([]),
    listTokens: () => Effect.succeed([]),
    resolveCliToken: (rawToken) =>
      Effect.succeed(
        rawToken === "tmx_fixture"
          ? Option.some({
              deviceId: DeviceId.make("device_123"),
              tokenId: TokenId.make("token_123"),
              user,
            })
          : rawToken === "tmx_no_device"
            ? Option.some({ deviceId: null, tokenId: TokenId.make("token_456"), user })
            : Option.none(),
      ).pipe(
        Effect.andThen((identity) =>
          rawToken === "tmx_store_down"
            ? Effect.die(new Error("D1 down"))
            : Effect.succeed(identity),
        ),
      ),
    revokeToken: () => Effect.void,
  });
  const auth = { resolveSession: () => Effect.succeedNone } as unknown as AuthService["Service"];
  const cliLogin = CliLoginService.of({
    approve: () => Effect.succeed({ deviceName: "fixture-host" }),
    describe: () => Effect.die("not called by the CLI"),
    poll: (input) =>
      "deviceCode" in input && input.deviceCode === "unknown-device-code"
        ? Effect.fail(new LoginCodeNotFound({ code: "" }))
        : Effect.succeed({ status: "complete", token: "tmx_fixture", user }),
    // Stubbed, so the legacy-login sunset is not exercised here: these tests
    // pin routing and payload decoding for every recorded request shape.
    start: (input) =>
      input.deviceName === "upgrade-required-host"
        ? Effect.fail(new CliUpgradeRequired({ message: "Upgrade the CLI." }))
        : Effect.succeed({
            code: "ABCD-1234",
            ...(input.flow === "device_code" ? { deviceCode: "device-code-secret" } : {}),
            expiresAt: "2026-06-21T18:10:00.000Z",
            intervalSeconds: 2,
            userCode: "ABCD-1234",
            verificationUri: "https://tokenmaxxing.sh/login/cli?code=ABCD-1234",
          }),
  });
  const usage = await Effect.runPromise(
    makeUsageService({ now: () => new Date("2026-06-21T18:00:00.000Z") }).pipe(
      Effect.provideService(UsageRepository, usageRepository),
    ),
  );
  const config = AppConfig.of({
    adminEmails: [],
    apiWorkerName: "tokenmaxxing-api",
    corsOrigins: ["https://tokenmaxxing.sh"],
    github: { clientId: "github", clientSecret: "secret" },
    google: { clientId: "google", clientSecret: "secret" },
    productName: "Tokenmaxxing",
  });
  const unused = <S>() => ({}) as S;

  const services = Context.empty().pipe(
    Context.add(AdminService, unused<AdminService["Service"]>()),
    Context.add(AppConfig, config),
    Context.add(AuthService, auth),
    Context.add(CliLoginService, cliLogin),
    Context.add(LeaderboardService, unused<LeaderboardService["Service"]>()),
    Context.add(OAuthProviders, unused<OAuthProviders["Service"]>()),
    Context.add(ProfilesService, unused<ProfilesService["Service"]>()),
    Context.add(StatsService, unused<StatsService["Service"]>()),
    Context.add(TokensService, tokens),
    Context.add(UsageService, usage),
  );
  scope = await Effect.runPromise(Scope.make());
  const httpEffect = await Effect.runPromise(
    makeApiHttpEffect(Layer.succeedContext(services)).pipe(
      // Only multipart payloads touch the file system; none of these do.
      Effect.provide(FileSystem.layerNoop({})),
      Scope.provide(scope),
    ),
  );

  handle = (request) =>
    Effect.runPromise(
      httpEffect.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
        Scope.provide(scope),
        Effect.map((response) => HttpServerResponse.toWeb(response)),
        Effect.provide(logs.layer),
      ) as Effect.Effect<Response>,
    );
});

beforeEach(() => {
  logs = makeTestLogger();
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

function send(fixture: CliRequestFixture, body: unknown = fixture.body) {
  return handle(
    new Request(`https://api.tokenmaxxing.sh${fixture.path}`, {
      body: body === undefined ? null : JSON.stringify(body),
      headers: {
        authorization: "Bearer tmx_fixture",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        host: "api.tokenmaxxing.sh",
      },
      method: fixture.method,
    }),
  );
}

describe("recorded CLI requests", () => {
  it("covers every endpoint the CLI calls", () => {
    expect(
      [
        ...new Set(
          fixtures
            .filter(({ file }) => file.startsWith("current/"))
            .map(({ fixture }) => fixture.endpoint),
        ),
      ].sort(),
    ).toEqual([
      "cliLogin.poll",
      "cliLogin.start",
      "me.me",
      "usage.checkIn",
      "usage.ingest",
      "usage.logout",
    ]);
  });

  it.each(fixtures)("$file still routes to its contract endpoint", ({ fixture }) => {
    const [groupName, endpointName] = fixture.endpoint.split(".") as [string, string];
    const group = (
      TokenmaxxingApi.groups as Record<
        string,
        (typeof TokenmaxxingApi.groups)[keyof typeof TokenmaxxingApi.groups]
      >
    )[groupName];
    const endpoint = group?.endpoints[endpointName as keyof typeof group.endpoints] as
      | { method: string; path: string }
      | undefined;

    expect({ method: endpoint?.method, path: endpoint?.path }).toEqual({
      method: fixture.method,
      path: fixture.path,
    });
  });

  it.each(fixtures)("$file is accepted by the server", async ({ fixture }) => {
    const response = await send(fixture);

    expect({ body: await response.text(), status: response.status }).toMatchObject({ status: 200 });
  });

  it.each(fixtures)("$file gets a response released CLIs can decode", async ({ fixture }) => {
    const response = await send(fixture);

    decodeReleased(RELEASED_CLI_RESPONSES[fixture.endpoint], await response.json());
  });

  it.each(fixtures.filter(({ fixture }) => fixture.body !== undefined))(
    "$file is rejected with an undeclared top-level property",
    async ({ fixture }) => {
      const response = await send(fixture, {
        ...(fixture.body as Record<string, unknown>),
        undeclaredProperty: true,
      });

      // A union payload may name another member's missing field first.
      expect(await response.json()).toEqual({
        _tag: "BadRequest",
        message: expect.stringMatching(/^Invalid request body field `\w+`\.$/),
      });
      expect(response.status).toBe(400);
    },
  );
});

// Regression: strict payload options once leaked into error *encoding*, and
// every typed CLI error (401 re-login prompt, expired code, upgrade) became
// an opaque 500. The CLI branches on these statuses and tags.
describe("CLI error responses", () => {
  const byFile = (file: string) => fixtures.find((entry) => entry.file === file)!.fixture;

  it.each([
    ["/cli/logout", undefined],
    ["/usage/check-in", byFile("current/usage.checkIn.json").body],
  ] as const)("POST %s without a token is 401 Unauthorized", async (path, body) => {
    const response = await handle(
      new Request(`https://api.tokenmaxxing.sh${path}`, {
        body: body === undefined ? null : JSON.stringify(body),
        headers: body === undefined ? {} : { "content-type": "application/json" },
        method: "POST",
      }),
    );

    await expectCliError(response, 401, "Unauthorized");
  });

  it("a revoked or unknown CLI token is 401 Unauthorized", async () => {
    const response = await handle(
      new Request("https://api.tokenmaxxing.sh/cli/logout", {
        headers: { authorization: "Bearer tmx_revoked" },
        method: "POST",
      }),
    );

    await expectCliError(response, 401, "Unauthorized");
  });

  it("an unknown device code is 404 LoginCodeNotFound", async () => {
    const poll = byFile("current/cliLogin.poll.json");
    const response = await send(poll, { deviceCode: "unknown-device-code" });

    await expectCliError(response, 404, "LoginCodeNotFound");
  });

  it("an upgrade-required start is 426 CliUpgradeRequired", async () => {
    const start = byFile("current/cliLogin.start.json");
    const response = await send(start, {
      ...(start.body as Record<string, unknown>),
      deviceName: "upgrade-required-host",
    });

    await expectCliError(response, 426, "CliUpgradeRequired");
  });

  it("a token without a device is 400 DeviceMissing (TokenDeviceUnbound)", async () => {
    const checkIn = byFile("current/usage.checkIn.json");
    const response = await handle(
      new Request(`https://api.tokenmaxxing.sh${checkIn.path}`, {
        body: JSON.stringify(checkIn.body),
        headers: { authorization: "Bearer tmx_no_device", "content-type": "application/json" },
        method: checkIn.method,
      }),
    );

    await expectCliError(response, 400, "DeviceMissing");
  });
});

/**
 * Errors released CLIs have no decoder for. Their frozen clients fail these
 * as a generic HTTP error (no decoder for the status, or one that rejects the
 * body), exactly like the empty bodies these statuses used to have — the
 * point is that none of them can be mistaken for a tag they branch on.
 * Above all a failed credential lookup must not read as Unauthorized, on
 * which interactive CLIs discard their token and restart browser login.
 */
describe("request-level errors", () => {
  const byFile = (file: string) => fixtures.find((entry) => entry.file === file)!.fixture;

  async function expectUnbranchedError(response: Response, status: number, tag: string) {
    const body = (await response.json()) as { _tag?: unknown; message?: unknown };

    expect({ status: response.status, tag: body._tag }).toEqual({ status, tag });
    expect(typeof body.message).toBe("string");
    expect(RELEASED_CLI_ERRORS[tag]).toBeUndefined();
    for (const schema of Object.values(RELEASED_CLI_ERRORS)) {
      expect(() => decodeReleased(schema, body)).toThrow();
    }
  }

  // Unauthenticated login endpoints included: the limit applies before auth.
  it.each(fixtures.filter(({ fixture }) => fixture.body !== undefined))(
    "$file with a body over the limit is 413 PayloadTooLarge",
    async ({ fixture }) => {
      const padded = { ...(fixture.body as object), padding: "x".repeat(16 * 1024 * 1024) };

      await expectUnbranchedError(await send(fixture, padded), 413, "PayloadTooLarge");
    },
  );

  // cliLogin.* runs before the CLI has a token.
  it.each(fixtures.filter(({ fixture }) => !fixture.endpoint.startsWith("cliLogin.")))(
    "$file with a failing token lookup is 503 ServiceUnavailable, not 401",
    async ({ fixture }) => {
      const response = await handle(
        new Request(`https://api.tokenmaxxing.sh${fixture.path}`, {
          body: fixture.body === undefined ? null : JSON.stringify(fixture.body),
          headers: {
            authorization: "Bearer tmx_store_down",
            ...(fixture.body === undefined ? {} : { "content-type": "application/json" }),
          },
          method: fixture.method,
        }),
      );

      await expectUnbranchedError(response, 503, "ServiceUnavailable");
      expect(logs.entries).toEqual([
        expect.objectContaining({ level: "Error", message: "credential lookup failed" }),
      ]);
    },
  );

  it("a malformed body is 400 BadRequest", async () => {
    const poll = byFile("current/cliLogin.poll.json");
    const response = await handle(
      new Request(`https://api.tokenmaxxing.sh${poll.path}`, {
        body: "{",
        headers: { "content-type": "application/json" },
        method: poll.method,
      }),
    );

    await expectUnbranchedError(response, 400, "BadRequest");
  });

  it("a non-JSON body is 415 UnsupportedMediaType", async () => {
    const poll = byFile("current/cliLogin.poll.json");
    const response = await handle(
      new Request(`https://api.tokenmaxxing.sh${poll.path}`, {
        body: "deviceCode=x",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: poll.method,
      }),
    );

    await expectUnbranchedError(response, 415, "UnsupportedMediaType");
  });

  it("an unknown path is 404 RouteNotFound and a wrong method 405 MethodNotAllowed", async () => {
    await expectUnbranchedError(
      await handle(new Request("https://api.tokenmaxxing.sh/cli/unknown", { method: "POST" })),
      404,
      "RouteNotFound",
    );
    await expectUnbranchedError(
      await handle(new Request("https://api.tokenmaxxing.sh/cli/logout")),
      405,
      "MethodNotAllowed",
    );
  });
});

describe("ingest boundary", () => {
  const ingest = fixtures.find(({ file }) => file === "current/usage.ingest.json")!.fixture;
  const body = ingest.body as { reports: Array<Record<string, unknown>> };

  it("rejects nested excess properties, unknown sources, and malformed stats", async () => {
    const [report] = body.reports;
    for (const invalid of [
      { ...body, reports: [{ ...report, extra: 1 }] },
      { ...body, reports: [{ ...report, source: "cursor" }] },
      { ...body, sourceStats: [{ sessionCount: -1, source: "codex" }] },
      { ...body, sourceStats: [{ sessionCount: "NaN", source: "codex" }] },
      { ...body, reports: Array(65).fill(report) },
    ]) {
      const response = await send(ingest, invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        _tag: "BadRequest",
        message: expect.stringMatching(/^Invalid request body/),
      });
    }
  });

  it("drops future-dated days instead of failing the upload", async () => {
    usageRepository.upsertChunk.mockClear();
    const response = await send(ingest, {
      device: { name: "fixture-host", platform: "darwin" },
      reports: [
        {
          command: ["ccusage@^20", "codex", "daily", "--json"],
          payload: {
            daily: [
              { costUSD: 1, date: "2026-06-21", totalTokens: 10 },
              { costUSD: 1, date: "9999-12-31", totalTokens: 10 },
            ],
          },
          reportKind: "daily",
          source: "codex",
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: 1, upserted: 1 });
  });

  it("accepts every ccusage-backed source in one upload", async () => {
    usageRepository.upsertChunk.mockClear();
    usageRepository.upsertSourceStats.mockClear();
    // The app clock is 2026-06-21; move the captured days before it.
    const pastDays = (source: (typeof CCUSAGE_FIXTURE_SOURCES)[number]) => ({
      daily: ccusageDailyFixture(source).daily.map((day, index) => ({
        ...day,
        date: `2026-06-1${index}`,
      })),
    });
    const response = await send(ingest, {
      device: { name: "fixture-host", platform: "darwin" },
      reports: CCUSAGE_FIXTURE_SOURCES.map((source) => ({
        command: ccusageDailyCommand(source),
        payload: pastDays(source),
        reportKind: "daily",
        source,
      })),
      sourceStats: CCUSAGE_FIXTURE_SOURCES.map((source) => ({ sessionCount: 2, source })),
    });

    expect(response.status).toBe(200);
    const upserted = (
      usageRepository.upsertChunk.mock.calls as unknown as Array<[string, string, UsageDayInput[]]>
    ).flatMap(([, , rows]) => rows);
    expect(new Set(upserted.map((row) => row.source))).toEqual(new Set(CCUSAGE_FIXTURE_SOURCES));
    expect(upserted.some((row) => row.model.startsWith("[openclaw]"))).toBe(false);
    expect(usageRepository.upsertSourceStats).toHaveBeenCalledOnce();
  });

  it("rejects a daily report over the day cap instead of silently dropping it", async () => {
    const [report] = body.reports;
    const response = await send(ingest, {
      ...body,
      reports: [{ ...report, payload: { daily: Array(10_001).fill({}) } }],
    });

    expect(response.status).toBe(400);
  });

  it("rejects profile daily ranges that are not calendar date keys", async () => {
    for (const query of ["since=2026-02-30", "until=tomorrow", "since=2026-6-1"]) {
      const response = await handle(
        new Request(`https://api.tokenmaxxing.sh/profiles/alex/daily?${query}`),
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("legacy sync boundary", () => {
  const sync = fixtures.find(({ file }) => file === "legacy/0.2.3-usage.sync.json")!.fixture;
  const body = sync.body as { days: Array<Record<string, unknown>>; device: unknown };

  // 0.2.x CLIs resend their whole history on every sync; one bad row used to
  // 400 the upload, so the device could never sync again.
  it("drops invalid rows individually instead of rejecting the upload", async () => {
    usageRepository.upsertChunk.mockClear();
    const [row] = body.days;
    const response = await send(sync, {
      ...body,
      days: [
        ...body.days,
        { ...row, date: "0000-01-01" },
        { ...row, date: "2026-02-30" },
        { ...row, inputTokens: -1 },
        { ...row, totalTokens: 1.5 },
        { ...row, model: "m".repeat(257) },
      ],
    });

    expect(response.status).toBe(200);
    expect(
      decodeReleased(RELEASED_CLI_RESPONSES["usage.sync"], await response.json()),
    ).toMatchObject({ received: 8, upserted: 3 });
  });

  it("still rejects structurally invalid payloads", async () => {
    for (const invalid of [
      { ...body, days: "not-an-array" },
      { ...body, days: [1, "row", null] },
      { ...body, days: Array(1_001).fill(body.days[0]) },
      { days: body.days },
    ]) {
      expect((await send(sync, invalid)).status).toBe(400);
    }
  });
});

describe("CLI login boundary", () => {
  const start = fixtures.find(({ file }) => file === "current/cliLogin.start.json")!.fixture;
  const body = start.body as Record<string, unknown>;

  async function expectBadField(response: Response, field: string) {
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      _tag: "BadRequest",
      message: `Invalid request body field \`${field}\`.`,
    });
  }

  it("rejects device ids that are not UUIDs", async () => {
    for (const deviceId of ["", "device_123", "x".repeat(10_000)]) {
      await expectBadField(await send(start, { ...body, deviceId }), "deviceId");
    }
  });

  it("rejects oversized device fields", async () => {
    for (const field of ["deviceArch", "deviceName", "devicePlatform", "deviceVersion"]) {
      await expectBadField(await send(start, { ...body, [field]: "x".repeat(257) }), field);
    }
  });
});
