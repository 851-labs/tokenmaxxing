import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { CliUpgradeRequired, LoginCodeNotFound, TokenmaxxingApi } from "@tokenmaxxing/api-contract";

import { AdminService } from "../admin/service";
import { AuthService } from "../auth/service";
import { CliLoginService } from "../clilogin/service";
import { AppConfig } from "../config";
import { LeaderboardService } from "../leaderboard/service";
import { OAuthProviders } from "../oauth/registry";
import { ProfilesService } from "../profiles/service";
import { StatsService } from "../stats/service";
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

const user = {
  avatarUrl: null,
  id: "user_123",
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

beforeAll(async () => {
  const tokens = TokensService.of({
    deleteDevice: () => Effect.void,
    listDevices: () => Effect.succeed([]),
    listTokens: () => Effect.succeed([]),
    resolveCliToken: (rawToken) =>
      Effect.succeed(
        rawToken === "tmx_fixture"
          ? Option.some({ deviceId: "device_123", tokenId: "token_123", user })
          : Option.none(),
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
      ) as Effect.Effect<Response>,
    );
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

  it.each(fixtures.filter(({ fixture }) => fixture.body !== undefined))(
    "$file is rejected with an undeclared top-level property",
    async ({ fixture }) => {
      const response = await send(fixture, {
        ...(fixture.body as Record<string, unknown>),
        undeclaredProperty: true,
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

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ _tag: "Unauthorized" });
  });

  it("a revoked or unknown CLI token is 401 Unauthorized", async () => {
    const response = await handle(
      new Request("https://api.tokenmaxxing.sh/cli/logout", {
        headers: { authorization: "Bearer tmx_revoked" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("an unknown device code is 404 LoginCodeNotFound", async () => {
    const poll = byFile("current/cliLogin.poll.json");
    const response = await send(poll, { deviceCode: "unknown-device-code" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ _tag: "LoginCodeNotFound" });
  });

  it("an upgrade-required start is 426 CliUpgradeRequired", async () => {
    const start = byFile("current/cliLogin.start.json");
    const response = await send(start, {
      ...(start.body as Record<string, unknown>),
      deviceName: "upgrade-required-host",
    });

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ _tag: "CliUpgradeRequired" });
  });
});

describe("ingest boundary", () => {
  const ingest = fixtures.find(({ file }) => file === "current/usage.ingest.json")!.fixture;
  const body = ingest.body as { reports: Array<Record<string, unknown>> };

  it("rejects nested excess properties, unknown sources, and malformed stats", async () => {
    const [report] = body.reports;
    for (const invalid of [
      { ...body, reports: [{ ...report, extra: 1 }] },
      { ...body, reports: [{ ...report, source: "openclaw" }] },
      { ...body, sourceStats: [{ sessionCount: -1, source: "codex" }] },
      { ...body, sourceStats: [{ sessionCount: "NaN", source: "codex" }] },
      { ...body, reports: Array(65).fill(report) },
    ]) {
      expect((await send(ingest, invalid)).status).toBe(400);
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

  it("rejects profile daily ranges that are not calendar date keys", async () => {
    for (const query of ["since=2026-02-30", "until=tomorrow", "since=2026-6-1"]) {
      const response = await handle(
        new Request(`https://api.tokenmaxxing.sh/profiles/alex/daily?${query}`),
      );
      expect(response.status).toBe(400);
    }
  });
});
