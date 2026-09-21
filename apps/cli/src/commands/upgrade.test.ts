import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ConsoleService } from "../services";
import type { CommandInstall } from "./service";
import {
  formatServiceRefreshResult,
  formatUpgradeSuccess,
  refreshInstalledService,
  upgradeProgram,
} from "./upgrade";

const install: CommandInstall = {
  autoUpdateManager: "npm",
  commandPath: "/usr/local/bin/tokenmaxxing",
  resolvedCommandPath: "/usr/local/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
};

function testConsole() {
  const logs: string[] = [];
  const layer = Layer.succeed(ConsoleService)({
    error: (message?: unknown) => {
      logs.push(String(message));
    },
    log: (message?: unknown) => {
      logs.push(String(message));
    },
  });

  return { layer, logs };
}

describe("upgradeProgram", () => {
  it("upgrades through the detected package manager and skips service refresh when absent", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        getLatestVersion: () => Effect.succeed("0.4.4"),
        isServiceInstalled: () => Effect.succeed(false),
        runPackageManagerUpdate: (manager) =>
          Effect.sync(() => {
            managers.push(manager);
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(managers).toEqual(["npm"]);
    expect(logs).toEqual([
      "Detecting install method",
      "Using method: npm",
      "Checking latest version",
      "From 0.4.3 -> 0.4.4",
      "Running npm install -g @851-labs/tokenmaxxing@latest --silent",
      "Upgraded to v0.4.4",
      "Refreshing service",
      "Service: not installed",
    ]);
  });

  it("skips the package manager update when no update is pending", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];
    const refreshes: Array<{ commandPath: string }> = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        getLatestVersion: () => Effect.succeed("0.4.3"),
        isServiceInstalled: () => Effect.succeed(true),
        refreshService: (options) =>
          Effect.sync(() => {
            refreshes.push(options);
          }),
        runPackageManagerUpdate: (manager) =>
          Effect.sync(() => {
            managers.push(manager);
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(managers).toEqual([]);
    expect(refreshes).toEqual([]);
    expect(logs).toEqual([
      "Detecting install method",
      "Using method: npm",
      "Checking latest version",
      "No updates pending (0.4.3); upgrade skipped",
    ]);
  });

  it("falls back to running the upgrade when latest version lookup fails", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        getLatestVersion: () => Effect.fail("offline"),
        isServiceInstalled: () => Effect.succeed(false),
        runPackageManagerUpdate: (manager) =>
          Effect.sync(() => {
            managers.push(manager);
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(managers).toEqual(["npm"]);
    expect(logs).toEqual([
      "Detecting install method",
      "Using method: npm",
      "Checking latest version",
      "Could not check latest version; running upgrade anyway",
      "Running npm install -g @851-labs/tokenmaxxing@latest --silent",
      "Upgraded tokenmaxxing",
      "Refreshing service",
      "Service: not installed",
    ]);
  });

  it("writes JSON when no update is pending", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram(
        {
          currentVersion: "0.4.3",
          findCommandInstall: () => Effect.succeed(install),
          getLatestVersion: () => Effect.succeed("0.4.3"),
          runPackageManagerUpdate: (manager) =>
            Effect.sync(() => {
              managers.push(manager);
            }),
        },
        { json: true },
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(managers).toEqual([]);
    expect(logs).toEqual([
      JSON.stringify({
        command: "npm install -g @851-labs/tokenmaxxing@latest --silent",
        currentVersion: "0.4.3",
        latestVersion: "0.4.3",
        packageManager: "npm",
        service: { status: "skipped" },
        skipped: true,
        status: "ok",
        updated: false,
        versionCheck: "ok",
      }),
    ]);
  });

  it("writes JSON after upgrading", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram(
        {
          currentVersion: "0.4.3",
          findCommandInstall: () => Effect.succeed(install),
          getLatestVersion: () => Effect.succeed("0.4.4"),
          isServiceInstalled: () => Effect.succeed(false),
          runPackageManagerUpdate: (manager) =>
            Effect.sync(() => {
              managers.push(manager);
            }),
        },
        { json: true },
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(managers).toEqual(["npm"]);
    expect(logs).toEqual([
      JSON.stringify({
        command: "npm install -g @851-labs/tokenmaxxing@latest --silent",
        currentVersion: "0.4.3",
        latestVersion: "0.4.4",
        packageManager: "npm",
        service: { status: "not-installed" },
        skipped: false,
        status: "ok",
        updated: true,
        versionCheck: "ok",
      }),
    ]);
  });

  it("refreshes an installed service after upgrading", async () => {
    const { layer, logs } = testConsole();
    const refreshes: Array<{ commandPath: string }> = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        getLatestVersion: () => Effect.succeed("0.4.4"),
        isServiceInstalled: () => Effect.succeed(true),
        refreshService: (options) =>
          Effect.sync(() => {
            refreshes.push(options);
          }),
        runPackageManagerUpdate: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(refreshes).toEqual([{ commandPath: "/usr/local/bin/tokenmaxxing" }]);
    expect(logs).toContain("Upgraded to v0.4.4");
    expect(logs).toContain("Service: refreshed");
  });

  it("keeps upgrade successful when service refresh fails", async () => {
    const { layer, logs } = testConsole();

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        getLatestVersion: () => Effect.succeed("0.4.4"),
        isServiceInstalled: () => Effect.succeed(true),
        refreshService: () => Effect.fail(new Error("refresh failed")),
        runPackageManagerUpdate: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(logs).toContain("Service: refresh failed; run tokenmaxxing service install if needed");
  });

  it("rejects ephemeral package-runner installs", async () => {
    const { layer } = testConsole();
    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        findCommandInstall: () =>
          Effect.succeed({
            ...install,
            commandPath: "/home/alex/.npm/_npx/123/node_modules/.bin/tokenmaxxing",
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("rejects unknown package managers", async () => {
    const { layer } = testConsole();
    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        findCommandInstall: () => Effect.succeed({ ...install, autoUpdateManager: null }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });
});

describe("refreshInstalledService", () => {
  it("returns not-installed when service paths are unsupported", async () => {
    const result = await Effect.runPromise(
      refreshInstalledService(install, { platform: "freebsd" }),
    );

    expect(result).toEqual({ _tag: "not-installed" });
  });

  it("formats refresh results", () => {
    expect(formatServiceRefreshResult({ _tag: "refreshed" })).toBe("Service: refreshed");
    expect(formatServiceRefreshResult({ _tag: "not-installed" })).toBe("Service: not installed");
    expect(formatServiceRefreshResult({ _tag: "failed", cause: "boom" })).toBe(
      "Service: refresh failed; run tokenmaxxing service install if needed",
    );
  });
});

describe("formatUpgradeSuccess", () => {
  it("includes the target version when the registry check succeeded", () => {
    expect(
      formatUpgradeSuccess({
        _tag: "available",
        currentVersion: "0.4.3",
        latestVersion: "0.4.4",
        shouldUpdate: true,
      }),
    ).toBe("Upgraded to v0.4.4");
  });

  it("keeps generic copy when the registry check was unavailable", () => {
    expect(
      formatUpgradeSuccess({
        _tag: "unavailable",
        currentVersion: "0.4.3",
        latestVersion: null,
      }),
    ).toBe("Upgraded tokenmaxxing");
  });
});
