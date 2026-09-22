import { Context, Effect } from "effect";

import {
  AdminUserNotFound,
  Forbidden,
  type AdminDeviceDebugRow,
  type AdminDeviceStatus,
  type AdminDeviceUpdateStatus,
  type AdminUserDebugRow,
  type AdminUsersResponse,
  type OAuthProviderId,
  type ShadowBan,
  type ServiceAutoUpdateManagerValue,
  type ServiceAutoUpdateReasonValue,
  type ServiceAutoUpdateStatusValue,
  type ServiceCheckInStatusValue,
  type ServiceRepairReasonValue,
  type ServiceRepairStatusValue,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";

const ADMIN_EMAILS = ["alexandru@851.sh", "pondorasti@gmail.com"] as const;
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const ROLLOUT_GRACE_MS = 2 * 60 * 60 * 1000;
const NPM_PACKAGE_URL = "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing";
const LATEST_VERSION_CACHE_MS = 5 * 60 * 1000;
const RELEASE_CHANNELS = ["latest", "alpha", "beta", "rc"] as const;

type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

interface LatestCliVersions {
  alpha: string | null;
  beta: string | null;
  latest: string | null;
  rc: string | null;
}

interface LatestCliRelease {
  publishedAt: string | null;
  version: string | null;
  versions: LatestCliVersions;
}

interface AdminAccountSnapshot {
  email: string | null;
  emailVerified: boolean;
  login: string | null;
  provider: OAuthProviderId;
}

interface AdminDeviceSnapshot {
  arch: string | null;
  createdAt: string;
  id: string;
  lastCheckInAt: string | null;
  lastSyncAt: string | null;
  name: string;
  platform: string;
  serviceAutoUpdateAttemptedAt: string | null;
  serviceAutoUpdateCompletedAt: string | null;
  serviceAutoUpdateCurrentVersion: string | null;
  serviceAutoUpdateEnabled: boolean | null;
  serviceAutoUpdateError: string | null;
  serviceAutoUpdateInstalledVersion: string | null;
  serviceAutoUpdateLatestVersion: string | null;
  serviceAutoUpdateManager: ServiceAutoUpdateManagerValue | null;
  serviceAutoUpdateReason: ServiceAutoUpdateReasonValue | null;
  serviceAutoUpdateStatus: ServiceAutoUpdateStatusValue | null;
  serviceBackend: string | null;
  serviceError: string | null;
  serviceReloadRequired: boolean | null;
  serviceRepairAttemptedAt: string | null;
  serviceRepairCompletedAt: string | null;
  serviceRepairError: string | null;
  serviceRepairReason: ServiceRepairReasonValue | null;
  serviceRepairStatus: ServiceRepairStatusValue | null;
  serviceRunnerTarget: string | null;
  serviceRunnerVersion: string | null;
  serviceSchedulerActive: boolean | null;
  serviceStatus: ServiceCheckInStatusValue | null;
  serviceTemplateVersion: number | null;
  version: string | null;
}

interface AdminTokenSnapshot {
  deviceId: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface AdminDeviceUsageSnapshot {
  activeDays: number;
  deviceId: string;
  lastUsageDate: string | null;
  sources: string[];
  totalSpendUsd: number;
  totalTokens: number;
}

interface AdminUsageSnapshot {
  activeDays: number;
  lastUsageDate: string | null;
  totalSpendUsd: number;
  totalTokens: number;
}

interface AdminUserSnapshot {
  accounts: AdminAccountSnapshot[];
  deviceUsage: AdminDeviceUsageSnapshot[];
  devices: AdminDeviceSnapshot[];
  sources: string[];
  shadowBan: ShadowBan | null;
  tokens: AdminTokenSnapshot[];
  usage: AdminUsageSnapshot;
  user: {
    avatarUrl: string | null;
    createdAt: string;
    id: string;
    login: string;
    name: string | null;
    updatedAt: string;
  };
}

interface AdminServiceShape {
  listUsers(userId: string): Effect.Effect<typeof AdminUsersResponse.Type, Forbidden>;
  shadowBanUser(
    adminUserId: string,
    targetUserId: string,
  ): Effect.Effect<{ shadowBan: ShadowBan; userId: string }, AdminUserNotFound | Forbidden>;
  shadowUnbanUser(
    adminUserId: string,
    targetUserId: string,
  ): Effect.Effect<{ shadowBan: null; userId: string }, AdminUserNotFound | Forbidden>;
}

interface AdminRepositoryShape {
  hasAnyVerifiedEmail(
    userId: string,
    emails: readonly string[],
  ): Effect.Effect<boolean, DatabaseError>;
  listUserSnapshots(): Effect.Effect<AdminUserSnapshot[], DatabaseError>;
  setShadowBan(input: {
    at: Date | null;
    byUserId: string | null;
    userId: string;
  }): Effect.Effect<boolean, DatabaseError>;
}

interface AdminServiceOptions {
  fetchLatestCliRelease?: (() => Effect.Effect<LatestCliRelease>) | undefined;
  now?: (() => Date) | undefined;
}

class AdminService extends Context.Service<AdminService, AdminServiceShape>()(
  "@tokenmaxxing/api/AdminService",
) {}

class AdminRepository extends Context.Service<AdminRepository, AdminRepositoryShape>()(
  "@tokenmaxxing/api/AdminRepository",
) {}

function makeAdminService(options: AdminServiceOptions = {}) {
  return Effect.gen(function* () {
    const repository = yield* AdminRepository;
    const now = options.now ?? (() => new Date());
    const fetchLatestCliRelease = options.fetchLatestCliRelease ?? defaultFetchLatestCliRelease;

    return AdminService.of({
      listUsers: Effect.fn("AdminService.listUsers")(function* (userId) {
        yield* requireInternalAdmin(repository, userId);

        const generatedAt = now();
        const [latestCliRelease, snapshots] = yield* Effect.all([
          fetchLatestCliRelease(),
          repository.listUserSnapshots().pipe(Effect.orDie),
        ]);
        const users = snapshots.map((snapshot) =>
          adminUserDebugRow(snapshot, latestCliRelease, generatedAt),
        );
        const devices = adminDeviceDebugRows(snapshots, latestCliRelease, generatedAt);

        return {
          devices,
          generatedAt: generatedAt.toISOString(),
          latestCliPublishedAt: latestCliRelease.publishedAt,
          latestCliVersion: latestCliRelease.version,
          latestCliVersions: latestCliRelease.versions,
          rolloutGraceHours: ROLLOUT_GRACE_MS / (60 * 60 * 1000),
          staleThresholdHours: STALE_THRESHOLD_MS / (60 * 60 * 1000),
          summary: adminSummary(devices, snapshots.length),
          users,
        };
      }),
      shadowBanUser: Effect.fn("AdminService.shadowBanUser")(function* (adminUserId, targetUserId) {
        yield* requireInternalAdmin(repository, adminUserId);

        const at = now();
        const updated = yield* repository
          .setShadowBan({
            at,
            byUserId: adminUserId,
            userId: targetUserId,
          })
          .pipe(Effect.orDie);
        if (!updated) {
          return yield* Effect.fail(new AdminUserNotFound({ id: targetUserId }));
        }

        return {
          shadowBan: {
            at: at.toISOString(),
            byUserId: adminUserId,
          },
          userId: targetUserId,
        };
      }),
      shadowUnbanUser: Effect.fn("AdminService.shadowUnbanUser")(
        function* (adminUserId, targetUserId) {
          yield* requireInternalAdmin(repository, adminUserId);

          const updated = yield* repository
            .setShadowBan({
              at: null,
              byUserId: null,
              userId: targetUserId,
            })
            .pipe(Effect.orDie);
          if (!updated) {
            return yield* Effect.fail(new AdminUserNotFound({ id: targetUserId }));
          }

          return { shadowBan: null, userId: targetUserId };
        },
      ),
    });
  });
}

function requireInternalAdmin(
  repository: AdminRepositoryShape,
  userId: string,
): Effect.Effect<void, Forbidden> {
  return Effect.gen(function* () {
    const allowed = yield* isInternalAdmin(repository, userId);
    if (!allowed) {
      return yield* Effect.fail(new Forbidden({ message: "Not found." }));
    }
  });
}

function isInternalAdmin(repository: AdminRepositoryShape, userId: string): Effect.Effect<boolean> {
  return repository.hasAnyVerifiedEmail(userId, ADMIN_EMAILS).pipe(Effect.orDie);
}

function adminUserDebugRow(
  snapshot: AdminUserSnapshot,
  latestCliRelease: LatestCliRelease,
  now: Date,
): typeof AdminUserDebugRow.Type {
  const latestDevice = latestDeviceFor(snapshot.devices);
  const activeTokenCount = snapshot.tokens.filter((token) => token.revokedAt === null).length;
  const revokedTokenCount = snapshot.tokens.length - activeTokenCount;
  const lastTokenUsedAt = maxIso(snapshot.tokens.map((token) => token.lastUsedAt));
  const verifiedEmails = [
    ...new Set(
      snapshot.accounts.flatMap((account) =>
        account.emailVerified && account.email !== null ? [account.email] : [],
      ),
    ),
  ].sort();
  const providers = [...new Set(snapshot.accounts.map((account) => account.provider))].sort();

  return {
    accounts: snapshot.accounts,
    activeDays: snapshot.usage.activeDays,
    activeTokenCount,
    createdAt: snapshot.user.createdAt,
    deviceCount: snapshot.devices.length,
    lastTokenUsedAt,
    lastUsageDate: snapshot.usage.lastUsageDate,
    latestCheckInAt: latestDevice === null ? null : latestDeviceCheckIn(latestDevice),
    latestDevice,
    providers,
    revokedTokenCount,
    shadowBan: snapshot.shadowBan,
    sources: snapshot.sources,
    status: adminDeviceStatus(latestDevice, latestCliRelease, now),
    tokenCount: snapshot.tokens.length,
    totalSpendUsd: snapshot.usage.totalSpendUsd,
    totalTokens: snapshot.usage.totalTokens,
    updatedAt: snapshot.user.updatedAt,
    user: {
      avatarUrl: snapshot.user.avatarUrl,
      id: snapshot.user.id,
      login: snapshot.user.login,
      name: snapshot.user.name,
    },
    verifiedEmails,
  };
}

function adminDeviceDebugRows(
  snapshots: readonly AdminUserSnapshot[],
  latestCliRelease: LatestCliRelease,
  now: Date,
): (typeof AdminDeviceDebugRow.Type)[] {
  return snapshots
    .flatMap((snapshot) => {
      // Index once per user instead of scanning tokens/usage per device.
      const tokensByDevice = new Map<string | null, AdminTokenSnapshot[]>();
      for (const token of snapshot.tokens) {
        const tokens = tokensByDevice.get(token.deviceId);
        if (tokens === undefined) {
          tokensByDevice.set(token.deviceId, [token]);
        } else {
          tokens.push(token);
        }
      }
      const usageByDevice = new Map<string, AdminDeviceUsageSnapshot>();
      for (const usage of snapshot.deviceUsage) {
        if (!usageByDevice.has(usage.deviceId)) {
          usageByDevice.set(usage.deviceId, usage);
        }
      }

      return snapshot.devices.map((device) =>
        adminDeviceDebugRow(
          snapshot,
          device,
          tokensByDevice.get(device.id) ?? [],
          usageByDevice.get(device.id),
          latestCliRelease,
          now,
        ),
      );
    })
    .sort(compareDeviceDebugRows);
}

function adminDeviceDebugRow(
  snapshot: AdminUserSnapshot,
  device: AdminDeviceSnapshot,
  tokens: readonly AdminTokenSnapshot[],
  usage: AdminDeviceUsageSnapshot | undefined,
  latestCliRelease: LatestCliRelease,
  now: Date,
): typeof AdminDeviceDebugRow.Type {
  const activeTokenCount = tokens.filter((token) => token.revokedAt === null).length;
  const updateStatus = adminDeviceUpdateStatus(device, latestCliRelease);

  return {
    activeDays: usage?.activeDays ?? 0,
    activeTokenCount,
    device,
    isOutdated: deviceVersionIsOutdated(device, latestCliRelease),
    lastTokenUsedAt: maxIso(tokens.map((token) => token.lastUsedAt)),
    lastUsageDate: usage?.lastUsageDate ?? null,
    latestCheckInAt: latestDeviceCheckIn(device),
    revokedTokenCount: tokens.length - activeTokenCount,
    sources: usage?.sources ?? [],
    status: adminDeviceStatus(device, latestCliRelease, now),
    tokenCount: tokens.length,
    totalSpendUsd: usage?.totalSpendUsd ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    updateBlockedReason:
      updateStatus === "update-blocked" ? adminDeviceUpdateBlockedReason(device) : null,
    updateStatus,
    user: {
      avatarUrl: snapshot.user.avatarUrl,
      id: snapshot.user.id,
      login: snapshot.user.login,
      name: snapshot.user.name,
    },
  };
}

function adminDeviceStatus(
  device: AdminDeviceSnapshot | null,
  _latestCliRelease: LatestCliRelease,
  now: Date,
): AdminDeviceStatus {
  if (device === null || device.lastSyncAt === null) {
    if (device !== null && deviceNeedsRepair(device)) {
      return "repair-needed";
    }
  }

  if (device === null) {
    return "unknown";
  }

  if (deviceNeedsRepair(device)) {
    return "repair-needed";
  }

  const lastSeenAt = latestDeviceCheckIn(device);
  if (lastSeenAt === null) {
    return "unknown";
  }

  const lastSeen = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeen)) {
    return "unknown";
  }

  const elapsedMs = now.getTime() - lastSeen;
  if (elapsedMs > STALE_THRESHOLD_MS) {
    return "stale";
  }

  if (device.arch === null && device.version === null) {
    return "unknown";
  }

  return "healthy";
}

