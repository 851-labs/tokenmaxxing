import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AdminUsersResponse,
  CliLoginApproveInput,
  CliLoginPollInput,
  CliLoginStartInput,
  IngestUsageInput,
  LeaderboardResponse,
  ProfileDailyGroupBy,
  ProfileDailyResponse,
  ProfileIdentityResponse,
  ProfileResponse,
  RawUsageReportInput,
  SourceUsageStatsInput,
  StatsResponse,
  SyncUsageInput,
  UsageCheckInInput,
  UsageDayInput,
} from "./schemas";

describe("device telemetry inputs", () => {
  it("keeps old clients without version or arch compatible", async () => {
    await expect(
      Schema.decodeUnknownPromise(CliLoginStartInput)({
        deviceId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
        deviceName: "Mac.localdomain",
        devicePlatform: "darwin",
      }),
    ).resolves.toEqual({
      deviceId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
      deviceName: "Mac.localdomain",
      devicePlatform: "darwin",
    });

    await expect(
      Schema.decodeUnknownPromise(IngestUsageInput)({
        device: { name: "Mac.localdomain", platform: "darwin" },
        reports: [],
      }),
    ).resolves.toEqual({
      device: { name: "Mac.localdomain", platform: "darwin" },
      reports: [],
    });

    await expect(
      Schema.decodeUnknownPromise(SyncUsageInput)({
        days: [],
        device: { name: "Mac.localdomain", platform: "darwin" },
      }),
    ).resolves.toEqual({
      days: [],
      device: { name: "Mac.localdomain", platform: "darwin" },
    });

    await expect(
      Schema.decodeUnknownPromise(UsageCheckInInput)({
        device: { name: "Mac.localdomain", platform: "darwin" },
        service: {
          repairAttemptedAt: "2026-06-21T18:00:00.000Z",
          repairReason: "scheduler-inactive",
          repairStatus: "scheduled",
          status: "success",
        },
      }),
    ).resolves.toEqual({
      device: { name: "Mac.localdomain", platform: "darwin" },
      service: {
        repairAttemptedAt: "2026-06-21T18:00:00.000Z",
        repairReason: "scheduler-inactive",
        repairStatus: "scheduled",
        status: "success",
      },
    });

    await expect(
      Schema.decodeUnknownPromise(UsageCheckInInput)({
        device: {
          arch: "arm64",
          name: "Mac.localdomain",
          platform: "darwin",
          version: "0.5.3",
        },
        service: {
          autoUpdate: {
            attemptedAt: "2026-06-21T18:00:00.000Z",
            completedAt: "2026-06-21T18:00:01.000Z",
            currentVersion: "0.5.3",
            enabled: true,
            error: "download failed",
            installedVersion: "0.5.3",
            latestVersion: "0.5.4",
            manager: "registry",
            reason: "download-failed",
            status: "failure",
          },
          runnerTarget: "linux-x64-baseline-musl",
          runnerVersion: "0.5.3",
          status: "success",
        },
      }),
    ).resolves.toEqual({
      device: {
        arch: "arm64",
        name: "Mac.localdomain",
        platform: "darwin",
        version: "0.5.3",
      },
      service: {
        autoUpdate: {
          attemptedAt: "2026-06-21T18:00:00.000Z",
          completedAt: "2026-06-21T18:00:01.000Z",
          currentVersion: "0.5.3",
          enabled: true,
          error: "download failed",
          installedVersion: "0.5.3",
          latestVersion: "0.5.4",
          manager: "registry",
          reason: "download-failed",
          status: "failure",
        },
        runnerTarget: "linux-x64-baseline-musl",
        runnerVersion: "0.5.3",
        status: "success",
      },
    });
  });

  it("accepts aggregate source stats on raw usage ingestion", async () => {
    await expect(
      Schema.decodeUnknownPromise(IngestUsageInput)({
        device: { name: "Mac.localdomain", platform: "darwin" },
        reports: [],
        sourceStats: [{ sessionCount: 42, source: "codex" }],
      }),
    ).resolves.toEqual({
      device: { name: "Mac.localdomain", platform: "darwin" },
      reports: [],
      sourceStats: [{ sessionCount: 42, source: "codex" }],
    });
  });
});

