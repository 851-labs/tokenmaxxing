import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Forbidden, type AdminUsersResponse } from "@tokenmaxxing/api-contract";

import {
  AdminRepository,
  adminDeviceRepairReason,
  adminDeviceStatus,
  latestReleaseFromRegistryBody,
  makeAdminService,
  type AdminDeviceSnapshot,
  type AdminRepositoryShape,
  type AdminUserSnapshot,
  type LatestCliRelease,
} from "./service";

const now = new Date("2026-06-19T20:00:00.000Z");
const latestRelease: LatestCliRelease = {
  publishedAt: "2026-06-19T19:00:00.000Z",
  version: "0.5.4",
};

interface TestAdminService {
  listUsers(userId: string): Effect.Effect<typeof AdminUsersResponse.Type, Forbidden>;
}

function device(input: Partial<AdminDeviceSnapshot> = {}): AdminDeviceSnapshot {
  return {
    arch: "arm64",
    createdAt: "2026-06-19T18:00:00.000Z",
    id: "device_123",
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
    ...input,
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
        deviceId: "device_123",
        lastUsageDate: "2026-06-19",
        sources: ["codex"],
        totalSpendUsd: 34.56,
        totalTokens: 123_456,
      },
    ],
    devices: [device()],
    sources: ["codex"],
    tokens: [
      { deviceId: "device_123", lastUsedAt: "2026-06-19T19:31:00.000Z", revokedAt: null },
      { deviceId: "device_123", lastUsedAt: null, revokedAt: "2026-06-18T00:00:00.000Z" },
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
      id: "user_123",
      login: "pondorasti",
      name: "Alexandru",
      updatedAt: "2026-06-19T00:00:00.000Z",
    },
    ...input,
  };
}

function makeRepository(options: {
  allowedEmails?: readonly string[] | undefined;
  snapshots?: AdminUserSnapshot[] | undefined;
}): AdminRepositoryShape {
  const allowedEmails = new Set(options.allowedEmails ?? []);

  return {
    hasVerifiedEmail: (_userId, email) => Effect.succeed(allowedEmails.has(email)),
    listUserSnapshots: () => Effect.succeed(options.snapshots ?? [snapshot()]),
  };
}

async function makeService(repository: AdminRepositoryShape) {
  return (await Effect.runPromise(
    makeAdminService({
      fetchLatestCliRelease: () => Effect.succeed(latestRelease),
      now: () => now,
    }).pipe(Effect.provideService(AdminRepository, repository)),
  )) as unknown as TestAdminService;
}

