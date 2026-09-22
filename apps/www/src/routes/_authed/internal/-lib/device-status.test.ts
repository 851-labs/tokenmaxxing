import { DeviceId } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

import {
  fleetSummary,
  formatDeviceSystem,
  formatRelativeTime,
  formatVersion,
  repairReasonForDevice,
  serviceStatusTitle,
  type AdminDevice,
} from "./device-status";

describe("device status labels", () => {
  it("prefixes versions once and names unknown ones", () => {
    expect(formatVersion("1.2.3")).toBe("v1.2.3");
    expect(formatVersion("v1.2.3")).toBe("v1.2.3");
    expect(formatVersion(null)).toBe("unknown");
  });

  it("describes the platform with its architecture when known", () => {
    expect(formatDeviceSystem({ arch: "arm64", platform: "darwin" })).toBe("darwin / arm64");
    expect(formatDeviceSystem({ arch: null, platform: "linux" })).toBe("linux");
  });

  it("picks the most urgent repair reason", () => {
    expect(repairReasonForDevice(null)).toBeNull();
    expect(repairReasonForDevice(device())).toBeNull();
    expect(repairReasonForDevice(device({ serviceReloadRequired: true }))).toBe("reload-required");
    expect(
      repairReasonForDevice(device({ serviceReloadRequired: true, serviceSchedulerActive: false })),
    ).toBe("scheduler-inactive");
    expect(
      repairReasonForDevice(device({ serviceSchedulerActive: false, serviceStatus: "failure" })),
    ).toBe("service-failure");
  });

  it("builds the service tooltip from only the fields that are set", () => {
    expect(serviceStatusTitle(device())).toBe("");
    expect(
      serviceStatusTitle(
        device({
          serviceAutoUpdateReason: "manager-missing",
          serviceAutoUpdateStatus: "skipped",
          serviceBackend: "launchd",
          serviceError: "boom",
          serviceRepairReason: "scheduler-inactive",
          serviceRepairStatus: "scheduled",
          serviceRunnerTarget: "darwin-arm64",
          serviceRunnerVersion: "1.4.0",
          serviceSchedulerActive: false,
          serviceStatus: "success",
        }),
      ),
    ).toBe(
      [
        "backend: launchd",
        "service: success",
        "scheduler: inactive",
        "repair: scheduled (scheduler inactive)",
        "auto-update: skipped (manager missing)",
        "runner: v1.4.0 (darwin-arm64)",
        "manual repair: tokenmaxxing service repair",
        "error: boom",
      ].join(" · "),
    );
  });

  it("measures elapsed time against the server's clock", () => {
    const now = "2026-06-21T12:00:00.000Z";
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime("garbage", now)).toBe("—");
    expect(formatRelativeTime("2026-06-21T11:59:45.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-06-21T11:15:00.000Z", now)).toBe("45m ago");
    expect(formatRelativeTime("2026-06-20T00:00:00.000Z", now)).toBe("36h ago");
    expect(formatRelativeTime("2026-06-11T12:00:00.000Z", now)).toBe("10d ago");
    // A check-in stamped slightly ahead of the server clock is not "in the future".
    expect(formatRelativeTime("2026-06-21T12:00:30.000Z", now)).toBe("just now");
  });

  it("summarises fleet health", () => {
    expect(
      fleetSummary({
        healthy: 1_200,
        outdated: 3,
        repairNeeded: 2,
        stale: 1,
        totalDevices: 1_210,
        totalUsers: 900,
        unknown: 4,
        updateBlocked: 0,
      }),
    ).toBe("1,200 healthy · 3 outdated · 0 update blocked · 2 repair needed · 1 stale · 4 unknown");
  });
});

function device(overrides: Partial<AdminDevice> = {}): AdminDevice {
  return {
    arch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: DeviceId.make("device_1"),
    lastCheckInAt: null,
    lastSyncAt: null,
    name: "laptop",
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
    version: null,
    ...overrides,
  };
}
