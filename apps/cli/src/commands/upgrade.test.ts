import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

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
        getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
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
        getDistTags: () => Effect.succeed({ latest: "0.4.3" }),
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
      "Already up to date (0.4.3)",
    ]);
  });

  it("falls back to running the upgrade when latest version lookup fails", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        getDistTags: () => Effect.fail("offline"),
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
          getDistTags: () => Effect.succeed({ latest: "0.4.3" }),
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
        channel: "latest",
        channelVersion: "0.4.3",
        command: null,
        currentVersion: "0.4.3",
        distTag: null,
        latestVersion: "0.4.3",
        packageManager: "npm",
        service: { status: "skipped" },
        skipped: true,
        status: "ok",
        targetVersion: null,
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
          getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
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
        channel: "latest",
        channelVersion: "0.4.4",
        command: "npm install -g @851-labs/tokenmaxxing@latest --silent",
        currentVersion: "0.4.3",
        distTag: "latest",
        latestVersion: "0.4.4",
        packageManager: "npm",
        service: { status: "not-installed" },
        skipped: false,
        status: "ok",
        targetVersion: "0.4.4",
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
        getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
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
        getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
        isServiceInstalled: () => Effect.succeed(true),
        refreshService: () => Effect.fail(new Error("refresh failed")),
        runPackageManagerUpdate: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(logs).toContain("Service: refresh failed; run tokenmaxxing service install if needed");
  });

  describe("release channels", () => {
    async function runUpgrade(input: {
      currentVersion: string;
      distTags: Effect.Effect<Record<string, string>, unknown>;
      json?: boolean;
      manager?: CommandInstall["autoUpdateManager"];
    }) {
      const { layer, logs } = testConsole();
      const updates: Array<{ manager: string; specifier: string }> = [];
      const exit = await Effect.runPromiseExit(
        upgradeProgram(
          {
            currentVersion: input.currentVersion,
            findCommandInstall: () =>
              Effect.succeed({ ...install, autoUpdateManager: input.manager ?? "npm" }),
            getDistTags: () => input.distTags,
            isServiceInstalled: () => Effect.succeed(false),
            runPackageManagerUpdate: (manager, specifier) =>
              Effect.sync(() => {
                updates.push({ manager, specifier });
              }),
          },
          { json: input.json ?? true },
        ).pipe(Effect.provide(layer)),
      );

      return {
        exit,
        logs,
        json: logs.length === 1 ? (JSON.parse(logs[0]!) as Record<string, unknown>) : null,
        updates,
      };
    }

    it("never downgrades a prerelease to an older latest", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.0",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.0", latest: "0.6.0" }),
      });

      expect(result.exit._tag).toBe("Success");
      expect(result.updates).toEqual([]);
      expect(result.json).toEqual({
        channel: "alpha",
        channelVersion: "0.7.0-alpha.0",
        command: null,
        currentVersion: "0.7.0-alpha.0",
        distTag: null,
        latestVersion: "0.6.0",
        packageManager: "npm",
        service: { status: "skipped" },
        skipped: true,
        status: "ok",
        targetVersion: null,
        updated: false,
        versionCheck: "ok",
      });
    });

    it("reports a prerelease that is already on its channel head as up to date", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.0",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.0", latest: "0.6.0" }),
        json: false,
      });

      expect(result.updates).toEqual([]);
      expect(result.logs).toEqual([
        "Detecting install method",
        "Using method: npm",
        "Checking latest version",
        "Already up to date (0.7.0-alpha.0)",
      ]);
    });

    it("keeps a prerelease when its channel tag is missing and latest is older", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.0",
        distTags: Effect.succeed({ latest: "0.6.0" }),
      });

      expect(result.updates).toEqual([]);
      expect(result.json).toMatchObject({
        channel: "alpha",
        channelVersion: null,
        command: null,
        latestVersion: "0.6.0",
        skipped: true,
        updated: false,
      });
    });

    it("follows the prerelease channel to the next prerelease by exact version", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.9",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.10", latest: "0.6.0" }),
      });

      expect(result.exit._tag).toBe("Success");
      expect(result.updates).toEqual([{ manager: "npm", specifier: "0.7.0-alpha.10" }]);
      expect(result.json).toEqual({
        channel: "alpha",
        channelVersion: "0.7.0-alpha.10",
        command: "npm install -g @851-labs/tokenmaxxing@0.7.0-alpha.10 --silent",
        currentVersion: "0.7.0-alpha.9",
        distTag: "alpha",
        latestVersion: "0.6.0",
        packageManager: "npm",
        service: { status: "not-installed" },
        skipped: false,
        status: "ok",
        targetVersion: "0.7.0-alpha.10",
        updated: true,
        versionCheck: "ok",
      });
    });

    it("graduates a prerelease to the release once it lands on latest", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.1",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.1", latest: "0.7.0" }),
      });

      expect(result.updates).toEqual([{ manager: "npm", specifier: "latest" }]);
      expect(result.json).toEqual({
        channel: "alpha",
        channelVersion: "0.7.0-alpha.1",
        command: "npm install -g @851-labs/tokenmaxxing@latest --silent",
        currentVersion: "0.7.0-alpha.1",
        distTag: "latest",
        latestVersion: "0.7.0",
        packageManager: "npm",
        service: { status: "not-installed" },
        skipped: false,
        status: "ok",
        targetVersion: "0.7.0",
        updated: true,
        versionCheck: "ok",
      });
    });

    it("installs prereleases with bun add since bun update cannot pin a version", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.0",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.1", latest: "0.6.0" }),
        manager: "bun",
      });

      expect(result.updates).toEqual([{ manager: "bun", specifier: "0.7.0-alpha.1" }]);
      expect(result.json).toMatchObject({
        command: "bun add -g @851-labs/tokenmaxxing@0.7.0-alpha.1 --silent",
      });
    });

    it("reports the bun update command for a stable install following latest", async () => {
      const result = await runUpgrade({
        currentVersion: "0.6.0",
        distTags: Effect.succeed({ latest: "0.6.1" }),
        manager: "bun",
      });

      expect(result.updates).toEqual([{ manager: "bun", specifier: "latest" }]);
      expect(result.json).toMatchObject({
        command: "bun update -g @851-labs/tokenmaxxing --latest --silent",
        targetVersion: "0.6.1",
      });
    });

    it("reports no command for any package manager when nothing is installed", async () => {
      const result = await runUpgrade({
        currentVersion: "0.6.0",
        distTags: Effect.succeed({ latest: "0.6.0" }),
        manager: "bun",
      });

      expect(result.updates).toEqual([]);
      expect(result.json).toMatchObject({ command: null, packageManager: "bun", skipped: true });
    });

    it("runs latest for a stable install when the registry is unreachable", async () => {
      const result = await runUpgrade({
        currentVersion: "0.6.0",
        distTags: Effect.fail("offline"),
      });

      expect(result.exit._tag).toBe("Success");
      expect(result.updates).toEqual([{ manager: "npm", specifier: "latest" }]);
      expect(result.json).toEqual({
        channel: "latest",
        channelVersion: null,
        command: "npm install -g @851-labs/tokenmaxxing@latest --silent",
        currentVersion: "0.6.0",
        distTag: null,
        latestVersion: null,
        packageManager: "npm",
        service: { status: "not-installed" },
        skipped: false,
        status: "ok",
        targetVersion: null,
        updated: true,
        versionCheck: "unavailable",
      });
    });

    it("keeps stable installs off prerelease channels", async () => {
      const result = await runUpgrade({
        currentVersion: "0.6.0",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.1", latest: "0.6.0" }),
      });

      expect(result.updates).toEqual([]);
      expect(result.json).toMatchObject({
        channel: "latest",
        channelVersion: "0.6.0",
        command: null,
        latestVersion: "0.6.0",
        skipped: true,
      });
    });

    it("never downgrades a stable install that is ahead of latest", async () => {
      const result = await runUpgrade({
        currentVersion: "0.6.1",
        distTags: Effect.succeed({ latest: "0.6.0" }),
      });

      expect(result.updates).toEqual([]);
      expect(result.json).toMatchObject({ command: null, latestVersion: "0.6.0", skipped: true });
    });

    it("refuses to upgrade a prerelease blind when the registry check fails", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.0",
        distTags: Effect.fail("offline"),
      });

      expect(result.exit._tag).toBe("Failure");
      expect(result.updates).toEqual([]);
      expect(JSON.stringify(result.exit)).toContain("UpgradePrereleaseVersionCheckError");
    });
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
        channel: "latest",
        channelVersion: "0.4.4",
        currentVersion: "0.4.3",
        latestVersion: "0.4.4",
        shouldUpdate: true,
        target: { distTag: "latest", version: "0.4.4" },
      }),
    ).toBe("Upgraded to v0.4.4");
  });

  it("names the installed target, not npm latest, for a prerelease upgrade", () => {
    expect(
      formatUpgradeSuccess({
        _tag: "available",
        channel: "alpha",
        channelVersion: "0.7.0-alpha.2",
        currentVersion: "0.7.0-alpha.1",
        latestVersion: "0.6.0",
        shouldUpdate: true,
        target: { distTag: "alpha", version: "0.7.0-alpha.2" },
      }),
    ).toBe("Upgraded to v0.7.0-alpha.2");
  });

  it("keeps generic copy when the registry check was unavailable", () => {
    expect(
      formatUpgradeSuccess({
        _tag: "unavailable",
        channel: "latest",
        channelVersion: null,
        currentVersion: "0.4.3",
        latestVersion: null,
      }),
    ).toBe("Upgraded tokenmaxxing");
  });
});