describe("AdminService.listUsers", () => {
  it("rejects signed-in users without the admin verified email", async () => {
    const service = await makeService(makeRepository({}));

    await expect(Effect.runPromise(service.listUsers("user_123"))).rejects.toBeInstanceOf(
      Forbidden,
    );
  });

  it("returns debug rows and summary counts for the admin user", async () => {
    const service = await makeService(makeRepository({ allowedEmails: ["alexandru@851.sh"] }));

    const response = await Effect.runPromise(service.listUsers("user_123"));

    expect(response.summary).toEqual({
      healthy: 1,
      outdated: 0,
      repairNeeded: 0,
      stale: 0,
      totalDevices: 1,
      totalUsers: 1,
      updateBlocked: 0,
      unknown: 0,
    });
    expect(response.latestCliPublishedAt).toBe("2026-06-19T19:00:00.000Z");
    expect(response.rolloutGraceHours).toBe(2);
    expect(response.devices[0]).toMatchObject({
      activeDays: 12,
      activeTokenCount: 1,
      device: {
        id: "device_123",
        name: "Mac.localdomain",
      },
      isOutdated: false,
      lastTokenUsedAt: "2026-06-19T19:31:00.000Z",
      lastUsageDate: "2026-06-19",
      latestCheckInAt: "2026-06-19T19:30:00.000Z",
      revokedTokenCount: 1,
      sources: ["codex"],
      status: "healthy",
      tokenCount: 2,
      totalSpendUsd: 34.56,
      totalTokens: 123_456,
      updateBlockedReason: null,
      updateStatus: "current",
      user: {
        login: "pondorasti",
      },
    });
    expect(response.users[0]).toMatchObject({
      activeTokenCount: 1,
      deviceCount: 1,
      latestCheckInAt: "2026-06-19T19:30:00.000Z",
      revokedTokenCount: 1,
      status: "healthy",
      verifiedEmails: ["alexandru@851.sh"],
    });
  });

  it("counts outdated versions separately from health status", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [
          snapshot({
            devices: [device({ version: "0.5.3" })],
            user: {
              avatarUrl: null,
              createdAt: "2026-06-18T00:00:00.000Z",
              id: "user_1",
              login: "active-old",
              name: null,
              updatedAt: "2026-06-19T00:00:00.000Z",
            },
          }),
          snapshot({
            devices: [device({ lastSyncAt: "2026-06-19T12:00:00.000Z", version: "0.5.3" })],
            user: {
              avatarUrl: null,
              createdAt: "2026-06-18T00:00:00.000Z",
              id: "user_2",
              login: "stale-old",
              name: null,
              updatedAt: "2026-06-19T00:00:00.000Z",
            },
          }),
        ],
      }),
    );

    const response = await Effect.runPromise(service.listUsers("user_123"));

    expect(response.summary).toMatchObject({
      healthy: 1,
      outdated: 2,
      stale: 1,
      totalDevices: 2,
      totalUsers: 2,
      updateBlocked: 0,
    });
    expect(response.devices.map((deviceRow) => deviceRow.status).sort()).toEqual([
      "healthy",
      "stale",
    ]);
    expect(response.devices.every((deviceRow) => deviceRow.isOutdated)).toBe(true);
  });

  it("keeps multiple devices for one user visible as separate fleet rows", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [
          snapshot({
            deviceUsage: [
              {
                activeDays: 4,
                deviceId: "vps-6b1bc496",
                lastUsageDate: "2026-06-13",
                sources: ["codex"],
                totalSpendUsd: 12.34,
                totalTokens: 100_000,
              },
              {
                activeDays: 11,
                deviceId: "mac-joel",
                lastUsageDate: "2026-06-19",
                sources: ["claude", "codex"],
                totalSpendUsd: 45.67,
                totalTokens: 900_000,
              },
            ],
            devices: [
              device({
                arch: "x64",
                id: "vps-6b1bc496",
                lastCheckInAt: "2026-06-19T19:45:00.000Z",
                lastSyncAt: "2026-06-19T19:00:00.000Z",
                name: "joel-vps",
                platform: "linux",
                serviceBackend: "launchd",
                serviceReloadRequired: false,
                serviceRepairAttemptedAt: "2026-06-19T19:10:00.000Z",
                serviceRepairReason: "auto-updated",
                serviceRepairStatus: "scheduled",
                serviceSchedulerActive: true,
                serviceStatus: "success",
                serviceTemplateVersion: 2,
                version: "0.5.4",
              }),
              device({
                arch: "arm64",
                id: "mac-joel",
                lastCheckInAt: null,
                lastSyncAt: "2026-06-19T12:00:00.000Z",
                name: "Joels-MacBook-Pro.local",
                platform: "darwin",
                version: "0.5.4",
              }),
            ],
            tokens: [
              {
                deviceId: "vps-6b1bc496",
                lastUsedAt: "2026-06-19T19:45:00.000Z",
                revokedAt: null,
              },
              {
                deviceId: "mac-joel",
                lastUsedAt: "2026-06-19T12:00:00.000Z",
                revokedAt: null,
              },
            ],
            user: {
              avatarUrl: null,
              createdAt: "2026-06-18T00:00:00.000Z",
              id: "user_joel",
              login: "joelbqz",
              name: null,
              updatedAt: "2026-06-19T00:00:00.000Z",
            },
          }),
        ],
      }),
    );

    const response = await Effect.runPromise(service.listUsers("user_123"));
    const vps = response.devices.find((row) => row.device.id === "vps-6b1bc496");
    const mac = response.devices.find((row) => row.device.id === "mac-joel");

    expect(response.devices).toHaveLength(2);
    expect(response.summary).toMatchObject({
      healthy: 1,
      repairNeeded: 0,
      stale: 1,
      totalDevices: 2,
      totalUsers: 1,
      updateBlocked: 0,
    });
    expect(vps).toMatchObject({
      lastUsageDate: "2026-06-13",
      status: "healthy",
      user: { login: "joelbqz" },
    });
    expect(mac).toMatchObject({
      lastUsageDate: "2026-06-19",
      status: "stale",
      user: { login: "joelbqz" },
    });
    expect(adminDeviceRepairReason(vps?.device ?? null)).toBeNull();
  });

  it("separates update-blocked from machine health", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [
          snapshot({
            devices: [
              device({
                serviceAutoUpdateAttemptedAt: "2026-06-19T19:30:00.000Z",
                serviceAutoUpdateCompletedAt: "2026-06-19T19:30:01.000Z",
                serviceAutoUpdateCurrentVersion: "0.5.3",
                serviceAutoUpdateEnabled: true,
                serviceAutoUpdateError: "npm failed",
                serviceAutoUpdateInstalledVersion: "0.5.3",
                serviceAutoUpdateLatestVersion: "0.5.4",
                serviceAutoUpdateManager: "npm",
                serviceAutoUpdateReason: "package-manager-failed",
                serviceAutoUpdateStatus: "failure",
                version: "0.5.3",
              }),
            ],
          }),
        ],
      }),
    );

    const response = await Effect.runPromise(service.listUsers("user_123"));

    expect(response.summary).toMatchObject({
      healthy: 1,
      outdated: 1,
      updateBlocked: 1,
    });
    expect(response.devices[0]).toMatchObject({
      status: "healthy",
      updateBlockedReason: "package-manager-failed",
      updateStatus: "update-blocked",
    });
  });

  it("does not mark old clients update-blocked when auto-update telemetry is absent", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [snapshot({ devices: [device({ version: "0.5.3" })] })],
      }),
    );

    const response = await Effect.runPromise(service.listUsers("user_123"));

    expect(response.summary).toMatchObject({
      outdated: 1,
      updateBlocked: 0,
    });
    expect(response.devices[0]).toMatchObject({
      status: "healthy",
      updateBlockedReason: null,
      updateStatus: "outdated",
    });
  });

  it("allows the pondorasti Gmail address as an internal admin email", async () => {
    const service = await makeService(makeRepository({ allowedEmails: ["pondorasti@gmail.com"] }));

    await expect(Effect.runPromise(service.listUsers("user_123"))).resolves.toMatchObject({
      summary: { totalUsers: 1 },
    });
  });
});

