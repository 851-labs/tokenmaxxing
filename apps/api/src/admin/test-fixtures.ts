import { DeviceId, UserId } from "@tokenmaxxing/api-contract";

import type { AdminDeviceSnapshot, AdminUserSnapshot } from "./fleet";
import type { LatestCliRelease } from "./npm-registry";

const now = new Date("2026-06-19T20:00:00.000Z");
const latestRelease: LatestCliRelease = {
  publishedAt: "2026-06-19T19:00:00.000Z",
  version: "0.5.4",
  versions: {
    alpha: "0.5.5-alpha.1",
    beta: null,
    latest: "0.5.4",
    rc: null,
  },
};

function device(
  input: Partial<Omit<AdminDeviceSnapshot, "id">> & { id?: string } = {},
): AdminDeviceSnapshot {
  const { id = "device_123", ...rest } = input;

  return {
    arch: "arm64",
    createdAt: "2026-06-19T18:00:00.000Z",
    id: DeviceId.make(id),
    lastCheckInAt: null,
    lastSyncAt: "2026-06-19T19:30:00.000Z",
    name: "Mac.localdomain",
    platform: "darwin",
    serviceAutoUpdateAttemptedAt: null,
    serviceAutoUpdateCompletedAt: null,
    serviceAutoUpdateCurrentVersion: null,
    serviceAutoUpdateEnabled: null,
    serviceAutoUpdateError: null,
    serviceAutoUpdateInstalledVersion: null,
    serviceAutoUpdateLatestVersion: null,
    serviceAutoUpdateManager: null,
    serviceAutoUpdateReason: null,
    serviceAutoUpdateStatus: null,
    serviceBackend: null,
    serviceError: null,
    serviceReloadRequired: null,
    serviceRepairAttemptedAt: null,
    serviceRepairCompletedAt: null,
    serviceRepairError: null,
    serviceRepairReason: null,
    serviceRepairStatus: null,
    serviceRunnerTarget: null,
    serviceRunnerVersion: null,
    serviceSchedulerActive: null,
    serviceStatus: null,
    serviceTemplateVersion: null,
    version: "0.5.4",
    ...rest,
  };
}

function snapshot(input: Partial<AdminUserSnapshot> = {}): AdminUserSnapshot {
  return {
    accounts: [
      {
        email: "alexandru@851.sh",
        emailVerified: true,
        login: "alex",
        provider: "google",
      },
    ],
    deviceUsage: [
      {
        activeDays: 12,
        deviceId: DeviceId.make("device_123"),
        lastUsageDate: "2026-06-19",
        sources: ["codex"],
        totalSpendUsd: 34.56,
        totalTokens: 123_456,
      },
    ],
    devices: [device()],
    sources: ["codex"],
    tokens: [
      {
        deviceId: DeviceId.make("device_123"),
        lastUsedAt: "2026-06-19T19:31:00.000Z",
        revokedAt: null,
      },
      {
        deviceId: DeviceId.make("device_123"),
        lastUsedAt: null,
        revokedAt: "2026-06-18T00:00:00.000Z",
      },
    ],
    usage: {
      activeDays: 12,
      lastUsageDate: "2026-06-19",
      totalSpendUsd: 34.56,
      totalTokens: 123_456,
    },
    user: {
      avatarUrl: null,
      createdAt: "2026-06-18T00:00:00.000Z",
      id: UserId.make("user_123"),
      login: "pondorasti",
      name: "Alexandru",
      updatedAt: "2026-06-19T00:00:00.000Z",
    },
    ...input,
    shadowBan: input.shadowBan ?? null,
  };
}

export { device, latestRelease, now, snapshot };
