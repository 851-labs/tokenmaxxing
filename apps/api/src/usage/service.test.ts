import { DeviceMissing, type RawUsageReportInput } from "@tokenmaxxing/api-contract";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeUsageService,
  UsageRepository,
  type SyncResult,
  type StoredRawUsageReport,
  type UsageRepositoryShape,
  type UsageServiceCheckIn,
} from "./service";
import { RawUsageStorageError } from "./raw-store";

const user = {
  avatarUrl: null,
  id: "user_123",
  login: "alex",
  name: null,
};

const device = {
  name: "Mac.localdomain",
  platform: "darwin",
};

const usageDay = {
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 12.34,
  date: "2026-06-15",
  inputTokens: 100,
  model: "GPT-5.5",
  outputTokens: 200,
  source: "codex",
  totalTokens: 300,
};

const sourceStats = [{ sessionCount: 706, source: "codex" }];

const rawReports: RawUsageReportInput[] = [
  {
    command: ["ccusage@^20", "codex", "daily", "--json", "--breakdown", "--mode", "calculate"],
    payload: {
      daily: [
        {
          costUSD: 12.34,
          date: "2026-06-15",
          models: {
            "[codex] GPT-5.5": {
              inputTokens: 100,
              outputTokens: 200,
              totalTokens: 300,
            },
          },
        },
      ],
    },
    reportKind: "daily",
    source: "codex",
  },
  {
    command: ["ccusage@^20", "codex", "session", "--json", "--mode", "calculate"],
    payload: { sessions: [{ sessionId: "a" }, { sessionId: "b" }] },
    reportKind: "session",
    source: "codex",
  },
];

interface TestUsageService {
  checkIn(
    identity: {
      deviceId: string | null;
      tokenId: string;
      user: typeof user;
    },
    syncDevice: typeof device,
    service: UsageServiceCheckIn,
  ): Effect.Effect<{ checkedInAt: string }, DeviceMissing>;
  syncBatch(
    identity: {
      deviceId: string | null;
      tokenId: string;
      user: typeof user;
    },
    syncDevice: typeof device,
    days: readonly (typeof usageDay)[],
    syncSourceStats?: readonly (typeof sourceStats)[number][],
  ): Effect.Effect<SyncResult, DeviceMissing>;
  ingestRaw(
    identity: {
      deviceId: string | null;
      tokenId: string;
      user: typeof user;
    },
    syncDevice: typeof device,
    reports: readonly RawUsageReportInput[],
  ): Effect.Effect<SyncResult, DeviceMissing>;
}

interface RepositoryOptions {
  rawReportsError?: RawUsageStorageError;
}

function makeRepository(options: RepositoryOptions = {}) {
  const checkInDevice = vi.fn(() => Effect.succeed(undefined));
  const upsertChunk = vi.fn(() => Effect.succeed(undefined));
  const touchDevice = vi.fn(() => Effect.succeed(undefined));
  const upsertSourceStats = vi.fn(() => Effect.succeed(undefined));
  const upsertRawReports = vi.fn(() =>
    options.rawReportsError === undefined
      ? Effect.succeed(undefined)
      : Effect.fail(options.rawReportsError),
  );

  const repository: UsageRepositoryShape = {
    checkInDevice,
    touchDevice,
    upsertChunk,
    upsertRawReports,
    upsertSourceStats,
  };

  return {
    checkInDevice,
    repository,
    touchDevice,
    upsertChunk,
    upsertRawReports,
    upsertSourceStats,
  };
}

async function makeService(repository: UsageRepositoryShape) {
  return (await Effect.runPromise(
    makeUsageService().pipe(Effect.provideService(UsageRepository, repository)),
  )) as unknown as TestUsageService;
}