function adminSummary(devices: readonly (typeof AdminDeviceDebugRow.Type)[], totalUsers: number) {
  return devices.reduce(
    (summary, device) => {
      switch (device.status) {
        case "healthy":
          summary.healthy += 1;
          break;
        case "repair-needed":
          summary.repairNeeded += 1;
          break;
        case "stale":
          summary.stale += 1;
          break;
        case "unknown":
          summary.unknown += 1;
          break;
      }
      if (device.isOutdated) {
        summary.outdated += 1;
      }
      if (device.updateStatus === "update-blocked") {
        summary.updateBlocked += 1;
      }
      summary.totalDevices += 1;

      return summary;
    },
    {
      healthy: 0,
      outdated: 0,
      repairNeeded: 0,
      stale: 0,
      totalDevices: 0,
      totalUsers,
      updateBlocked: 0,
      unknown: 0,
    },
  );
}

function compareDeviceDebugRows(
  left: typeof AdminDeviceDebugRow.Type,
  right: typeof AdminDeviceDebugRow.Type,
): number {
  const leftSeen = isoTime(left.latestCheckInAt);
  const rightSeen = isoTime(right.latestCheckInAt);
  if (leftSeen !== rightSeen) {
    return rightSeen - leftSeen;
  }

  const loginCompare = left.user.login.localeCompare(right.user.login);
  if (loginCompare !== 0) {
    return loginCompare;
  }

  return left.device.name.localeCompare(right.device.name);
}

