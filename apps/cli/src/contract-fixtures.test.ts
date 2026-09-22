import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { TokenmaxxingApi, UserId, type AuthUser } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

import type { CcusageSource } from "./ccusage/sources";
import { browserLoginEffect } from "./commands/login";
import { writeServiceCheckIn } from "./commands/service";
import { syncProgram, type SyncAuth } from "./commands/sync";
import {
  ApiClientService,
  BrowserService,
  ClockService,
  ConfigService,
  ConsoleService,
  TerminalService,
  type TokenmaxxingApiClient,
} from "./services";

/**
 * Captures the exact requests this CLI puts on the wire — after its own
 * contract client encodes them — into fixture files the API replays against
 * the real server stack (apps/api/src/http/cli-compat.test.ts). Published
 * CLIs keep sending these shapes forever, so a diff here is a compatibility
 * review, not a snapshot to refresh blindly. Machine-specific device fields
 * are normalized so the fixtures are stable across hosts and releases.
 */

const FIXTURE_DIR = "../../../packages/api-contract/fixtures/cli-requests/current";

const user: AuthUser = {
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  id: UserId.make("user_123"),
  login: "alex",
  name: "Alex",
};

interface CapturedRequest {
  body?: unknown;
  method: string;
  path: string;
}

const cannedResponses: Record<string, unknown> = {
  "GET /me": { user },
  "POST /cli/login/poll": { status: "complete", token: "tmx_fixture", user },
  "POST /cli/login/start": {
    code: "ABCD-1234",
    deviceCode: "device-code-secret",
    expiresAt: "2026-06-21T18:10:00.000Z",
    intervalSeconds: 0,
    userCode: "ABCD-1234",
    verificationUri: "https://tokenmaxxing.example/login/cli?code=ABCD-1234",
  },
  "POST /cli/logout": { ok: true },
  "POST /usage/check-in": { checkedInAt: "2026-06-21T18:00:00.000Z" },
  "POST /usage/ingest": { received: 4, syncedAt: "2026-06-21T18:00:00.000Z", upserted: 7 },
};

async function makeCapturingClient() {
  const captured: CapturedRequest[] = [];
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      captured.push({
        method: request.method,
        path: url.pathname,
        ...(body === undefined ? {} : { body }),
      });
      const response = cannedResponses[`${request.method} ${url.pathname}`];

      return HttpClientResponse.fromWeb(
        request,
        response === undefined ? new Response(null, { status: 500 }) : Response.json(response),
      );
    }),
  );
  const client = await Effect.runPromise(
    HttpApiClient.make(TokenmaxxingApi, { baseUrl: "https://api.tokenmaxxing.example" }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  );

  return { captured, client: client as TokenmaxxingApiClient };
}

function normalizeDevice(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeDevice);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] =
      key === "name" || key === "deviceName"
        ? "fixture-host"
        : key === "arch" || key === "deviceArch"
          ? "arm64"
          : key === "platform" || key === "devicePlatform"
            ? "darwin"
            : key === "version" || key === "deviceVersion"
              ? "0.0.0-fixture"
              : normalizeDevice(entry);
  }

  return normalized;
}

function fixtureFor(endpoint: string, request: CapturedRequest | undefined): string {
  expect(request).toBeDefined();
  const { body, method, path } = request!;
  const fixture = {
    cli: "current",
    endpoint,
    method,
    path,
    ...(body === undefined ? {} : { body: normalizeDevice(body) }),
  };

  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function makeServicesLayer(client: TokenmaxxingApiClient) {
  return Layer.mergeAll(
    Layer.succeed(ApiClientService)({ make: () => Effect.succeed(client) }),
    Layer.succeed(BrowserService)({ open: () => Effect.succeed(undefined) }),
    Layer.succeed(ClockService)({ sleep: () => Effect.succeed(undefined) }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.succeed({ config: fixtureConfig, token: undefined, tokenCleared: false }),
      ensureDeviceId: () => Effect.succeed("7d0f3a52-5f0a-4f39-9d7c-3b8f1c2a9e11"),
      hasEnvToken: () => Effect.succeed(false),
      readConfig: () => Effect.succeed(fixtureConfig),
      writeToken: (token) => Effect.succeed({ ...fixtureConfig, token }),
    }),
    Layer.succeed(ConsoleService)({ error: () => {}, log: () => {} }),
    Layer.succeed(TerminalService)({
      canOpenExternalBrowser: Effect.succeed(true),
      isInteractive: Effect.succeed(true),
    }),
  );
}

const fixtureConfig = {
  apiUrl: "https://api.tokenmaxxing.example",
  wwwUrl: "https://tokenmaxxing.example",
};