describe("adminDeviceStatus", () => {
  it("classifies healthy, repair-needed, stale, and unknown devices", () => {
    expect(adminDeviceStatus(device(), latestRelease, now)).toBe("healthy");
    expect(
      adminDeviceStatus(
        device({
          lastCheckInAt: "2026-06-19T19:30:00.000Z",
          serviceSchedulerActive: false,
          serviceStatus: "failure",
        }),
        latestRelease,
        now,
      ),
    ).toBe("repair-needed");
    expect(
      adminDeviceStatus(
        device({ lastCheckInAt: "2026-06-19T19:30:00.000Z", serviceReloadRequired: true }),
        latestRelease,
        now,
      ),
    ).toBe("repair-needed");
    expect(adminDeviceStatus(device({ version: "0.5.3" }), latestRelease, now)).toBe("healthy");
    expect(
      adminDeviceStatus(
        device({ version: "0.5.3" }),
        { publishedAt: "2026-06-19T17:59:59.000Z", version: "0.5.4" },
        now,
      ),
    ).toBe("healthy");
    expect(
      adminDeviceStatus(device({ lastSyncAt: "2026-06-19T12:00:00.000Z" }), latestRelease, now),
    ).toBe("stale");
    expect(
      adminDeviceStatus(
        device({
          lastCheckInAt: "2026-06-19T12:00:00.000Z",
          lastSyncAt: "2026-06-19T19:30:00.000Z",
        }),
        latestRelease,
        now,
      ),
    ).toBe("healthy");
    expect(adminDeviceStatus(device({ arch: null, version: null }), latestRelease, now)).toBe(
      "unknown",
    );
    expect(adminDeviceStatus(device({ lastSyncAt: null }), latestRelease, now)).toBe("unknown");
  });
});

describe("adminDeviceRepairReason", () => {
  it("explains why a device needs repair", () => {
    expect(adminDeviceRepairReason(device({ serviceStatus: "failure" }))).toBe("service-failure");
    expect(adminDeviceRepairReason(device({ serviceSchedulerActive: false }))).toBe(
      "scheduler-inactive",
    );
    expect(adminDeviceRepairReason(device({ serviceReloadRequired: true }))).toBe(
      "reload-required",
    );
    expect(
      adminDeviceRepairReason(
        device({
          serviceRepairReason: "auto-updated",
          serviceRepairStatus: "scheduled",
        }),
      ),
    ).toBeNull();
    expect(
      adminDeviceRepairReason(
        device({
          serviceRepairReason: "auto-updated",
          serviceRepairStatus: "success",
        }),
      ),
    ).toBeNull();
  });
});

describe("latestReleaseFromRegistryBody", () => {
  it("reads the latest dist tag and release timestamp from npm package metadata", () => {
    expect(
      latestReleaseFromRegistryBody({
        "dist-tags": { latest: "0.5.4" },
        time: { "0.5.4": "2026-06-19T19:00:00.000Z" },
      }),
    ).toEqual(latestRelease);
  });
});