describe("profile daily responses", () => {
  it("carries chart range metadata separately from sparse usage rows", async () => {
    await expect(
      Schema.decodeUnknownPromise(ProfileDailyResponse)({
        days: [
          {
            date: "2026-06-19",
            key: "claude-opus-4",
            outputTokens: 200,
            spendUsd: 12.34,
            totalTokens: 300,
          },
        ],
        range: {
          firstDate: "2026-01-01",
          lastDate: "2026-06-21",
        },
      }),
    ).resolves.toEqual({
      days: [
        {
          date: "2026-06-19",
          key: "claude-opus-4",
          outputTokens: 200,
          spendUsd: 12.34,
          totalTokens: 300,
        },
      ],
      range: {
        firstDate: "2026-01-01",
        lastDate: "2026-06-21",
      },
    });
  });
});

describe("profile identity responses", () => {
  it("carries only the fields needed by lightweight profile assets", async () => {
    await expect(
      Schema.decodeUnknownPromise(ProfileIdentityResponse)({
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        login: "pondorasti",
      }),
    ).resolves.toEqual({
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      login: "pondorasti",
    });
  });
});

describe("stats responses", () => {
  const totals = {
    activeDays: 12,
    cacheCreationTokens: 30,
    cacheReadTokens: 400,
    deviceCount: 3,
    firstDate: "2026-01-01",
    inputTokens: 100,
    lastDate: "2026-06-21",
    outputTokens: 20,
    rowCount: 42,
    spendUsd: 123.45,
    totalTokens: 550,
    userCount: 2,
  };
  const ranked = {
    key: "gpt-5.5",
    rowCount: 10,
    spendUsd: 100,
    totalTokens: 500,
    userCount: 2,
  };
  const userMetric = {
    activeDays: 7,
    lastDate: "2026-06-21",
    spendUsd: 100,
    totalTokens: 500,
    user: {
      avatarUrl: null,
      login: "pondorasti",
      name: "Alexandru",
    },
  };
  const window = (since: string) => ({
    dailyByModel: [
      { date: "2026-06-21", key: "gpt-5.5", rowCount: 3, spendUsd: 100, totalTokens: 500 },
      { date: "2026-06-21", key: "Other", rowCount: 1, spendUsd: 1, totalTokens: 5 },
    ],
    modelsBySpend: [ranked],
    modelsByTokens: [ranked],
    since,
    sources: [ranked],
    totals,
  });
  const response = {
    generatedAt: "2026-06-21T20:00:00.000Z",
    windows: {
      last30d: window("2026-05-23"),
      ytd: window("2026-01-01"),
    },
  };

  it("carries every window with the same shape", async () => {
    await expect(Schema.decodeUnknownPromise(StatsResponse)(response)).resolves.toMatchObject({
      windows: {
        last30d: {
          dailyByModel: [{ key: "gpt-5.5" }, { key: "Other" }],
          modelsByTokens: [{ key: "gpt-5.5" }],
          since: "2026-05-23",
          totals: { spendUsd: 123.45 },
        },
        ytd: { since: "2026-01-01", sources: [{ key: "gpt-5.5" }] },
      },
    });
  });

  it("requires both windows", async () => {
    const { ytd: _ytd, ...windows } = response.windows;

    await expect(
      Schema.decodeUnknownPromise(StatsResponse)({ ...response, windows }),
    ).rejects.toThrow();
  });

  it("strips internal user ids from leaderboard users when the server encodes", async () => {
    const encoded = await Schema.encodeUnknownPromise(LeaderboardResponse)({
      entries: [{ ...userMetric, rank: 1, user: { ...userMetric.user, id: "user_123" } }],
      metric: "spend",
      window: "30d",
    });

    expect(encoded.entries[0]?.user).toEqual(userMetric.user);
  });
});