function deviceVersionIsOutdated(
  device: { version: string | null } | null,
  latestCliRelease: LatestCliRelease,
): boolean {
  const latestVersion = latestVersionForDevice(device, latestCliRelease);
  if (device === null || device.version === null || latestVersion === null) {
    return false;
  }

  return normalizeVersion(device.version) !== normalizeVersion(latestVersion);
}

function adminDeviceUpdateStatus(
  device: AdminDeviceSnapshot | null,
  latestCliRelease: LatestCliRelease,
): AdminDeviceUpdateStatus {
  const latestVersion = latestVersionForDevice(device, latestCliRelease);
  if (device === null || device.version === null || latestVersion === null) {
    return "unknown";
  }

  if (!deviceVersionIsOutdated(device, latestCliRelease)) {
    return "current";
  }

  return device.serviceAutoUpdateStatus === "failure" ||
    device.serviceAutoUpdateStatus === "skipped"
    ? "update-blocked"
    : "outdated";
}

function latestVersionForDevice(
  device: { version: string | null } | null,
  latestCliRelease: LatestCliRelease,
): string | null {
  if (device === null || device.version === null) {
    return null;
  }

  const channel = releaseChannelForVersion(device.version);
  return channel === null ? null : latestCliRelease.versions[channel];
}

function adminDeviceUpdateBlockedReason(device: AdminDeviceSnapshot): string | null {
  return device.serviceAutoUpdateReason ?? device.serviceAutoUpdateError ?? null;
}

