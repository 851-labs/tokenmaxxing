import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ConsoleService } from "../services";
import { type CommandInstall, PackageManagerUpdateError } from "./service";
import {
  formatServiceRefreshResult,
  formatUpgradeSuccess,
  refreshInstalledService,
  UpgradeFailedError,
  upgradeProgram,
  UpgradeVerificationError,
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

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  return Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
}

describe("upgradeProgram", () => {
  it("upgrades through the detected package manager and skips service refresh when absent", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        readNpmPrefix: () => Effect.succeed("/usr/local"),
        getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
        isServiceInstalled: () => Effect.succeed(false),
        readInstalledVersion: () => Effect.succeed("0.4.4"),
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
      "Running npm install -g @851-labs/tokenmaxxing@0.4.4 --prefer-online --loglevel=error",
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
        readNpmPrefix: () => Effect.succeed("/usr/local"),
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

  it("removes what npm left of the last upgrade first, even when up to date", async () => {
    const { layer } = testConsole();
    const windowsInstall: CommandInstall = {
      autoUpdateManager: "npm",
      commandPath: "C:\\Users\\tmx\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
      resolvedCommandPath: "C:\\Users\\tmx\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
    };
    const events: string[] = [];
    const cleanups: Array<{ paths: readonly string[]; platform: NodeJS.Platform }> = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(windowsInstall),
        getDistTags: () =>
          Effect.sync(() => {
            events.push("version check");
            return { latest: "0.4.3" };
          }),
        platform: "win32",
        removeNpmStagingDirs: (paths, platform) =>
          Effect.sync(() => {
            events.push("cleanup");
            cleanups.push({ paths, platform });
            return { failed: [], inUse: [], removed: [] };
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(events).toEqual(["cleanup", "version check"]);
    expect(cleanups).toEqual([
      {
        paths: [windowsInstall.commandPath, windowsInstall.resolvedCommandPath, process.execPath],
        platform: "win32",
      },
    ]);
  });

  it("refuses to upgrade without a version check instead of installing a dist-tag", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.4.3",
        findCommandInstall: () => Effect.succeed(install),
        readNpmPrefix: () => Effect.succeed("/usr/local"),
        getDistTags: () => Effect.fail("offline"),
        isServiceInstalled: () => Effect.succeed(false),
        runPackageManagerUpdate: (manager) =>
          Effect.sync(() => {
            managers.push(manager);
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("UpgradeVersionCheckError");
    expect(managers).toEqual([]);
    expect(logs).toEqual([
      "Detecting install method",
      "Using method: npm",
      "Checking latest version",
      "Could not check latest version",
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
          readNpmPrefix: () => Effect.succeed("/usr/local"),
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
          readNpmPrefix: () => Effect.succeed("/usr/local"),
          getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
          isServiceInstalled: () => Effect.succeed(false),
          readInstalledVersion: () => Effect.succeed("0.4.4"),
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
        command: "npm install -g @851-labs/tokenmaxxing@0.4.4 --prefer-online --loglevel=error",
        currentVersion: "0.4.3",
        distTag: "latest",
        installedVersion: "0.4.4",
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
        readNpmPrefix: () => Effect.succeed("/usr/local"),
        getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
        isServiceInstalled: () => Effect.succeed(true),
        readInstalledVersion: () => Effect.succeed("0.4.4"),
        refreshService: (options) =>
          Effect.sync(() => {
            refreshes.push(options);
          }),
        runPackageManagerUpdate: () => Effect.void,
        serviceUsesConfigDir: () => Effect.succeed(true),
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
        readNpmPrefix: () => Effect.succeed("/usr/local"),
        getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
        isServiceInstalled: () => Effect.succeed(true),
        readInstalledVersion: () => Effect.succeed("0.4.4"),
        refreshService: () => Effect.fail(new Error("refresh failed")),
        runPackageManagerUpdate: () => Effect.void,
        serviceUsesConfigDir: () => Effect.succeed(true),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(logs).toContain("Service: refresh failed; run tokenmaxxing service install if needed");
  });

  // FAIL-6 / FAIL-1: npm installed a stale `latest` (or bun did nothing),
  // exited 0, and the old CLI reported "Upgraded" with updated: true.
  it("fails instead of reporting success when the package manager leaves the old version", async () => {
    const { layer, logs } = testConsole();

    const exit = await Effect.runPromiseExit(
      upgradeProgram(
        {
          currentVersion: "0.6.0",
          findCommandInstall: () => Effect.succeed(install),
          readNpmPrefix: () => Effect.succeed("/usr/local"),
          getDistTags: () => Effect.succeed({ alpha: "0.7.0-alpha.2", latest: "0.7.0" }),
          isServiceInstalled: () => Effect.succeed(false),
          readInstalledVersion: () => Effect.succeed("0.6.0"),
          runPackageManagerUpdate: () => Effect.void,
        },
        { json: true },
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(logs).toEqual([]);
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(UpgradeVerificationError);
    expect((error as UpgradeVerificationError).message).toBe(
      [
        "error: upgrade did not take effect; tokenmaxxing is 0.6.0, expected 0.7.0",
        "command: npm install -g @851-labs/tokenmaxxing@0.7.0 --prefer-online --loglevel=error",
        "path: /usr/local/bin/tokenmaxxing",
        "hint: run tokenmaxxing --version; if it is still old, run the command above yourself or check which -a tokenmaxxing",
      ].join("\n"),
    );
  });

  it("fails when the installed version cannot be read back", async () => {
    const { layer, logs } = testConsole();
    const refreshes: Array<{ commandPath: string }> = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.6.0",
        findCommandInstall: () => Effect.succeed(install),
        readNpmPrefix: () => Effect.succeed("/usr/local"),
        getDistTags: () => Effect.succeed({ latest: "0.7.0" }),
        isServiceInstalled: () => Effect.succeed(true),
        readInstalledVersion: () => Effect.succeed(null),
        refreshService: (options) =>
          Effect.sync(() => {
            refreshes.push(options);
          }),
        runPackageManagerUpdate: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );

    expect(failureOf(exit)).toMatchObject({
      _tag: "UpgradeVerificationError",
      installedVersion: null,
    });
    expect(refreshes).toEqual([]);
    expect(logs.at(-1)).toBe("Upgrade did not take effect");
  });

  it("puts the package manager's error output in the failure", async () => {
    const { layer } = testConsole();
    const command = "npm install -g @851-labs/tokenmaxxing@0.7.0 --prefer-online --loglevel=error";

    const exit = await Effect.runPromiseExit(
      upgradeProgram({
        currentVersion: "0.6.0",
        findCommandInstall: () => Effect.succeed(install),
        readNpmPrefix: () => Effect.succeed("/usr/local"),
        getDistTags: () => Effect.succeed({ latest: "0.7.0" }),
        runPackageManagerUpdate: () =>
          Effect.fail(
            new PackageManagerUpdateError({
              cause: new Error(`Command failed: ${command}`),
              command,
              output:
                "npm error code ETARGET\nnpm error notarget No matching version found for @851-labs/tokenmaxxing@0.7.0.",
              timedOut: false,
            }),
          ),
      }).pipe(Effect.provide(layer)),
    );

    const error = failureOf(exit);
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).message).toBe(
      [
        "error: failed to upgrade tokenmaxxing",
        `command: ${command}`,
        "npm error code ETARGET",
        "npm error notarget No matching version found for @851-labs/tokenmaxxing@0.7.0.",
        "hint: a release can take a few minutes to reach every registry mirror; retry shortly, or run the command above yourself",
      ].join("\n"),
    );
  });

  it("leaves a service installed for another config dir alone", async () => {
    const { layer, logs } = testConsole();
    const refreshes: Array<{ commandPath: string }> = [];

    const exit = await Effect.runPromiseExit(
      upgradeProgram(
        {
          currentVersion: "0.4.3",
          findCommandInstall: () => Effect.succeed(install),
          readNpmPrefix: () => Effect.succeed("/usr/local"),
          getDistTags: () => Effect.succeed({ latest: "0.4.4" }),
          isServiceInstalled: () => Effect.succeed(true),
          readInstalledVersion: () => Effect.succeed("0.4.4"),
          refreshService: (options) =>
            Effect.sync(() => {
              refreshes.push(options);
            }),
          runPackageManagerUpdate: () => Effect.void,
          serviceUsesConfigDir: () => Effect.succeed(false),
        },
        { json: true },
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(refreshes).toEqual([]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      service: { status: "other-config-dir" },
      updated: true,
    });
  });

  // W3 (F2): an `npm i -g --prefix <dir>` install was "upgraded" into npm's
  // default prefix, a second copy, while the one on PATH stayed old.
  it("updates an npm install under its own prefix when that is not npm's configured one", async () => {
    const { layer } = testConsole();
    const updates: Array<{ options: unknown; version: string }> = [];
    const custom = {
      autoUpdateManager: "npm" as const,
      commandPath: "/Users/alex/tools/npm-global/bin/tokenmaxxing",
      resolvedCommandPath:
        "/Users/alex/tools/npm-global/lib/node_modules/@851-labs/tokenmaxxing/bin/tokenmaxxing",
    };

    const exit = await Effect.runPromiseExit(
      upgradeProgram(
        {
          currentVersion: "0.6.0",
          findCommandInstall: () => Effect.succeed(custom),
          readNpmPrefix: () => Effect.succeed("/opt/homebrew"),
          getDistTags: () => Effect.succeed({ latest: "0.7.0" }),
          isServiceInstalled: () => Effect.succeed(false),
          platform: "darwin",
          readInstalledVersion: () => Effect.succeed("0.7.0"),
          runPackageManagerUpdate: (_manager, version, options) =>
            Effect.sync(() => {
              updates.push({ options, version });
            }),
        },
        { json: true },
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(updates).toEqual([
      { options: { npmPrefix: "/Users/alex/tools/npm-global" }, version: "0.7.0" },
    ]);
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
            readNpmPrefix: () => Effect.succeed("/usr/local"),
            getDistTags: () => input.distTags,
            isServiceInstalled: () => Effect.succeed(false),
            readInstalledVersion: () =>
              Effect.succeed(updates.at(-1)?.specifier ?? input.currentVersion),
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
        command:
          "npm install -g @851-labs/tokenmaxxing@0.7.0-alpha.10 --prefer-online --loglevel=error",
        currentVersion: "0.7.0-alpha.9",
        distTag: "alpha",
        installedVersion: "0.7.0-alpha.10",
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

      expect(result.updates).toEqual([{ manager: "npm", specifier: "0.7.0" }]);
      expect(result.json).toEqual({
        channel: "alpha",
        channelVersion: "0.7.0-alpha.1",
        command: "npm install -g @851-labs/tokenmaxxing@0.7.0 --prefer-online --loglevel=error",
        currentVersion: "0.7.0-alpha.1",
        distTag: "latest",
        installedVersion: "0.7.0",
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

    it("installs prereleases with bun add, bypassing bun's manifest cache", async () => {
      const result = await runUpgrade({
        currentVersion: "0.7.0-alpha.0",
        distTags: Effect.succeed({ alpha: "0.7.0-alpha.1", latest: "0.6.0" }),
        manager: "bun",
      });

      expect(result.updates).toEqual([{ manager: "bun", specifier: "0.7.0-alpha.1" }]);
      expect(result.json).toMatchObject({
        command: "bun add -g @851-labs/tokenmaxxing@0.7.0-alpha.1 --no-cache --silent",
      });
    });

    it("installs latest's exact version, never the dist-tag, for every package manager", async () => {
      const commands = {
        bun: "bun add -g @851-labs/tokenmaxxing@0.6.1 --no-cache --silent",
        npm: "npm install -g @851-labs/tokenmaxxing@0.6.1 --prefer-online --loglevel=error",
        pnpm: "pnpm add -g @851-labs/tokenmaxxing@0.6.1 --loglevel=error",
        yarn: "yarn global add @851-labs/tokenmaxxing@0.6.1 --silent",
      } as const;
      for (const [manager, command] of Object.entries(commands)) {
        const result = await runUpgrade({
          currentVersion: "0.6.0",
          distTags: Effect.succeed({ latest: "0.6.1" }),
          manager: manager as keyof typeof commands,
        });

        expect(result.updates).toEqual([{ manager, specifier: "0.6.1" }]);
        expect(result.json).toMatchObject({ command, targetVersion: "0.6.1", updated: true });
      }
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

    it("refuses a stable install too when the registry is unreachable", async () => {
      const result = await runUpgrade({
        currentVersion: "0.6.0",
        distTags: Effect.fail("offline"),
      });

      expect(result.exit._tag).toBe("Failure");
      expect(result.updates).toEqual([]);
      expect(JSON.stringify(result.exit)).toContain("UpgradeVersionCheckError");
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
    expect(formatServiceRefreshResult({ _tag: "other-config-dir" })).toBe(
      "Service: left alone; the installed service uses another config dir",
    );
    expect(formatServiceRefreshResult({ _tag: "failed", cause: "boom" })).toBe(
      "Service: refresh failed; run tokenmaxxing service install if needed",
    );
  });
});

describe("formatUpgradeSuccess", () => {
  it("names the installed version", () => {
    expect(formatUpgradeSuccess("0.7.0-alpha.2")).toBe("Upgraded to v0.7.0-alpha.2");
  });
});
