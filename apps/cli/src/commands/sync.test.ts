import { Cause, Effect, Layer, Option } from "effect";
import type { AuthUser } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vitest";

import { CcusageRunError } from "../ccusage/runner";
import {
  ApiClientService,
  BrowserService,
  BrowserOpenError,
  ClockService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  TerminalService,
  type TokenmaxxingApiClient,
} from "../services";
import { formatUrl } from "../output";
import { browserLoginEffect } from "./login";
import {
  formatSyncUsd,
  openProfileIfAvailable,
  renderSyncSourceResult,
  renderSyncSuccess,
  renderSyncTable,
  resolveSyncAuth,
  sourceStatsForSync,
  syncJsonPayload,
  syncProgram,
  syncStatusForSources,
  SyncAuthValidationError,
  SyncPushError,
  type SyncAuth,
  type SyncSourceIssue,
  uploadUsageReports,
} from "./sync";

interface TestLayerOptions {
  browserOpenError?: BrowserOpenError;
  canOpenExternalBrowser?: boolean;
  envTokenActive?: boolean;
  initialConfig: CliConfig;
  interactive?: boolean;
  meError?: unknown;
}

interface TestState {
  browserUrls: string[];
  clearedTokens: number;
  errors: string[];
  logs: string[];
  madeClients: Array<{ baseUrl: string; token?: string | undefined }>;
  writtenTokens: string[];
}

const user: AuthUser = {
  avatarUrl: null,
  id: "user_123",
  login: "alex",
  name: null,
};

const invalidSessionIssue: SyncSourceIssue = {
  code: "invalid_report",
  message: "ccusage returned an invalid session report",
  report: "session",
};

function ccusageFailure(
  code: "command_failed" | "invalid_report",
  report: "daily" | "session",
  source: string,
) {
  return new CcusageRunError({ cause: new Error(code), code, report, source });
}

function makeTestLayer(options: TestLayerOptions) {
  let currentConfig = options.initialConfig;
  const state: TestState = {
    browserUrls: [],
    clearedTokens: 0,
    errors: [],
    logs: [],
    madeClients: [],
    writtenTokens: [],
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ApiClientService)({
      make: (clientOptions) => {
        state.madeClients.push(clientOptions);

        return Effect.succeed({
          cliLogin: {
            poll: () => Effect.succeed({ status: "complete" as const, token: "tmx_new", user }),
            start: () =>
              Effect.succeed({
                code: "ABC123",
                expiresAt: "2026-06-13T20:00:00.000Z",
                intervalSeconds: 0,
                verificationUri: "https://tokenmaxxing.example/login/cli?code=ABC123",
              }),
          },
          me: {
            me: () =>
              options.meError === undefined
                ? Effect.succeed({ user })
                : Effect.fail(options.meError),
          },
          usage: {
            ingest: () =>
              Effect.succeed({
                received: 0,
                syncedAt: "2026-06-15T00:00:00.000Z",
                upserted: 0,
              }),
            sync: () => Effect.succeed({ upserted: 0 }),
          },
        } as unknown as TokenmaxxingApiClient);
      },
    }),
    Layer.succeed(BrowserService)({
      open: (url) => {
        state.browserUrls.push(url);
        return options.browserOpenError === undefined
          ? Effect.succeed(undefined)
          : Effect.fail(options.browserOpenError);
      },
    }),
    Layer.succeed(ClockService)({
      sleep: () => Effect.succeed(undefined),
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.sync(() => {
          const token = currentConfig.token;
          const { token: _token, ...nextConfig } = currentConfig;
          currentConfig = nextConfig;
          state.clearedTokens += 1;

          return {
            config: nextConfig,
            token,
            tokenCleared: token !== undefined,
          };
        }),
      ensureDeviceId: () => Effect.succeed(currentConfig.deviceId ?? "device_123"),
      hasEnvToken: () => Effect.succeed(options.envTokenActive ?? false),
      readConfig: () => Effect.succeed(currentConfig),
      writeToken: (token) =>
        Effect.sync(() => {
          currentConfig = { ...currentConfig, token };
          state.writtenTokens.push(token);

          return currentConfig;
        }),
    }),
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        state.errors.push(String(message));
      },
      log: (message?: unknown) => {
        state.logs.push(String(message));
      },
    }),
    Layer.succeed(TerminalService)({
      canOpenExternalBrowser: Effect.succeed(options.canOpenExternalBrowser ?? true),
      isInteractive: Effect.succeed(options.interactive ?? true),
    }),
  );

  return { layer, state };
}

