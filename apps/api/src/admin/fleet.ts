import type {
  AdminDeviceDebugRow,
  AdminDeviceStatus,
  AdminDeviceUpdateStatus,
  AdminUserDebugRow,
  AdminUsersResponse,
  OAuthProviderId,
  ServiceRepairReasonValue,
  ShadowBan,
} from "@tokenmaxxing/api-contract";

import { toAuthUser } from "../public-user";
import { RELEASE_CHANNELS, type LatestCliRelease, type ReleaseChannel } from "./npm-registry";

/**
 * Fleet health for the admin dashboard: pure functions from repository
 * snapshots plus the latest npm release to per-user and per-device debug rows.
 */

const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

interface AdminAccountSnapshot {
  email: string | null;
  emailVerified: boolean;
  login: string | null;
  provider: OAuthProviderId;
}

type AdminDeviceSnapshot = (typeof AdminDeviceDebugRow.Type)["device"];

interface AdminTokenSnapshot {
  deviceId: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface AdminUsageSnapshot {
  activeDays: number;
  lastUsageDate: string | null;
  totalSpendUsd: number;
  totalTokens: number;
}

interface AdminDeviceUsageSnapshot extends AdminUsageSnapshot {
  deviceId: string;
  sources: string[];
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

function adminUsersReport(
  snapshots: readonly AdminUserSnapshot[],
  latestCliRelease: LatestCliRelease,
  now: Date,
) {
  const devices = adminDeviceDebugRows(snapshots, latestCliRelease, now);

  return {
    devices,
    staleThresholdHours: STALE_THRESHOLD_MS / (60 * 60 * 1000),
    summary: adminSummary(devices, snapshots.length),
    users: snapshots.map((snapshot) => adminUserDebugRow(snapshot, now)),
  };
}

function adminUserDebugRow(snapshot: AdminUserSnapshot, now: Date): typeof AdminUserDebugRow.Type {
  const latestDevice = latestDeviceFor(snapshot.devices);
  const activeTokenCount = snapshot.tokens.filter((token) => token.revokedAt === null).length;
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
    lastTokenUsedAt: maxIso(snapshot.tokens.map((token) => token.lastUsedAt)),
    lastUsageDate: snapshot.usage.lastUsageDate,
    latestCheckInAt: latestDevice === null ? null : latestDeviceCheckIn(latestDevice),
    latestDevice,
    providers,
    revokedTokenCount: snapshot.tokens.length - activeTokenCount,
    shadowBan: snapshot.shadowBan,
    sources: snapshot.sources,
    status: adminDeviceStatus(latestDevice, now),
    tokenCount: snapshot.tokens.length,
    totalSpendUsd: snapshot.usage.totalSpendUsd,
    totalTokens: snapshot.usage.totalTokens,
    updatedAt: snapshot.user.updatedAt,
    user: toAuthUser(snapshot.user),
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
    status: adminDeviceStatus(device, now),
    tokenCount: tokens.length,
    totalSpendUsd: usage?.totalSpendUsd ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    updateBlockedReason:
      updateStatus === "update-blocked" ? adminDeviceUpdateBlockedReason(device) : null,
    updateStatus,
    user: toAuthUser(snapshot.user),
  };
}

function adminDeviceStatus(device: AdminDeviceSnapshot | null, now: Date): AdminDeviceStatus {
  if (device === null) {
    return "unknown";
  }

  if (adminDeviceRepairReason(device) !== null) {
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

  if (now.getTime() - lastSeen > STALE_THRESHOLD_MS) {
    return "stale";
  }

  if (device.arch === null && device.version === null) {
    return "unknown";
  }

  return "healthy";
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

function adminSummary(
  devices: readonly (typeof AdminDeviceDebugRow.Type)[],
  totalUsers: number,
): (typeof AdminUsersResponse.Type)["summary"] {
  const summary = {
    healthy: 0,
    outdated: 0,
    repairNeeded: 0,
    stale: 0,
    totalDevices: 0,
    totalUsers,
    updateBlocked: 0,
    unknown: 0,
  };

  for (const device of devices) {
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
  }

  return summary;
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
  device: AdminDeviceSnapshot,
  latestCliRelease: LatestCliRelease,
): boolean {
  const latestVersion = latestVersionForDevice(device, latestCliRelease);
  if (device.version === null || latestVersion === null) {
    return false;
  }

  return normalizeVersion(device.version) !== normalizeVersion(latestVersion);
}

function adminDeviceUpdateStatus(
  device: AdminDeviceSnapshot,
  latestCliRelease: LatestCliRelease,
): AdminDeviceUpdateStatus {
  if (device.version === null || latestVersionForDevice(device, latestCliRelease) === null) {
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
  device: AdminDeviceSnapshot,
  latestCliRelease: LatestCliRelease,
): string | null {
  if (device.version === null) {
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

function latestDeviceCheckIn(device: AdminDeviceSnapshot): string | null {
  return maxIsoByTime([device.lastCheckInAt, device.lastSyncAt]);
}

function maxIso(values: readonly (string | null)[]): string | null {
  const sorted = values.filter((value): value is string => value !== null).sort();
  return sorted.at(-1) ?? null;
}

function maxIsoByTime(values: readonly (string | null)[]): string | null {
  return (
    values
      .filter((value): value is string => value !== null)
      .sort((left, right) => isoTime(right) - isoTime(left))[0] ?? null
  );
}

function isoTime(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
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

export { adminDeviceRepairReason, adminDeviceStatus, adminUsersReport };

export type { AdminDeviceSnapshot, AdminUserSnapshot };