/** One realistic `ccusage <source> daily --json --breakdown` report per dialect. */
const dailyReports: Record<string, unknown> = {
  claude: {
    daily: [
      {
        cacheCreationTokens: 6_058_989,
        cacheReadTokens: 652_827_808,
        date: "2026-06-10",
        inputTokens: 355_038,
        modelBreakdowns: [
          {
            cacheCreationTokens: 6_000_000,
            cacheReadTokens: 650_000_000,
            cost: 850.5,
            inputTokens: 350_000,
            modelName: "claude-fable-5",
            outputTokens: 1_400_000,
          },
          {
            cacheCreationTokens: 58_989,
            cacheReadTokens: 2_827_808,
            cost: 0.64,
            inputTokens: 5_038,
            modelName: "claude-haiku-4-5-20251001",
            outputTokens: 38_433,
          },
        ],
        modelsUsed: ["claude-fable-5", "claude-haiku-4-5-20251001"],
        outputTokens: 1_438_433,
        totalCost: 851.14,
        totalTokens: 660_680_268,
      },
    ],
  },
  codex: {
    daily: [
      {
        costUSD: 58.78,
        date: "2026-06-11",
        models: {
          "gpt-5.6-sol": {
            cacheReadTokens: 23_162_112,
            inputTokens: 1_799_323,
            outputTokens: 79_159,
            totalTokens: 25_040_594,
          },
        },
      },
    ],
  },
  hermes: {
    daily: [
      {
        cacheCreationTokens: 20,
        cacheReadTokens: 50,
        date: "2026-06-12",
        inputTokens: 1_200,
        modelBreakdowns: [
          {
            cacheCreationTokens: 20,
            cacheReadTokens: 50,
            cost: 0.34,
            inputTokens: 1_200,
            modelName: "claude-sonnet-4-20250514",
            outputTokens: 300,
          },
        ],
        modelsUsed: ["claude-sonnet-4-20250514"],
        outputTokens: 300,
        totalCost: 0.34,
        totalTokens: 1_580,
      },
    ],
  },
  opencode: {
    daily: [
      {
        date: "2026-06-13",
        inputTokens: 900,
        modelsUsed: ["kimi-k2"],
        outputTokens: 100,
        totalCost: 0.02,
        totalTokens: 1_000,
      },
    ],
  },
};

describe("CLI request fixtures", () => {
  it("captures the usage.ingest payload a full sync uploads", async () => {
    const { captured, client } = await makeCapturingClient();
    const auth: SyncAuth = {
      authSource: "stored",
      client,
      config: { ...fixtureConfig, token: "tmx_fixture" },
      user,
    };

    await Effect.runPromise(
      syncProgram(
        { auth, dryRun: false, json: true, sources: "claude,codex,opencode,hermes" },
        {
          runDailyReport: (source: CcusageSource) =>
            Effect.succeed(dailyReports[source.source] as never),
          runSessionReport: (source: CcusageSource) =>
            Effect.succeed({
              sessions: source.source === "codex" ? [{ sessionId: "a" }, { sessionId: "b" }] : [],
            }),
        },
      ).pipe(Effect.provide(makeServicesLayer(client))),
    );

    const ingest = captured.find((request) => request.path === "/usage/ingest");
    await expect(fixtureFor("usage.ingest", ingest)).toMatchFileSnapshot(
      `${FIXTURE_DIR}/usage.ingest.json`,
    );
  });

  it("captures the service check-in payload", async () => {
    const { captured, client } = await makeCapturingClient();
    const auth: SyncAuth = {
      authSource: "stored",
      client,
      config: { ...fixtureConfig, token: "tmx_fixture" },
      user,
    };

    await Effect.runPromise(
      writeServiceCheckIn(auth, {
        autoUpdate: {
          attemptedAt: "2026-06-21T17:59:00.000Z",
          completedAt: "2026-06-21T17:59:30.000Z",
          currentVersion: "0.5.9",
          enabled: true,
          error: null,
          installedVersion: "0.6.0",
          latestVersion: "0.6.0",
          manager: "registry",
          reason: null,
          status: "success",
        },
        backend: "launchd",
        reloadRequired: false,
        repairAttemptedAt: "2026-06-21T17:58:00.000Z",
        repairReason: "auto-updated",
        repairStatus: "scheduled",
        runnerTarget: "darwin-arm64",
        runnerVersion: "0.6.0",
        schedulerActive: true,
        status: "success",
      }),
    );

    await expect(fixtureFor("usage.checkIn", captured[0])).toMatchFileSnapshot(
      `${FIXTURE_DIR}/usage.checkIn.json`,
    );
  });

  it("captures the browser login start and poll requests", async () => {
    const { captured, client } = await makeCapturingClient();

    await Effect.runPromise(
      browserLoginEffect({ json: true }).pipe(Effect.provide(makeServicesLayer(client))),
    );

    const start = captured.find((request) => request.path === "/cli/login/start");
    const poll = captured.find((request) => request.path === "/cli/login/poll");
    await expect(fixtureFor("cliLogin.start", start)).toMatchFileSnapshot(
      `${FIXTURE_DIR}/cliLogin.start.json`,
    );
    await expect(fixtureFor("cliLogin.poll", poll)).toMatchFileSnapshot(
      `${FIXTURE_DIR}/cliLogin.poll.json`,
    );
  });

  it("captures the bodiless whoami and logout requests", async () => {
    const { captured, client } = await makeCapturingClient();

    await Effect.runPromise(client.me.me());
    await Effect.runPromise(client.usage.logout());

    await expect(fixtureFor("me.me", captured[0])).toMatchFileSnapshot(`${FIXTURE_DIR}/me.me.json`);
    await expect(fixtureFor("usage.logout", captured[1])).toMatchFileSnapshot(
      `${FIXTURE_DIR}/usage.logout.json`,
    );
  });
});