function unauthorizedError() {
  return Object.assign(new Error("unauthorized"), { _tag: "Unauthorized" as const });
}

function makeConsoleLayer() {
  const state = {
    errors: [] as string[],
    logs: [] as string[],
    sleeps: [] as number[],
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        state.errors.push(String(message));
      },
      log: (message?: unknown) => {
        state.logs.push(String(message));
      },
    }),
    Layer.succeed(ClockService)({
      sleep: (ms) =>
        Effect.sync(() => {
          state.sleeps.push(ms);
        }),
    }),
  );

  return { layer, state };
}

interface TestUsageIngestRequest {
  payload: {
    device: {
      name: string;
      platform: NodeJS.Platform;
    };
    reports: unknown[];
  };
}

type TestUsageIngest = (
  request: TestUsageIngestRequest,
) => Effect.Effect<{ received: number; syncedAt: string; upserted: number }, unknown>;

function makeUploadAuth(ingest: TestUsageIngest): SyncAuth {
  return {
    authSource: "stored",
    client: {
      usage: {
        ingest,
      },
    } as unknown as TokenmaxxingApiClient,
    config: {
      apiUrl: "https://api.tokenmaxxing.example",
      token: "tmx_test",
      wwwUrl: "https://tokenmaxxing.example",
    },
    user,
  };
}

describe("formatSyncUsd", () => {
  it("matches the site USD formatting for small and large values", () => {
    expect(formatSyncUsd(99.5)).toBe("$99.50");
    expect(formatSyncUsd(100)).toBe("$100");
    expect(formatSyncUsd(2_609.77)).toBe("$2,610");
    expect(formatSyncUsd(11_802.15)).toBe("$11,802");
  });
});

describe("renderSyncTable", () => {
  it("renders a readable source summary table without colors when NO_COLOR is set", () => {
    const table = renderSyncTable(
      [
        {
          source: "claude",
          status: "synced",
          summary: { days: 17, models: 7, rows: 42, sessions: 17, spendUsd: 2_672 },
        },
        {
          source: "opencode",
          status: "synced",
          summary: {
            days: 85,
            models: 9,
            rows: 1_234,
            sessions: null,
            spendUsd: 1_699,
          },
        },
        { reason: "no_data", source: "gemini", status: "skipped", summary: null },
      ],
      { env: { NO_COLOR: "" } },
    );

    expect(table).not.toContain("\x1b");
    expect(table.split("\n").map((line) => line.trim().split(/\s{2,}/))).toEqual([
      ["Agent", "Status", "Days", "Sessions", "Models", "Spend"],
      ["claude", "synced", "17", "17", "7", "$2,672"],
      ["opencode", "synced", "85", "-", "9", "$1,699"],
      ["gemini", "skipped", "-", "-", "-", "-"],
    ]);
  });

  it("colors synced and skipped statuses when colors are enabled", () => {
    const table = renderSyncTable(
      [
        {
          source: "claude",
          status: "synced",
          summary: { days: 17, models: 7, rows: 42, sessions: 17, spendUsd: 2_672 },
        },
        { reason: "no_data", source: "gemini", status: "skipped", summary: null },
      ],
      { env: {} },
    );

    expect(table).toContain("\x1b[32msynced");
    expect(table).toContain("\x1b[33mskipped");
  });

  it("distinguishes partial and failed sources", () => {
    const table = renderSyncTable(
      [
        {
          issue: invalidSessionIssue,
          source: "codex",
          status: "partial",
          summary: { days: 3, models: 2, rows: 6, sessions: null, spendUsd: 12.34 },
        },
        {
          issue: {
            code: "command_failed",
            message: "ccusage command failed",
            report: "daily",
          },
          source: "gemini",
          status: "failed",
          summary: null,
        },
      ],
      { env: { NO_COLOR: "" } },
    );

    expect(table.split("\n").map((line) => line.trim().split(/\s{2,}/))).toEqual([
      ["Agent", "Status", "Days", "Sessions", "Models", "Spend"],
      ["codex", "partial", "3", "-", "2", "$12.34"],
      ["gemini", "failed", "-", "-", "-", "-"],
    ]);
  });
});

