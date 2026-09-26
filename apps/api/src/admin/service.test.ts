import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AdminUserNotFound, Forbidden, UserId } from "@tokenmaxxing/api-contract";

import { AppConfig } from "../config";
import { adminDeviceRepairReason, type AdminUserSnapshot } from "./fleet";
import { NpmRegistry, type LatestCliRelease } from "./npm-registry";
import { AdminRepository, makeAdminService, type AdminRepositoryShape } from "./service";
import { device, latestRelease, now, snapshot } from "./test-fixtures";

const appConfig = AppConfig.of({
  adminEmails: ["alexandru@851.sh", "pondorasti@gmail.com"],
  apiWorkerName: "tokenmaxxing-api",
  github: { clientId: "github-client", clientSecret: "github-secret" },
  google: { clientId: "google-client", clientSecret: "google-secret" },
  productName: "Tokenmaxxing",
});

function makeRepository(options: {
  allowedEmails?: readonly string[] | undefined;
  onSetShadowBan?: AdminRepositoryShape["setShadowBan"] extends (input: infer Input) => unknown
    ? ((input: Input) => boolean) | undefined
    : never;
  snapshots?: AdminUserSnapshot[] | undefined;
}): AdminRepositoryShape {
  const allowedEmails = new Set(options.allowedEmails ?? []);

  return {
    hasAnyVerifiedEmail: (_userId, emails) =>
      Effect.succeed(emails.some((email) => allowedEmails.has(email))),
    listUserSnapshots: () => Effect.succeed(options.snapshots ?? [snapshot()]),
    setShadowBan: (input) => Effect.succeed(options.onSetShadowBan?.(input) ?? true),
  };
}

async function makeService(
  repository: AdminRepositoryShape,
  options: { latestCliRelease?: LatestCliRelease | undefined } = {},
) {
  return Effect.runPromise(
    makeAdminService({ now: () => now }).pipe(
      Effect.provideService(AdminRepository, repository),
      Effect.provideService(AppConfig, appConfig),
      Effect.provideService(NpmRegistry, {
        latestCliRelease: Effect.succeed(options.latestCliRelease ?? latestRelease),
      }),
    ),
  );
}

