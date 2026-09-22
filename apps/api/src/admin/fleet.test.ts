import { describe, expect, it } from "vite-plus/test";

import { adminDeviceRepairReason, adminDeviceStatus } from "./fleet";
import { device, now } from "./test-fixtures";

describe("adminDeviceStatus", () => {
  it("classifies healthy, repair-needed, stale, and unknown devices", () => {
    expect(adminDeviceStatus(device(), now)).toBe("healthy");
    expect(
      adminDeviceStatus(
        device({
          lastCheckInAt: "2026-06-19T19:30:00.000Z",
          serviceSchedulerActive: false,
          serviceStatus: "failure",
        }),
        now,
      ),
    ).toBe("repair-needed");
    expect(
      adminDeviceStatus(
        device({ lastCheckInAt: "2026-06-19T19:30:00.000Z", serviceReloadRequired: true }),
        now,
      ),
    ).toBe("repair-needed");
    expect(adminDeviceStatus(device({ version: "0.5.3" }), now)).toBe("healthy");
    expect(adminDeviceStatus(device({ lastSyncAt: "2026-06-19T12:00:00.000Z" }), now)).toBe(
      "stale",
    );
    expect(
      adminDeviceStatus(
        device({
          lastCheckInAt: "2026-06-19T12:00:00.000Z",
          lastSyncAt: "2026-06-19T19:30:00.000Z",
        }),
        now,
      ),
    ).toBe("healthy");
    expect(adminDeviceStatus(device({ arch: null, version: null }), now)).toBe("unknown");
    expect(adminDeviceStatus(device({ lastSyncAt: null }), now)).toBe("unknown");
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