describe("admin fleet responses", () => {
  it("carries device owner, service, token, and usage telemetry", async () => {
    const response = {
      devices: [
        {
          activeDays: 7,
          activeTokenCount: 1,
          device: {
            arch: "arm64",
            createdAt: "2026-06-19T18:00:00.000Z",
            id: "device_123",
            lastCheckInAt: "2026-06-19T19:31:00.000Z",
            lastSyncAt: "2026-06-19T19:30:00.000Z",
            name: "Mac.localdomain",
            platform: "darwin",
            serviceAutoUpdateAttemptedAt: "2026-06-19T19:00:00.000Z",
            serviceAutoUpdateCompletedAt: "2026-06-19T19:00:01.000Z",
            serviceAutoUpdateCurrentVersion: "0.5.3",
            serviceAutoUpdateEnabled: true,
            serviceAutoUpdateError: null,
            serviceAutoUpdateInstalledVersion: "0.5.4",
            serviceAutoUpdateLatestVersion: "0.5.4",
            serviceAutoUpdateManager: "registry",
            serviceAutoUpdateReason: null,
            serviceAutoUpdateStatus: "success",
            serviceBackend: "launchd",
            serviceError: null,
            serviceReloadRequired: false,
            serviceRepairAttemptedAt: "2026-06-19T19:00:00.000Z",
            serviceRepairCompletedAt: null,
            serviceRepairError: null,
            serviceRepairReason: "auto-updated",
            serviceRepairStatus: "scheduled",
            serviceRunnerTarget: "windows-arm64",
            serviceRunnerVersion: "0.5.4",
            serviceSchedulerActive: true,
            serviceStatus: "success",
            serviceTemplateVersion: 2,
            version: "0.5.4",
          },
          isOutdated: false,
          lastTokenUsedAt: "2026-06-19T19:31:00.000Z",
          lastUsageDate: "2026-06-19",
          latestCheckInAt: "2026-06-19T19:31:00.000Z",
          revokedTokenCount: 0,
          sources: ["codex"],
          spendUsd: 12.34,
          status: "healthy",
          tokenCount: 1,
          totalTokens: 123_456,
          updateBlockedReason: null,
          updateStatus: "current",
          user: {
            avatarUrl: null,
            id: "user_123",
            login: "pondorasti",
            name: "Alexandru",
          },
        },
      ],
      generatedAt: "2026-06-19T20:00:00.000Z",
      latestCliPublishedAt: "2026-06-19T19:00:00.000Z",
      latestCliVersion: "0.5.4",
      latestCliVersions: {
        alpha: "0.5.5-alpha.1",
        beta: null,
        latest: "0.5.4",
        rc: null,
      },
      staleThresholdHours: 6,
      summary: {
        healthy: 1,
        outdated: 0,
        repairNeeded: 0,
        stale: 0,
        totalDevices: 1,
        totalUsers: 1,
        updateBlocked: 0,
        unknown: 0,
      },
      users: [],
    };

    await expect(Schema.decodeUnknownPromise(AdminUsersResponse)(response)).resolves.toEqual(
      response,
    );
  });
});

describe("public profile daily grouping", () => {
  it("accepts model and source groupings", async () => {
    await expect(Schema.decodeUnknownPromise(ProfileDailyGroupBy)("model")).resolves.toBe("model");
    await expect(Schema.decodeUnknownPromise(ProfileDailyGroupBy)("source")).resolves.toBe(
      "source",
    );
  });

  it("rejects device grouping so hostnames never reach anonymous viewers", async () => {
    await expect(Schema.decodeUnknownPromise(ProfileDailyGroupBy)("device")).rejects.toThrow();
  });
});

const validDay = {
  cacheCreationTokens: 0,
  cacheReadTokens: 10,
  costUsd: 1.25,
  date: "2026-06-21",
  inputTokens: 100,
  model: "claude-opus-4",
  outputTokens: 20,
  source: "claude",
  totalTokens: 130,
};

const validReport = {
  command: ["ccusage@^20", "claude", "daily", "--json", "--breakdown", "--mode", "calculate"],
  payload: { daily: [] },
  reportKind: "daily",
  source: "claude",
};

const device = { name: "Mac.localdomain", platform: "darwin" };

