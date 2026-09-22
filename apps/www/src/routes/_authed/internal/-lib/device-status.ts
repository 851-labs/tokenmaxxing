import type { AdminUsersResponse, ServiceRepairReasonValue } from "@tokenmaxxing/api-contract";

import { formatInteger } from "../../../../lib/format";

/** Pure labelling for the internal fleet view: versions, service health, timing. */

type AdminDevice = AdminUsersResponse["devices"][number]["device"];
type NullableDeviceField = {
  [Key in keyof AdminDevice]: null extends AdminDevice[Key] ? Key : never;
}[keyof AdminDevice];
type TitlePart = (device: AdminDevice) => string | undefined;

const REPAIR_REASON_LABELS: Record<ServiceRepairReasonValue, string> = {
  "auto-updated": "auto updated",
  "reload-required": "reload required",
  "scheduler-inactive": "scheduler inactive",
  "service-failure": "service failure",
};

/** A title part rendered only when `key` is set on the device. */
function field<Key extends NullableDeviceField>(
  key: Key,
  format: (value: NonNullable<AdminDevice[Key]>, device: AdminDevice) => string,
): TitlePart {
  return (device) => {
    const value = device[key];
    return value === null ? undefined : format(value as NonNullable<AdminDevice[Key]>, device);
  };
}

/** Tooltip parts for a device's service state, in display order. */
const SERVICE_TITLE_PARTS: readonly TitlePart[] = [
  field("serviceBackend", (value) => `backend: ${value}`),
  field("serviceStatus", (value) => `service: ${value}`),
  field("serviceSchedulerActive", (value) => `scheduler: ${value ? "active" : "inactive"}`),
  field("serviceReloadRequired", (value) => `reload: ${value ? "required" : "not required"}`),
  field(
    "serviceRepairStatus",
    (value, device) =>
      `repair: ${value}${
        device.serviceRepairReason === null
          ? ""
          : ` (${repairReasonLabel(device.serviceRepairReason)})`
      }`,
  ),
  field("serviceRepairAttemptedAt", (value) => `repair attempt: ${value}`),
  field("serviceRepairCompletedAt", (value) => `repair completed: ${value}`),
  field("serviceRepairError", (value) => `repair error: ${value}`),
  field(
    "serviceAutoUpdateStatus",
    (value, device) =>
      `auto-update: ${value}${
        device.serviceAutoUpdateReason === null
          ? ""
          : ` (${updateBlockedReasonLabel(device.serviceAutoUpdateReason)})`
      }`,
  ),
  field("serviceAutoUpdateManager", (value) => `auto-update manager: ${value}`),
  field(
    "serviceAutoUpdateCurrentVersion",
    (value) => `auto-update current: ${formatVersion(value)}`,
  ),
  field("serviceAutoUpdateLatestVersion", (value) => `auto-update latest: ${formatVersion(value)}`),
  field(
    "serviceAutoUpdateInstalledVersion",
    (value) => `auto-update installed: ${formatVersion(value)}`,
  ),
  field(
    "serviceRunnerVersion",
    (value, device) =>
      `runner: ${formatVersion(value)}${
        device.serviceRunnerTarget === null ? "" : ` (${device.serviceRunnerTarget})`
      }`,
  ),
  field("serviceAutoUpdateError", (value) => `auto-update error: ${value}`),
  (device) =>
    repairReasonForDevice(device) === null
      ? undefined
      : "manual repair: tokenmaxxing service repair",
  field("serviceError", (value) => `error: ${value}`),
];

function serviceStatusTitle(device: AdminDevice): string {
  return SERVICE_TITLE_PARTS.map((part) => part(device))
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/** The first repair the device needs, in priority order. */
function repairReasonForDevice(device: AdminDevice | null): ServiceRepairReasonValue | null {
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

function repairReasonLabel(reason: ServiceRepairReasonValue): string {
  return REPAIR_REASON_LABELS[reason];
}

function updateBlockedReasonLabel(reason: string): string {
  return reason.replaceAll("-", " ");
}

function formatVersion(version: string | null): string {
  if (version === null) {
    return "unknown";
  }

  return version.startsWith("v") ? version : `v${version}`;
}

function formatDeviceSystem(device: Pick<AdminDevice, "arch" | "platform">): string {
  return device.arch === null ? device.platform : `${device.platform} / ${device.arch}`;
}

/** Elapsed time from `value` to the server's `now` — both ISO timestamps. */
function formatRelativeTime(value: string | null, now: string): string {
  if (value === null) {
    return "—";
  }

  const elapsedMs = Date.parse(now) - Date.parse(value);
  if (!Number.isFinite(elapsedMs)) {
    return "—";
  }

  const minutes = Math.max(Math.floor(elapsedMs / 60_000), 0);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function fleetSummary(summary: AdminUsersResponse["summary"]): string {
  return [
    `${formatInteger(summary.healthy)} healthy`,
    `${formatInteger(summary.outdated)} outdated`,
    `${formatInteger(summary.updateBlocked)} update blocked`,
    `${formatInteger(summary.repairNeeded)} repair needed`,
    `${formatInteger(summary.stale)} stale`,
    `${formatInteger(summary.unknown)} unknown`,
  ].join(" · ");
}

export {
  fleetSummary,
  formatDeviceSystem,
  formatRelativeTime,
  formatVersion,
  repairReasonForDevice,
  repairReasonLabel,
  serviceStatusTitle,
  updateBlockedReasonLabel,
};

export type { AdminDevice };