function latestDeviceFor(devices: readonly AdminDeviceSnapshot[]): AdminDeviceSnapshot | null {
  return [...devices].sort(compareDevicesByFreshness)[0] ?? null;
}

function compareDevicesByFreshness(left: AdminDeviceSnapshot, right: AdminDeviceSnapshot): number {
  const leftSync = isoTime(latestDeviceCheckIn(left));
  const rightSync = isoTime(latestDeviceCheckIn(right));
  if (leftSync !== rightSync) {
    return rightSync - leftSync;
  }

  return isoTime(right.createdAt) - isoTime(left.createdAt);
}

function maxIso(values: readonly (string | null)[]): string | null {
  const sorted = values.filter((value): value is string => value !== null).sort();
  return sorted.at(-1) ?? null;
}

function isoTime(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function latestDeviceCheckIn(device: AdminDeviceSnapshot): string | null {
  return (
    [device.lastCheckInAt, device.lastSyncAt]
      .filter((value): value is string => value !== null)
      .sort((left, right) => isoTime(right) - isoTime(left))[0] ?? null
  );
}

function deviceNeedsRepair(device: AdminDeviceSnapshot): boolean {
  return adminDeviceRepairReason(device) !== null;
}

function adminDeviceRepairReason(
  device: AdminDeviceSnapshot | null,
): ServiceRepairReasonValue | null {
  if (device === null) {
    return null;
  }

  if (device.serviceStatus === "failure") {
    return "service-failure";
  }
  if (device.serviceSchedulerActive === false) {
    return "scheduler-inactive";
  }
  if (device.serviceReloadRequired === true) {
    return "reload-required";
  }

  return null;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").replace(/\+.*/, "");
}

function releaseChannelForVersion(version: string): ReleaseChannel | null {
  const match = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z]+)(?:[.-].*)?)?$/.exec(normalizeVersion(version));
  if (match === null) {
    return null;
  }

  const prerelease = match[1];
  if (prerelease === undefined) {
    return "latest";
  }

  return isReleaseChannel(prerelease) && prerelease !== "latest" ? prerelease : null;
}