describe("UsageService.checkIn", () => {
  it("touches service telemetry without writing usage rows", async () => {
    const { checkInDevice, repository, touchDevice, upsertChunk, upsertSourceStats } =
      makeRepository();
    const service = await makeService(repository);

    const result = await Effect.runPromise(
      service.checkIn({ deviceId: "device_123", tokenId: "token_123", user }, device, {
        autoUpdate: {
          attemptedAt: "2026-06-21T18:00:00.000Z",
          completedAt: "2026-06-21T18:00:01.000Z",
          currentVersion: "0.4.13",
          enabled: true,
          error: "npm failed",
          installedVersion: "0.4.13",
          latestVersion: "0.4.14",
          manager: "npm",
          reason: "package-manager-failed",
          status: "failure",
        },
        repairAttemptedAt: "2026-06-21T18:00:00.000Z",
        repairReason: "scheduler-inactive",
        repairStatus: "scheduled",
        schedulerActive: true,
        status: "success",
      }),
    );

    expect(result.checkedInAt).toEqual(expect.any(String));
    expect(checkInDevice).toHaveBeenCalledWith(
      "device_123",
      device,
      {
        autoUpdate: {
          attemptedAt: "2026-06-21T18:00:00.000Z",
          completedAt: "2026-06-21T18:00:01.000Z",
          currentVersion: "0.4.13",
          enabled: true,
          error: "npm failed",
          installedVersion: "0.4.13",
          latestVersion: "0.4.14",
          manager: "npm",
          reason: "package-manager-failed",
          status: "failure",
        },
        repairAttemptedAt: "2026-06-21T18:00:00.000Z",
        repairReason: "scheduler-inactive",
        repairStatus: "scheduled",
        schedulerActive: true,
        status: "success",
      },
      expect.any(Date),
    );
    expect(upsertChunk).not.toHaveBeenCalled();
    expect(upsertSourceStats).not.toHaveBeenCalled();
    expect(touchDevice).not.toHaveBeenCalled();
  });

  it("does not check in when the token has no device", async () => {
    const { checkInDevice, repository } = makeRepository();
    const service = await makeService(repository);

    await expect(
      Effect.runPromise(
        service.checkIn({ deviceId: null, tokenId: "token_123", user }, device, {
          status: "started",
        }),
      ),
    ).rejects.toBeInstanceOf(DeviceMissing);

    expect(checkInDevice).not.toHaveBeenCalled();
  });
});

describe("UsageService.syncBatch", () => {
  it("upserts daily rows, source stats, and touches the device", async () => {
    const { repository, touchDevice, upsertChunk, upsertSourceStats } = makeRepository();
    const service = await makeService(repository);

    const result = await Effect.runPromise(
      service.syncBatch(
        { deviceId: "device_123", tokenId: "token_123", user },
        device,
        [usageDay],
        sourceStats,
      ),
    );

    expect(result.received).toBe(1);
    expect(result.upserted).toBe(1);
    expect(upsertChunk).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      [usageDay],
      expect.any(Date),
    );
    expect(upsertSourceStats).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      sourceStats,
      expect.any(Date),
    );
    expect(touchDevice).toHaveBeenCalledWith("device_123", device, expect.any(Date));
    expect(upsertChunk.mock.invocationCallOrder[0]).toBeLessThan(
      upsertSourceStats.mock.invocationCallOrder[0]!,
    );
    expect(upsertSourceStats.mock.invocationCallOrder[0]).toBeLessThan(
      touchDevice.mock.invocationCallOrder[0]!,
    );
  });

  it("normalizes and merges legacy structured rows before upserting", async () => {
    const { repository, upsertChunk } = makeRepository();
    const service = await makeService(repository);
    const prefixed = {
      ...usageDay,
      costUsd: 1,
      inputTokens: 10,
      model: "[codex] GPT-5.5",
      outputTokens: 20,
      totalTokens: 30,
    };

    const result = await Effect.runPromise(
      service.syncBatch({ deviceId: "device_123", tokenId: "token_123", user }, device, [
        prefixed,
        usageDay,
      ]),
    );

    expect(result).toMatchObject({ received: 2, upserted: 1 });
    expect(upsertChunk).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      [
        {
          ...usageDay,
          costUsd: 13.34,
          inputTokens: 110,
          outputTokens: 220,
          totalTokens: 330,
        },
      ],
      expect.any(Date),
    );
  });

  it("does not touch storage when the token has no device", async () => {
    const { repository, touchDevice, upsertChunk, upsertSourceStats } = makeRepository();
    const service = await makeService(repository);

    await expect(
      Effect.runPromise(
        service.syncBatch({ deviceId: null, tokenId: "token_123", user }, device, []),
      ),
    ).rejects.toBeInstanceOf(DeviceMissing);

    expect(upsertChunk).not.toHaveBeenCalled();
    expect(upsertSourceStats).not.toHaveBeenCalled();
    expect(touchDevice).not.toHaveBeenCalled();
  });
});