describe("AdminService.listUsers", () => {
  it("rejects signed-in users without the admin verified email", async () => {
    const service = await makeService(makeRepository({}));

    await expect(
      Effect.runPromise(service.listUsers(UserId.make("user_123"))),
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it("returns debug rows and summary counts for the admin user", async () => {
    const service = await makeService(makeRepository({ allowedEmails: ["alexandru@851.sh"] }));

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

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
    expect(response.latestCliVersion).toBe("0.5.4");
    expect(response.latestCliVersions).toEqual({
      alpha: "0.5.5-alpha.1",
      beta: null,
      latest: "0.5.4",
      rc: null,
    });
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
      spendUsd: 34.56,
      status: "healthy",
      tokenCount: 2,
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
              id: UserId.make("user_1"),
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
              id: UserId.make("user_2"),
              login: "stale-old",
              name: null,
              updatedAt: "2026-06-19T00:00:00.000Z",
            },
          }),
        ],
      }),
    );

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

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

  it("does not mark a current alpha client outdated against stable latest", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [snapshot({ devices: [device({ version: "0.5.5-alpha.1" })] })],
      }),
    );

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

    expect(response.summary).toMatchObject({
      outdated: 0,
      updateBlocked: 0,
    });
    expect(response.devices[0]).toMatchObject({
      isOutdated: false,
      updateBlockedReason: null,
      updateStatus: "current",
    });
  });

  it("marks an alpha client outdated only against the alpha dist-tag", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [snapshot({ devices: [device({ version: "0.5.5-alpha.0" })] })],
      }),
    );

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

    expect(response.summary).toMatchObject({
      outdated: 1,
      updateBlocked: 0,
    });
    expect(response.devices[0]).toMatchObject({
      isOutdated: true,
      updateStatus: "outdated",
    });
  });

  it("treats alpha update status as unknown when npm has no alpha dist-tag", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [snapshot({ devices: [device({ version: "0.5.5-alpha.0" })] })],
      }),
      {
        latestCliRelease: {
          ...latestRelease,
          versions: { ...latestRelease.versions, alpha: null },
        },
      },
    );

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

    expect(response.summary).toMatchObject({
      outdated: 0,
      updateBlocked: 0,
    });
    expect(response.devices[0]).toMatchObject({
      isOutdated: false,
      updateBlockedReason: null,
      updateStatus: "unknown",
    });
  });

  it("only marks update-blocked when the device is outdated on its own channel", async () => {
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        snapshots: [
          snapshot({
            devices: [
              device({
                id: "current-alpha",
                serviceAutoUpdateReason: "download-failed",
                serviceAutoUpdateStatus: "failure",
                version: "0.5.5-alpha.1",
              }),
              device({
                id: "old-alpha",
                serviceAutoUpdateReason: "download-failed",
                serviceAutoUpdateStatus: "failure",
                version: "0.5.5-alpha.0",
              }),
            ],
          }),
        ],
      }),
    );

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));
    const currentAlpha = response.devices.find((row) => row.device.id === "current-alpha");
    const oldAlpha = response.devices.find((row) => row.device.id === "old-alpha");

    expect(response.summary).toMatchObject({
      outdated: 1,
      updateBlocked: 1,
    });
    expect(currentAlpha).toMatchObject({
      isOutdated: false,
      updateBlockedReason: null,
      updateStatus: "current",
    });
    expect(oldAlpha).toMatchObject({
      isOutdated: true,
      updateBlockedReason: "download-failed",
      updateStatus: "update-blocked",
    });
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
              id: UserId.make("user_joel"),
              login: "joelbqz",
              name: null,
              updatedAt: "2026-06-19T00:00:00.000Z",
            },
          }),
        ],
      }),
    );

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));
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

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

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

    const response = await Effect.runPromise(service.listUsers(UserId.make("user_123")));

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

    await expect(
      Effect.runPromise(service.listUsers(UserId.make("user_123"))),
    ).resolves.toMatchObject({
      summary: { totalUsers: 1 },
    });
  });
});

describe("AdminService shadow bans", () => {
  it("records the actor and timestamp", async () => {
    const updates: Array<{
      at: Date | null;
      byUserId: string | null;
      userId: string;
    }> = [];
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        onSetShadowBan: (input) => {
          updates.push(input);
          return true;
        },
      }),
    );

    const response = await Effect.runPromise(
      service.shadowBanUser(UserId.make("admin_123"), UserId.make("user_456")),
    );

    expect(response).toEqual({
      shadowBan: {
        at: now.toISOString(),
        byUserId: "admin_123",
      },
      userId: "user_456",
    });
    expect(updates).toEqual([
      {
        at: now,
        byUserId: "admin_123",
        userId: "user_456",
      },
    ]);
  });

  it("clears all moderation metadata when unbanning", async () => {
    const updates: Parameters<AdminRepositoryShape["setShadowBan"]>[0][] = [];
    const service = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        onSetShadowBan: (input) => {
          updates.push(input);
          return true;
        },
      }),
    );

    await expect(
      Effect.runPromise(service.shadowUnbanUser(UserId.make("admin_123"), UserId.make("user_456"))),
    ).resolves.toEqual({ shadowBan: null, userId: "user_456" });
    expect(updates).toEqual([{ at: null, byUserId: null, userId: "user_456" }]);
  });

  it("rejects non-admins and reports missing target users", async () => {
    const nonAdmin = await makeService(makeRepository({}));
    await expect(
      Effect.runPromise(nonAdmin.shadowBanUser(UserId.make("user_123"), UserId.make("user_456"))),
    ).rejects.toBeInstanceOf(Forbidden);

    const admin = await makeService(
      makeRepository({
        allowedEmails: ["alexandru@851.sh"],
        onSetShadowBan: () => false,
      }),
    );
    await expect(
      Effect.runPromise(admin.shadowUnbanUser(UserId.make("admin_123"), UserId.make("missing"))),
    ).rejects.toBeInstanceOf(AdminUserNotFound);
  });
});