// The struct-level `parseOptions` annotations are not enforced by Effect v4 on
// their own; the API applies these options to CLI payloads explicitly (see
// rejectUndeclaredProperties in apps/api/src/http/layer.ts), so decode the same way here.
const serverParseOptions = { onExcessProperty: "error" } as const;

const decodes = (schema: Schema.Top, input: unknown) =>
  Schema.decodeUnknownPromise(schema as Schema.Codec<unknown, unknown>)(input, serverParseOptions);

describe("usage input validation", () => {
  it("accepts well-formed rows, reports, and stats", async () => {
    await expect(decodes(UsageDayInput, validDay)).resolves.toEqual(validDay);
    await expect(decodes(RawUsageReportInput, validReport)).resolves.toEqual(validReport);
    await expect(
      decodes(SourceUsageStatsInput, { sessionCount: 0, source: "pi" }),
    ).resolves.toEqual({ sessionCount: 0, source: "pi" });
  });

  it("rejects excess properties at every level of the ingest contract", async () => {
    await expect(decodes(UsageDayInput, { ...validDay, projectPath: "/x" })).rejects.toThrow();
    await expect(decodes(RawUsageReportInput, { ...validReport, extra: true })).rejects.toThrow();
    await expect(
      decodes(SourceUsageStatsInput, { sessionCount: 1, source: "codex", extra: 1 }),
    ).rejects.toThrow();
    await expect(
      decodes(IngestUsageInput, { device, reports: [], sneaky: true }),
    ).rejects.toThrow();
    await expect(decodes(SyncUsageInput, { days: [], device, sneaky: true })).rejects.toThrow();
    await expect(
      decodes(UsageCheckInInput, { device, service: { status: "success" }, sneaky: true }),
    ).rejects.toThrow();
  });

  it("rejects sources and report kinds outside the literal sets", async () => {
    for (const source of ["openclaw", "Claude", "claude ", "", 1]) {
      await expect(decodes(UsageDayInput, { ...validDay, source })).rejects.toThrow();
      await expect(decodes(RawUsageReportInput, { ...validReport, source })).rejects.toThrow();
      await expect(decodes(SourceUsageStatsInput, { sessionCount: 1, source })).rejects.toThrow();
    }
    await expect(
      decodes(RawUsageReportInput, { ...validReport, reportKind: "weekly" }),
    ).rejects.toThrow();
  });

  it("rejects negative, fractional, and non-finite token counts", async () => {
    for (const field of [
      "cacheCreationTokens",
      "cacheReadTokens",
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ]) {
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "10"]) {
        await expect(decodes(UsageDayInput, { ...validDay, [field]: value })).rejects.toThrow();
      }
    }
    for (const sessionCount of [-1, 0.5, Number.NaN]) {
      await expect(
        decodes(SourceUsageStatsInput, { sessionCount, source: "codex" }),
      ).rejects.toThrow();
    }
  });

  it("rejects negative and non-finite costs, including JSON NaN/Infinity strings", async () => {
    for (const costUsd of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(decodes(UsageDayInput, { ...validDay, costUsd })).rejects.toThrow();
    }
    // The HTTP JSON codec maps these strings to non-finite numbers.
    const decodeJson = Schema.decodeUnknownPromise(Schema.toCodecJson(UsageDayInput));
    await expect(decodeJson(validDay, serverParseOptions)).resolves.toEqual(validDay);
    for (const costUsd of ["NaN", "Infinity", "-Infinity"]) {
      await expect(decodeJson({ ...validDay, costUsd }, serverParseOptions)).rejects.toThrow();
    }
  });

  it("rejects dates that are not calendar YYYY-MM-DD keys", async () => {
    for (const date of [
      "2026-6-21",
      "2026/06/21",
      "20260621",
      "2026-06-21T00:00:00Z",
      "2026-02-30",
      "2026-13-01",
      "",
      20_260_621,
    ]) {
      await expect(decodes(UsageDayInput, { ...validDay, date })).rejects.toThrow();
    }
  });

  it("rejects usage days before the ingest floor", async () => {
    for (const date of ["0000-01-01", "1970-01-01", "2023-12-31"]) {
      await expect(decodes(UsageDayInput, { ...validDay, date })).rejects.toThrow();
    }
    await expect(decodes(UsageDayInput, { ...validDay, date: "2024-01-01" })).resolves.toEqual({
      ...validDay,
      date: "2024-01-01",
    });
  });

  it("rejects daily reports over the day cap", async () => {
    const withDays = (count: number) => ({
      ...validReport,
      payload: { daily: Array(count).fill({}) },
    });

    await expect(decodes(RawUsageReportInput, withDays(10_000))).resolves.toBeDefined();
    await expect(decodes(RawUsageReportInput, withDays(10_001))).rejects.toThrow(
      "expected at most 10000 daily entries",
    );
    // Session payloads and non-array `daily` values are the lenient parser's job.
    await expect(
      decodes(RawUsageReportInput, {
        ...validReport,
        payload: { sessions: Array(10_001).fill({}) },
        reportKind: "session",
      }),
    ).resolves.toBeDefined();
    await expect(
      decodes(RawUsageReportInput, { ...validReport, payload: { daily: "x" } }),
    ).resolves.toBeDefined();
  });

  it("decodes legacy sync rows leniently but keeps the envelope strict", async () => {
    const invalidRows = [
      { ...validDay, date: "0000-01-01" },
      { ...validDay, inputTokens: -1 },
      { ...validDay, model: "m".repeat(257) },
    ];
    await expect(decodes(SyncUsageInput, { days: invalidRows, device })).resolves.toEqual({
      days: invalidRows,
      device,
    });
    for (const days of [[1], ["row"], [null], [[validDay]], validDay]) {
      await expect(decodes(SyncUsageInput, { days, device })).rejects.toThrow();
    }
  });

  it("caps string and array sizes", async () => {
    await expect(
      decodes(UsageDayInput, { ...validDay, model: "m".repeat(256) }),
    ).resolves.toBeDefined();
    await expect(decodes(UsageDayInput, { ...validDay, model: "m".repeat(257) })).rejects.toThrow();
    await expect(
      decodes(RawUsageReportInput, { ...validReport, command: Array(33).fill("x") }),
    ).rejects.toThrow();
    await expect(
      decodes(RawUsageReportInput, { ...validReport, command: ["x".repeat(257)] }),
    ).rejects.toThrow();
    await expect(
      decodes(IngestUsageInput, { device, reports: Array(64).fill(validReport) }),
    ).resolves.toBeDefined();
    await expect(
      decodes(IngestUsageInput, { device, reports: Array(65).fill(validReport) }),
    ).rejects.toThrow();
    await expect(
      decodes(SyncUsageInput, { days: Array(1_000).fill(validDay), device }),
    ).resolves.toBeDefined();
    await expect(
      decodes(SyncUsageInput, { days: Array(1_001).fill(validDay), device }),
    ).rejects.toThrow();
    await expect(
      decodes(IngestUsageInput, {
        device,
        reports: [],
        sourceStats: Array(65).fill({ sessionCount: 1, source: "codex" }),
      }),
    ).rejects.toThrow();
    await expect(
      decodes(IngestUsageInput, { device: { ...device, name: "h".repeat(257) }, reports: [] }),
    ).rejects.toThrow();
    await expect(
      decodes(IngestUsageInput, { device: { ...device, version: "v".repeat(65) }, reports: [] }),
    ).rejects.toThrow();
  });
});