describe("UsageService.ingestRaw", () => {
  it("stores raw reports, derives structured rows, and touches the device", async () => {
    const { repository, touchDevice, upsertChunk, upsertRawReports, upsertSourceStats } =
      makeRepository();
    const service = await makeService(repository);

    const result = await Effect.runPromise(
      service.ingestRaw({ deviceId: "device_123", tokenId: "token_123", user }, device, rawReports),
    );

    expect(result.received).toBe(2);
    expect(result.upserted).toBe(1);
    expect(upsertRawReports).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      expect.arrayContaining([
        expect.objectContaining<Partial<StoredRawUsageReport>>({
          ccusageCommand: "ccusage@^20 codex daily --json --breakdown --mode calculate",
          objectKey: expect.stringMatching(
            /^users\/user_123\/devices\/device_123\/ccusage\/codex\/daily\/[a-f0-9]+\.json$/,
          ) as unknown as string,
          payloadBytes: JSON.stringify(rawReports[0]!.payload).length,
          payloadJson: JSON.stringify(rawReports[0]!.payload),
          parserVersion: "ccusage-v20-raw-2",
          reportKind: "daily",
          source: "codex",
        }),
        expect.objectContaining<Partial<StoredRawUsageReport>>({
          ccusageCommand: "ccusage@^20 codex session --json --mode calculate",
          objectKey: expect.stringMatching(
            /^users\/user_123\/devices\/device_123\/ccusage\/codex\/session\/[a-f0-9]+\.json$/,
          ) as unknown as string,
          payloadBytes: JSON.stringify(rawReports[1]!.payload).length,
          payloadJson: JSON.stringify(rawReports[1]!.payload),
          reportKind: "session",
          source: "codex",
        }),
      ]),
      expect.any(Date),
    );
    expect(upsertChunk).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      [usageDay],
      expect.any(Date),
    );
    expect(upsertSourceStats).toHaveBeenCalledWith(
      "user_123",
      "device_123",
      [{ sessionCount: 2, source: "codex" }],
      expect.any(Date),
    );
    expect(touchDevice).toHaveBeenCalledWith("device_123", device, expect.any(Date));
    expect(upsertRawReports.mock.invocationCallOrder[0]).toBeLessThan(
      upsertChunk.mock.invocationCallOrder[0]!,
    );
  });

  it("does not write structured rows when raw persistence fails", async () => {
    const rawReportsError = new RawUsageStorageError({ cause: "r2 down" });
    const { repository, touchDevice, upsertChunk, upsertRawReports, upsertSourceStats } =
      makeRepository({ rawReportsError });
    const service = await makeService(repository);

    await expect(
      Effect.runPromise(
        service.ingestRaw(
          { deviceId: "device_123", tokenId: "token_123", user },
          device,
          rawReports,
        ),
      ),
    ).rejects.toBe(rawReportsError);

    expect(upsertRawReports).toHaveBeenCalled();
    expect(upsertChunk).not.toHaveBeenCalled();
    expect(upsertSourceStats).not.toHaveBeenCalled();
    expect(touchDevice).not.toHaveBeenCalled();
  });
});