describe("renderSyncSourceResult", () => {
  it("renders a concise synced row for interactive sync output", () => {
    expect(
      renderSyncSourceResult({
        source: "claude",
        status: "synced",
        summary: { days: 17, models: 7, rows: 42, sessions: 54, spendUsd: 2_672 },
      }),
    ).toBe("claude synced - 17 days - 54 sessions - 7 models - $2,672");
  });

  it("handles unknown session counts without a dangling placeholder", () => {
    expect(
      renderSyncSourceResult({
        source: "opencode",
        status: "synced",
        summary: { days: 85, models: 9, rows: 123, sessions: null, spendUsd: 1_699 },
      }),
    ).toBe("opencode synced - 85 days - sessions unknown - 9 models - $1,699");
  });

  it("renders skipped sources as a single status row", () => {
    expect(
      renderSyncSourceResult({
        reason: "no_data",
        source: "gemini",
        status: "skipped",
        summary: null,
      }),
    ).toBe("gemini skipped (no data)");
  });

  it("renders partial and failed sources with concise reasons", () => {
    expect(
      renderSyncSourceResult({
        issue: invalidSessionIssue,
        source: "codex",
        status: "partial",
        summary: { days: 3, models: 2, rows: 6, sessions: null, spendUsd: 12.34 },
      }),
    ).toBe(
      "codex partially synced - 3 days - sessions unknown - 2 models - $12.34 - sessions unavailable: ccusage returned an invalid session report",
    );
    expect(
      renderSyncSourceResult({
        issue: {
          code: "command_failed",
          message: "ccusage command failed",
          report: "daily",
        },
        source: "gemini",
        status: "failed",
        summary: null,
      }),
    ).toBe("gemini failed - ccusage command failed");
  });
});

describe("sync source outcomes", () => {
  it("derives ok, partial, and error aggregate statuses", () => {
    const skipped = {
      reason: "no_data" as const,
      source: "gemini",
      status: "skipped" as const,
      summary: null,
    };
    const failed = {
      issue: {
        code: "command_failed" as const,
        message: "ccusage command failed",
        report: "daily" as const,
      },
      source: "codex",
      status: "failed" as const,
      summary: null,
    };

    expect(syncStatusForSources([skipped], 0)).toBe("ok");
    expect(syncStatusForSources([failed, skipped], 0)).toBe("error");
    expect(syncStatusForSources([failed], 2)).toBe("partial");
  });

  it("adds stable source outcomes to JSON without removing the legacy sources map", () => {
    const sourceResults = [
      {
        issue: {
          code: "command_failed" as const,
          message: "ccusage command failed",
          report: "daily" as const,
        },
        source: "codex",
        status: "failed" as const,
        summary: null,
      },
    ];

    expect(
      syncJsonPayload({
        dryRun: true,
        rows: 0,
        sourceResults,
        sources: { codex: null },
        status: "error",
      }),
    ).toEqual({
      dryRun: true,
      rows: 0,
      sourceResults,
      sources: { codex: null },
      status: "error",
    });
  });

  it("continues with successful sources after a daily report failure", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const result = await Effect.runPromise(
      syncProgram(
        { dryRun: true, json: true, sources: "claude,codex" },
        {
          runDailyReport: (source) =>
            source.source === "codex"
              ? Effect.fail(ccusageFailure("command_failed", "daily", source.source))
              : Effect.succeed({ daily: [{ date: "2026-07-22", totalTokens: 10 }] }),
          runSessionReport: () => Effect.succeed({ sessions: [] }),
        },
      ).pipe(Effect.provide(layer)),
    );

    expect(result.status).toBe("partial");
    expect(result.rows).toBe(1);
    expect(result.sourceResults.map(({ source, status }) => ({ source, status }))).toEqual([
      { source: "claude", status: "synced" },
      { source: "codex", status: "failed" },
    ]);
  });

  it("keeps daily rows when the session report fails", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const result = await Effect.runPromise(
      syncProgram(
        { dryRun: true, json: true, sources: "codex" },
        {
          runDailyReport: () =>
            Effect.succeed({ daily: [{ date: "2026-07-22", totalTokens: 10 }] }),
          runSessionReport: (source) =>
            Effect.fail(ccusageFailure("invalid_report", "session", source.source)),
        },
      ).pipe(Effect.provide(layer)),
    );

    expect(result.status).toBe("partial");
    expect(result.rows).toBe(1);
    expect(result.sourceResults[0]).toMatchObject({
      issue: { code: "invalid_report", report: "session" },
      status: "partial",
      summary: { sessions: null },
    });
  });

  it("treats a valid empty daily report as no data", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const result = await Effect.runPromise(
      syncProgram(
        { dryRun: true, json: true, sources: "codex" },
        {
          runDailyReport: () => Effect.succeed({ daily: [] }),
          runSessionReport: () => Effect.die("session report should not run"),
        },
      ).pipe(Effect.provide(layer)),
    );

    expect(result.status).toBe("ok");
    expect(result.sourceResults).toEqual([
      { reason: "no_data", source: "codex", status: "skipped", summary: null },
    ]);
  });
});