describe("CLI login inputs", () => {
  const start = {
    deviceArch: "arm64",
    deviceId: "7d0f3a52-5f0a-4f39-9d7c-3b8f1c2a9e11",
    deviceName: "fixture-host",
    devicePlatform: "darwin",
    deviceVersion: "0.6.0",
  };

  it("requires a UUID device id", async () => {
    await expect(decodes(CliLoginStartInput, start)).resolves.toEqual(start);
    await expect(
      decodes(CliLoginStartInput, { ...start, deviceId: start.deviceId.toUpperCase() }),
    ).resolves.toBeDefined();
    for (const deviceId of ["", "device_123", "x".repeat(10_000), `${start.deviceId}/x`]) {
      await expect(decodes(CliLoginStartInput, { ...start, deviceId })).rejects.toThrow();
    }
  });

  it("caps device fields like usage device payloads", async () => {
    await expect(
      decodes(CliLoginStartInput, { ...start, deviceName: "h".repeat(256) }),
    ).resolves.toBeDefined();
    for (const overrides of [
      { deviceName: "h".repeat(257) },
      { devicePlatform: "p".repeat(65) },
      { deviceArch: "a".repeat(65) },
      { deviceVersion: "v".repeat(65) },
    ]) {
      await expect(decodes(CliLoginStartInput, { ...start, ...overrides })).rejects.toThrow();
    }
  });

  it("caps poll and approve codes", async () => {
    await expect(
      decodes(CliLoginPollInput, { deviceCode: "d".repeat(128) }),
    ).resolves.toBeDefined();
    await expect(decodes(CliLoginPollInput, { deviceCode: "d".repeat(129) })).rejects.toThrow();
    await expect(decodes(CliLoginPollInput, { code: "c".repeat(129) })).rejects.toThrow();
    await expect(decodes(CliLoginApproveInput, { code: "c".repeat(129) })).rejects.toThrow();
  });
});