function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(value);
}

let latestReleaseCache: { expiresAt: number; value: LatestCliRelease } | null = null;

function defaultFetchLatestCliRelease(): Effect.Effect<LatestCliRelease> {
  const now = Date.now();
  if (latestReleaseCache !== null && latestReleaseCache.expiresAt > now) {
    return Effect.succeed(latestReleaseCache.value);
  }

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(NPM_PACKAGE_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return noLatestCliRelease();
      }

      const body = (await response.json()) as unknown;
      return latestReleaseFromRegistryBody(body);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => Effect.succeed(noLatestCliRelease())),
    Effect.map((value) => {
      latestReleaseCache = {
        expiresAt: now + LATEST_VERSION_CACHE_MS,
        value,
      };
      return value;
    }),
  );
}

function noLatestCliRelease(): LatestCliRelease {
  return { publishedAt: null, version: null, versions: emptyLatestCliVersions() };
}

function latestReleaseFromRegistryBody(body: unknown): LatestCliRelease {
  if (body === null || typeof body !== "object") {
    return noLatestCliRelease();
  }

  const directVersion = (body as { version?: unknown }).version;
  const distTags = (body as { "dist-tags"?: unknown })["dist-tags"];
  const versions = latestCliVersionsFromDistTags(distTags);
  const latest =
    versions.latest ??
    (typeof directVersion === "string" && directVersion.length > 0 ? directVersion : null);
  if (latest === null) {
    return noLatestCliRelease();
  }

  const times = (body as { time?: unknown }).time;
  const publishedAt =
    times !== null && typeof times === "object"
      ? (times as Record<string, unknown>)[latest]
      : undefined;

  return {
    publishedAt: typeof publishedAt === "string" && publishedAt.length > 0 ? publishedAt : null,
    version: latest,
    versions: { ...versions, latest },
  };
}

function latestCliVersionsFromDistTags(distTags: unknown): LatestCliVersions {
  const versions = emptyLatestCliVersions();
  if (distTags === null || typeof distTags !== "object") {
    return versions;
  }

  const tags = distTags as Record<string, unknown>;
  for (const channel of RELEASE_CHANNELS) {
    const value = tags[channel];
    versions[channel] = typeof value === "string" && value.length > 0 ? value : null;
  }

  return versions;
}

function emptyLatestCliVersions(): LatestCliVersions {
  return {
    alpha: null,
    beta: null,
    latest: null,
    rc: null,
  };
}

export {
  AdminRepository,
  AdminService,
  adminDeviceRepairReason,
  adminDeviceStatus,
  latestReleaseFromRegistryBody,
  makeAdminService,
};

export type { AdminDeviceSnapshot, AdminRepositoryShape, AdminUserSnapshot, LatestCliRelease };