describe("sourceStatsForSync", () => {
  it("keeps only sources with known session counts", () => {
    expect(
      sourceStatsForSync([
        {
          source: "claude",
          status: "synced",
          summary: { days: 17, models: 7, rows: 42, sessions: 54, spendUsd: 2_672 },
        },
        {
          source: "codex",
          status: "synced",
          summary: { days: 89, models: 4, rows: 123, sessions: null, spendUsd: 12_172 },
        },
        { reason: "no_data", source: "gemini", status: "skipped", summary: null },
      ]),
    ).toEqual([{ sessionCount: 54, source: "claude" }]);
  });

  it("returns undefined when there is nothing useful to upload", () => {
    expect(
      sourceStatsForSync([
        { reason: "no_data", source: "gemini", status: "skipped", summary: null },
      ]),
    ).toBeUndefined();
  });
});

describe("uploadUsageReports", () => {
  it("shows upload progress while pushing usage", async () => {
    const { layer, state } = makeConsoleLayer();
    const payloads: unknown[] = [];
    const auth = makeUploadAuth((request) =>
      Effect.sync(() => {
        payloads.push(request.payload);

        return {
          received: 1,
          syncedAt: "2026-06-15T00:00:00.000Z",
          upserted: 1,
        };
      }),
    );

    const result = await Effect.runPromise(
      uploadUsageReports({
        auth,
        device: { name: "Mac.local", platform: "darwin" },
        options: { json: false },
        rawReports: [],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.upserted).toBe(1);
    expect(payloads).toEqual([{ device: { name: "Mac.local", platform: "darwin" }, reports: [] }]);
    expect(state.logs).toEqual(["Uploading usage", "Usage uploaded"]);
    expect(state.errors).toEqual([]);
  });

  it("marks the upload row as failed when ingest fails", async () => {
    const { layer, state } = makeConsoleLayer();
    let calls = 0;
    const auth = makeUploadAuth(() => {
      calls += 1;
      return Effect.fail(new Error("network unavailable"));
    });

    const exit = await Effect.runPromiseExit(
      uploadUsageReports({
        auth,
        device: { name: "Mac.local", platform: "darwin" },
        options: { json: false },
        rawReports: [],
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : Option.none();
    expect(Option.isSome(error)).toBe(true);
    if (Option.isNone(error)) {
      throw new Error("expected a typed failure");
    }
    expect(error.value).toBeInstanceOf(SyncPushError);
    expect(calls).toBe(1);
    expect(state.logs).toEqual(["Uploading usage"]);
    expect(state.errors).toEqual(["Failed uploading usage"]);
    expect(state.sleeps).toEqual([]);
  });

  it("retries uploads when an upload policy is provided", async () => {
    const { layer, state } = makeConsoleLayer();
    let calls = 0;
    const auth = makeUploadAuth(() => {
      calls += 1;
      if (calls < 3) {
        return Effect.fail(new Error(`network unavailable ${calls}`));
      }

      return Effect.succeed({
        received: 1,
        syncedAt: "2026-06-15T00:00:00.000Z",
        upserted: 7,
      });
    });

    const result = await Effect.runPromise(
      uploadUsageReports({
        auth,
        device: { name: "Mac.local", platform: "darwin" },
        options: { json: false, silent: true },
        rawReports: [],
        uploadPolicy: {
          attempts: 3,
          backoffMs: [100, 400],
          jitterRatio: 0,
          timeoutMs: 1_000,
        },
      }).pipe(Effect.provide(layer)),
    );

    expect(result.upserted).toBe(7);
    expect(calls).toBe(3);
    expect(state.sleeps).toEqual([100, 400]);
    expect(state.logs).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  it("does not write upload progress for json or silent output", async () => {
    const { layer, state } = makeConsoleLayer();
    const auth = makeUploadAuth(() =>
      Effect.succeed({
        received: 1,
        syncedAt: "2026-06-15T00:00:00.000Z",
        upserted: 1,
      }),
    );

    await Effect.runPromise(
      uploadUsageReports({
        auth,
        device: { name: "Mac.local", platform: "darwin" },
        options: { json: true },
        rawReports: [],
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      uploadUsageReports({
        auth,
        device: { name: "Mac.local", platform: "darwin" },
        options: { json: false, silent: true },
        rawReports: [],
      }).pipe(Effect.provide(layer)),
    );

    expect(state.logs).toEqual([]);
    expect(state.errors).toEqual([]);
  });
});

describe("renderSyncSuccess", () => {
  it("renders a concise success message with a highlighted profile link", () => {
    const output = renderSyncSuccess("https://tokenmaxxing.example/alex", { env: {} });

    expect(output).toBe(
      "\x1b[32mSync complete\x1b[0m\nProfile: \x1b[36;4mhttps://tokenmaxxing.example/alex\x1b[0m",
    );
  });

  it("respects NO_COLOR", () => {
    expect(renderSyncSuccess("https://tokenmaxxing.example/alex", { env: { NO_COLOR: "" } })).toBe(
      "Sync complete\nProfile: https://tokenmaxxing.example/alex",
    );
  });
});

describe("resolveSyncAuth", () => {
  it("keeps --json machine-readable by failing without browser login when no token exists", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: true }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
  });

  it("starts browser login and returns fresh auth for human sync when no token exists", async () => {
    const originalNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    try {
      const exit = await Effect.runPromiseExit(
        resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag !== "Success") {
        throw new Error("expected resolveSyncAuth to succeed");
      }

      const auth = exit.value;
      expect(auth.config.token).toBe("tmx_new");
      expect(auth.user.login).toBe("alex");
      expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
      expect(state.writtenTokens).toEqual(["tmx_new"]);
      expect(state.madeClients).toEqual([
        { baseUrl: "https://api.tokenmaxxing.example" },
        { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
      ]);
      expect(state.logs).toContain("Not logged in; starting browser login");
      expect(state.logs).toContain("Creating login code");
      expect(state.logs).toContain("Code: ABC123");
      expect(state.logs).toContain(
        "Opening \x1b[36;4mhttps://tokenmaxxing.example/login/cli?code=ABC123\x1b[0m",
      );
      expect(state.logs).toContain(
        "Opened \x1b[36;4mhttps://tokenmaxxing.example/login/cli?code=ABC123\x1b[0m",
      );
    } finally {
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  it("skips external browser launch in interactive headless shells and completes manual login", async () => {
    const { layer, state } = makeTestLayer({
      canOpenExternalBrowser: false,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.browserUrls).toEqual([]);
    expect(state.logs).toContain(
      `Open ${formatUrl("https://tokenmaxxing.example/login/cli?code=ABC123")} in your browser to continue`,
    );
    expect(state.errors).toEqual([]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
  });

  it("continues human login when automatic browser launch fails", async () => {
    const { layer, state } = makeTestLayer({
      browserOpenError: new BrowserOpenError({ cause: "xdg-open missing" }),
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.errors).toContain("Could not open browser");
    expect(state.logs).toContain(
      `Open ${formatUrl("https://tokenmaxxing.example/login/cli?code=ABC123")} in your browser to continue`,
    );
    expect(state.writtenTokens).toEqual(["tmx_new"]);
  });

  it("clears a revoked stored token and restarts browser login for human sync", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") {
      throw new Error("expected resolveSyncAuth to succeed");
    }

    const auth = exit.value;
    expect(auth.config.token).toBe("tmx_new");
    expect(state.clearedTokens).toBe(1);
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
  });

  it("does not replace an unauthorized env token", async () => {
    const { layer, state } = makeTestLayer({
      envTokenActive: true,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_env",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(state.browserUrls).toEqual([]);
    expect(state.clearedTokens).toBe(0);
    expect(state.writtenTokens).toEqual([]);
  });

  it("keeps stored tokens when validation fails for network or server reasons", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: new Error("network unavailable"),
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") {
      throw new Error("expected resolveSyncAuth to fail");
    }

    expect(state.browserUrls).toEqual([]);
    expect(state.clearedTokens).toBe(0);
    expect(state.writtenTokens).toEqual([]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
    ]);
    const error = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(error)).toBe(true);
    if (Option.isNone(error)) {
      throw new Error("expected a typed failure");
    }

    expect(error.value).toBeInstanceOf(SyncAuthValidationError);
  });

  it("can show a loading spinner while validating a stored login", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "";
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    try {
      const exit = await Effect.runPromiseExit(
        resolveSyncAuth({ json: false, showStoredLoginSpinner: true }).pipe(Effect.provide(layer)),
      );

      expect(exit._tag).toBe("Success");
      expect(state.logs).toEqual(["Checking current login", "Validated current login"]);
    } finally {
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  it("can replace stored-login validation spinner with a custom success message", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "";
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    try {
      const exit = await Effect.runPromiseExit(
        resolveSyncAuth({
          json: false,
          showStoredLoginSpinner: true,
          storedLoginSuccessMessage: (authenticatedUser) =>
            `Logged in as ${authenticatedUser.login}`,
        }).pipe(Effect.provide(layer)),
      );

      expect(exit._tag).toBe("Success");
      expect(state.logs).toEqual(["Checking current login", "Logged in as alex"]);
    } finally {
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });
});

describe("browserLoginEffect", () => {
  it("keeps --json login from starting when external browser launch is unavailable", async () => {
    const { layer, state } = makeTestLayer({
      canOpenExternalBrowser: false,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      browserLoginEffect({ json: true }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(state.browserUrls).toEqual([]);
    expect(state.madeClients).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
  });
});

describe("openProfileIfAvailable", () => {
  it("opens the profile URL when an external browser is available", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    await Effect.runPromise(
      openProfileIfAvailable("https://tokenmaxxing.example/alex").pipe(Effect.provide(layer)),
    );

    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/alex"]);
    expect(state.errors).toEqual([]);
    expect(state.logs).toEqual([
      "Opening profile",
      `Opened ${formatUrl("https://tokenmaxxing.example/alex")}`,
    ]);
  });

  it("skips profile opening when no external browser is available", async () => {
    const { layer, state } = makeTestLayer({
      canOpenExternalBrowser: false,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    await Effect.runPromise(
      openProfileIfAvailable("https://tokenmaxxing.example/alex").pipe(Effect.provide(layer)),
    );

    expect(state.browserUrls).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  it("keeps sync successful when profile opening fails", async () => {
    const { layer, state } = makeTestLayer({
      browserOpenError: new BrowserOpenError({ cause: "xdg-open missing" }),
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    await Effect.runPromise(
      openProfileIfAvailable("https://tokenmaxxing.example/alex").pipe(Effect.provide(layer)),
    );

    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/alex"]);
    expect(state.errors).toContain("Could not open profile");
    expect(state.logs).toContain(
      `Open ${formatUrl("https://tokenmaxxing.example/alex")} in your browser`,
    );
  });
});