describe("service check-in telemetry", () => {
  const checkIn = (service: Record<string, unknown>) =>
    Schema.decodeUnknownPromise(UsageCheckInInput)(
      { device, service: { status: "failure", ...service } },
      serverParseOptions,
    );

  it("rejects oversized identifiers, versions, and timestamps", async () => {
    for (const field of [
      "backend",
      "repairAttemptedAt",
      "repairCompletedAt",
      "runnerTarget",
      "runnerVersion",
    ]) {
      await expect(checkIn({ [field]: "x".repeat(256) })).resolves.toBeDefined();
      await expect(checkIn({ [field]: "x".repeat(257) })).rejects.toThrow();
    }
    await expect(
      checkIn({
        autoUpdate: {
          enabled: true,
          latestVersion: "x".repeat(257),
          manager: null,
          reason: null,
          status: "failure",
        },
      }),
    ).rejects.toThrow();
  });

  it("truncates long error messages instead of rejecting the check-in", async () => {
    const long = "e".repeat(4 * 1024 * 1024);
    const decoded = await checkIn({
      autoUpdate: { enabled: true, error: long, manager: null, reason: null, status: "failure" },
      error: long,
      repairError: long,
    });

    expect(decoded.service.error).toHaveLength(4_096);
    expect(decoded.service.repairError).toHaveLength(4_096);
    expect(decoded.service.autoUpdate?.error).toHaveLength(4_096);
    await expect(checkIn({ error: "short" })).resolves.toMatchObject({
      service: { error: "short" },
    });
    // A cut never strands half of a surrogate pair.
    const emoji = await checkIn({ error: `${"e".repeat(4_095)}😀` });
    expect(emoji.service.error).toBe("e".repeat(4_095));
  });

  it("encodes long errors unchanged so clients never fail locally", async () => {
    const long = "e".repeat(5_000);
    const encoded = await Schema.encodeUnknownPromise(UsageCheckInInput)({
      device,
      service: { error: long, status: "failure" },
    });

    expect(encoded.service.error).toBe(long);
  });
});

describe("response sources", () => {
  it("stays a plain string so older decoders accept sources added later", async () => {
    await expect(
      decodes(ProfileResponse, {
        stats: {
          activeDays: 1,
          avgSpendPerActiveDay: 1,
          currentStreakDays: 1,
          deviceCount: 1,
          firstDate: "2026-06-21",
          lastDate: "2026-06-21",
          leaderboardRank: null,
          longestStreakDays: 1,
          peakDay: null,
          sessionCount: 0,
          sources: ["some-future-agent"],
          spendUsd: 1,
          topModel: null,
          totalTokens: 1,
        },
        user: { avatarUrl: null, login: "alex", name: null },
      }),
    ).resolves.toMatchObject({ stats: { sources: ["some-future-agent"] } });
  });
});
