import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { Cause, Effect, Layer } from "effect";
import type { AuthUser } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import {
  ApiClientService,
  BrowserService,
  ClockService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  TerminalService,
  type TokenmaxxingApiClient,
} from "../services";
import {
  autoUpdateCommandDescription,
  backendForPlatform,
  capturedServiceEnv,
  deferredServiceRepairInvocation,
  detectAutoUpdateManager,
  deterministicServiceJitterMs,
  durableTokenmaxxingCommandPath,
  extractServiceRunnerFromTarball,
  findCommandOnPath,
  formatServiceLockStatus,
  formatServiceStatusAutoUpdate,
  installServiceRunner,
  installServiceRunnerForRepair,
  installServiceRunnerFromOptionalPackage,
  isEphemeralCommandPath,
  isTransientCommandShimPath,
  legacyServiceWrapperPaths,
  readCurrentServiceRunnerInstall,
  resolveExecutableSiblingPackageJson,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdTimer,
  runServiceAutoUpdate,
  scheduleDescription,
  serviceLockCanBeReplaced,
  serviceRepairCanInstallScheduler,
  serviceRepairNeedsSchedulerInstall,
  serviceRepairReason,
  serviceRepairState,
  serviceRunnerPackageName,
  serviceRunnerReleaseChannel,
  serviceRunnerReleaseIsNewer,
  serviceRunnerTarget,
  serviceScheduledSyncSince,
  serviceInstallProgram,
  serviceLockStatus,
  serviceRunFailureState,
  serviceRunLogLine,
  serviceRunSuccessState,
  ServiceRunnerUpdateError,
  type CommandInstall,
  type ServiceAutoUpdateReport,
  type ServiceMetadata,
  type ServicePaths,
  type ServiceState,
  servicePaths,
  serviceStateJson,
  verifyNpmIntegrity,
  windowsTaskCreateArgs,
  windowsTaskNames,
} from "./service";
import type { SyncResult } from "./sync";

interface TestLayerOptions {
  envTokenActive?: boolean;
  initialConfig: CliConfig;
  interactive?: boolean;
  meError?: unknown;
}

interface TestState {
  browserUrls: string[];
  clearedTokens: number;
  errors: string[];
  logs: string[];
  madeClients: Array<{ baseUrl: string; token?: string | undefined }>;
  writtenTokens: string[];
}

const user: AuthUser = {
  avatarUrl: null,
  id: "user_123",
  login: "alex",
  name: null,
};

function autoUpdateReport(input: Partial<ServiceAutoUpdateReport> = {}): ServiceAutoUpdateReport {
  return {
    attemptedAt: "2026-06-16T10:00:00.000Z",
    completedAt: "2026-06-16T10:00:01.000Z",
    currentVersion: "0.4.12",
    enabled: true,
    error: null,
    installedVersion: null,
    latestVersion: "0.4.13",
    manager: "npm",
    reason: null,
    status: "success",
    ...input,
  };
}

function runAutoUpdate(
  metadata: ServiceMetadata | null,
  runtime: Parameters<typeof runServiceAutoUpdate>[2],
  currentVersion = "0.4.12",
  paths?: ServicePaths,
) {
  return Effect.runPromise(
    runServiceAutoUpdate(metadata, { currentVersion, json: true, paths }, runtime).pipe(
      Effect.provideService(ConsoleService, {
        error: () => undefined,
        log: () => undefined,
      }),
    ),
  );
}

function makeTestLayer(options: TestLayerOptions) {
  let currentConfig = options.initialConfig;
  const state: TestState = {
    browserUrls: [],
    clearedTokens: 0,
    errors: [],
    logs: [],
    madeClients: [],
    writtenTokens: [],
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ApiClientService)({
      make: (clientOptions) => {
        state.madeClients.push(clientOptions);

        return Effect.succeed({
          cliLogin: {
            poll: () => Effect.succeed({ status: "complete" as const, token: "tmx_new", user }),
            start: () =>
              Effect.succeed({
                code: "ABC123",
                expiresAt: "2026-06-13T20:00:00.000Z",
                intervalSeconds: 0,
                verificationUri: "https://tokenmaxxing.example/login/cli?code=ABC123",
              }),
          },
          me: {
            me: () =>
              options.meError === undefined
                ? Effect.succeed({ user })
                : Effect.fail(options.meError),
          },
          usage: {
            sync: () => Effect.succeed({ upserted: 0 }),
          },
        } as unknown as TokenmaxxingApiClient);
      },
    }),
    Layer.succeed(BrowserService)({
      open: (url) =>
        Effect.sync(() => {
          state.browserUrls.push(url);
        }),
    }),
    Layer.succeed(ClockService)({
      sleep: () => Effect.succeed(undefined),
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.sync(() => {
          const token = currentConfig.token;
          const { token: _token, ...nextConfig } = currentConfig;
          currentConfig = nextConfig;
          state.clearedTokens += 1;

          return {
            config: nextConfig,
            token,
            tokenCleared: token !== undefined,
          };
        }),
      ensureDeviceId: () => Effect.succeed(currentConfig.deviceId ?? "device_123"),
      hasEnvToken: () => Effect.succeed(options.envTokenActive ?? false),
      readConfig: () => Effect.succeed(currentConfig),
      writeToken: (token) =>
        Effect.sync(() => {
          currentConfig = { ...currentConfig, token };
          state.writtenTokens.push(token);

          return currentConfig;
        }),
    }),
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        state.errors.push(String(message));
      },
      log: (message?: unknown) => {
        state.logs.push(String(message));
      },
    }),
    Layer.succeed(TerminalService)({
      canOpenExternalBrowser: Effect.succeed(true),
      isInteractive: Effect.succeed(options.interactive ?? true),
    }),
  );

  return { layer, state };
}

describe("service runner update versions", () => {
  it("derives the npm release channel from the current runner version", () => {
    expect(serviceRunnerReleaseChannel("0.4.18")).toBe("latest");
    expect(serviceRunnerReleaseChannel("v0.4.18")).toBe("latest");
    expect(serviceRunnerReleaseChannel("0.4.18-alpha.1")).toBe("alpha");
    expect(serviceRunnerReleaseChannel("0.4.18-beta.2")).toBe("beta");
    expect(serviceRunnerReleaseChannel("0.4.18-rc.0+build")).toBe("rc");
  });

  it("only treats strictly newer semver-like runner versions as installable", () => {
    expect(serviceRunnerReleaseIsNewer("0.4.18", "0.4.19")).toBe(true);
    expect(serviceRunnerReleaseIsNewer("0.4.18", "0.5.0")).toBe(true);
    expect(serviceRunnerReleaseIsNewer("0.4.18", "1.0.0")).toBe(true);
    expect(serviceRunnerReleaseIsNewer("0.4.18", "0.4.18")).toBe(false);
    expect(serviceRunnerReleaseIsNewer("0.4.18", "0.4.17")).toBe(false);
    expect(serviceRunnerReleaseIsNewer("0.4.18-alpha.1", "0.4.18-alpha.2")).toBe(true);
    expect(serviceRunnerReleaseIsNewer("0.4.18-alpha.2", "0.4.18-alpha.1")).toBe(false);
    expect(serviceRunnerReleaseIsNewer("0.4.18-alpha.1", "0.4.18")).toBe(true);
  });
});

function makeInstallRuntime(
  options: { env?: Record<string, string | undefined>; install?: CommandInstall } = {},
) {
  const commandInstall: CommandInstall = options.install ?? {
    autoUpdateManager: "npm" as const,
    commandPath: "/usr/local/bin/tokenmaxxing",
    resolvedCommandPath: "/usr/local/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
  };
  const runner = {
    packageName: "@851-labs/tokenmaxxing-darwin-arm64",
    path: "/tmp/tokenmaxxing/service-runners/0.4.17/darwin-arm64/tokenmaxxing",
    target: "darwin-arm64" as const,
    version: "0.4.17",
  };
  const installed: ServicePaths[] = [];
  const pointerWrites: Array<{ paths: ServicePaths; runnerPath: string }> = [];
  const written: Array<{
    metadata: ServiceMetadata;
    paths: ServicePaths;
    wrapper: string;
  }> = [];

  return {
    installed,
    runtime: {
      env: {
        PATH: "/usr/local/bin:/usr/bin",
        TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing",
        ...options.env,
      },
      findCommandInstall: () => Effect.succeed(commandInstall),
      home: "/Users/alex",
      installScheduler: (paths: ServicePaths) =>
        Effect.sync(() => {
          installed.push(paths);
        }),
      installServiceRunner: () => Effect.succeed(runner),
      now: new Date("2026-06-16T12:00:00.000Z"),
      platform: "darwin" as const,
      writeFiles: (paths: ServicePaths, wrapper: string, metadata: ServiceMetadata) =>
        Effect.sync(() => {
          written.push({ metadata, paths, wrapper });
        }),
      writeRunnerPointer: (paths: ServicePaths, runnerPath: string): Effect.Effect<void, never> =>
        Effect.sync(() => {
          pointerWrites.push({ paths, runnerPath });
        }),
    },
    pointerWrites,
    runner,
    written,
  };
}

function unauthorizedError() {
  return Object.assign(new Error("unauthorized"), { _tag: "Unauthorized" as const });
}

function failureTag(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>): string | undefined {
  if (exit._tag !== "Failure") {
    return undefined;
  }

  const failure = exit.cause.reasons.find(Cause.isFailReason);

  return failure === undefined ? undefined : (failure.error as { _tag?: string })._tag;
}

function makeTarball(entries: Array<{ data: Uint8Array; path: string }>): Uint8Array {
  const blocks = entries.flatMap((entry) => {
    const data = Buffer.from(entry.data);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, "utf8");
    header.write("0000755\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return [header, data, padding];
  });

  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function writeFakeRunnerPackage(
  rootDir: string,
  packageName: string,
  binaryName: string,
): Promise<string> {
  const packageDir = join(rootDir, packageName);
  const binaryPath = join(packageDir, "bin", binaryName);
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "9.9.9" })}\n`,
  );
  await writeFile(binaryPath, "#!/bin/sh\n");
  await chmod(binaryPath, 0o755);

  return join(packageDir, "package.json");
}

describe("backendForPlatform", () => {
  it("selects the native scheduler for supported platforms", () => {
    expect(backendForPlatform("darwin")).toBe("launchd");
    expect(backendForPlatform("linux")).toBe("systemd");
    expect(backendForPlatform("win32")).toBe("windows-task-scheduler");
    expect(backendForPlatform("freebsd")).toBeNull();
  });
});

describe("service runner platform packages", () => {
  it("maps supported host platforms to optional runner packages", () => {
    expect(serviceRunnerTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(["darwin-x64", "darwin-x64-baseline"]).toContain(serviceRunnerTarget("darwin", "x64"));
    expect(serviceRunnerTarget("linux", "arm64")).toBe("linux-arm64");
    expect(["linux-x64", "linux-x64-baseline"]).toContain(serviceRunnerTarget("linux", "x64"));
    expect(["windows-x64", "windows-x64-baseline"]).toContain(serviceRunnerTarget("win32", "x64"));
    expect(serviceRunnerTarget("win32", "arm64")).toBe("windows-arm64");
    expect(serviceRunnerPackageName("darwin-arm64")).toBe("@851-labs/tokenmaxxing-darwin-arm64");
  });

  it("resolves native optional packages from the npm-installed binary location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-native-package-"));

    try {
      const cliBin = join(
        dir,
        "node_modules",
        "@851-labs",
        "tokenmaxxing",
        "bin",
        "tokenmaxxing.exe",
      );
      const packageJsonPath = join(
        dir,
        "node_modules",
        "@851-labs",
        "tokenmaxxing-darwin-arm64",
        "package.json",
      );
      await mkdir(dirname(cliBin), { recursive: true });
      await mkdir(dirname(packageJsonPath), { recursive: true });
      await writeFile(cliBin, "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(packageJsonPath, "{}\n");

      expect(
        resolveExecutableSiblingPackageJson("@851-labs/tokenmaxxing-darwin-arm64", [cliBin]),
      ).toBe(await realpath(packageJsonPath));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("can recover runner metadata from the current pointer for deferred repair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: "/Users/alex",
        platform: "darwin",
      });
      expect(paths).not.toBeNull();
      const runnerPath = join(dir, "service-runners", "0.4.17", "darwin-arm64", "tokenmaxxing");
      await mkdir(dirname(runnerPath), { recursive: true });
      await writeFile(runnerPath, "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(paths!.runnerPointerPath, `${runnerPath}\n`);
      await writeFile(
        paths!.metadataPath,
        `${JSON.stringify({
          autoUpdateManager: "registry",
          backend: "launchd",
          commandPath: runnerPath,
          installedAt: "2026-06-16T09:00:00.000Z",
          runnerPackage: "@851-labs/tokenmaxxing-darwin-arm64",
          runnerPath,
          runnerTarget: "darwin-arm64",
          runnerVersion: "0.4.17",
          schedule: "syncs every 5 minutes",
          templateVersion: 4,
          version: 1,
        } satisfies ServiceMetadata)}\n`,
      );

      await expect(Effect.runPromise(readCurrentServiceRunnerInstall(paths!))).resolves.toEqual({
        packageName: "@851-labs/tokenmaxxing-darwin-arm64",
        path: runnerPath,
        target: "darwin-arm64",
        version: "0.4.17",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("servicePaths", () => {
  it("places generated files beside the stored CLI config", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).toEqual({
      backend: "launchd",
      configDir: "/tmp/tokenmaxxing",
      definitionPath: "/Users/alex/Library/LaunchAgents/sh.tokenmaxxing.sync.plist",
      lockPath: "/tmp/tokenmaxxing/service.lock",
      logPath: "/tmp/tokenmaxxing/service.log",
      metadataPath: "/tmp/tokenmaxxing/service.json",
      runnerPointerPath: "/tmp/tokenmaxxing/service-runner-current",
      runnersDir: "/tmp/tokenmaxxing/service-runners",
      statePath: "/tmp/tokenmaxxing/service-state.json",
      updateLockPath: "/tmp/tokenmaxxing/service-update.lock",
      wrapperPath: "/tmp/tokenmaxxing/tokenmaxxing.sh",
    });
  });

  it("uses XDG config paths for systemd user units", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing", XDG_CONFIG_HOME: "/home/alex/.xdg" },
      home: "/home/alex",
      platform: "linux",
    });

    expect(paths?.backend).toBe("systemd");
    expect(paths?.definitionPath).toBe("/home/alex/.xdg/systemd/user/tokenmaxxing-sync.service");
  });
});

describe("renderServiceWrapper", () => {
  it("runs sync with a durable command without embedding package-manager updates", () => {
    const env = capturedServiceEnv({
      HOME: "/home/alex",
      PATH: "/usr/local/bin:/usr/bin",
      TOKENMAXXING_API_TOKEN: "tmx_secret",
      TOKENMAXXING_ENV: "development",
    });
    const wrapper = renderServiceWrapper({
      env,
      logPath: "/home/alex/.config/tokenmaxxing/service.log",
      platform: "linux",
      runnerPointerPath: "/home/alex/.config/tokenmaxxing/service-runner-current",
    });

    expect(wrapper).toContain(
      "runner=$(tr -d '\\r\\n' < '/home/alex/.config/tokenmaxxing/service-runner-current')",
    );
    expect(wrapper).toContain("[ ! -r '/home/alex/.config/tokenmaxxing/service-runner-current' ]");
    expect(wrapper).toContain('"$runner" service run --scheduled');
    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).not.toContain("TOKENMAXXING_API_TOKEN");
    expect(wrapper).not.toContain("tmx_secret");
  });

  it("rotates POSIX service logs before appending", () => {
    const wrapper = renderServiceWrapper({
      env: { HOME: "/home/alex", PATH: "/usr/local/bin:/usr/bin" },
      logPath: "/home/alex/.config/tokenmaxxing/service.log",
      platform: "linux",
      runnerPointerPath: "/home/alex/.config/tokenmaxxing/service-runner-current",
    });

    expect(wrapper).toContain("rotate_tokenmaxxing_log");
    expect(wrapper).toContain('[ "$size" -lt 5242880 ] && return 0');
    expect(wrapper).toContain('rm -f "$log.3"');
    expect(wrapper).toContain('mv "$log" "$log.1"');
    expect(
      wrapper.indexOf("rotate_tokenmaxxing_log '/home/alex/.config/tokenmaxxing/service.log'"),
    ).toBeLessThan(wrapper.indexOf("} >> '/home/alex/.config/tokenmaxxing/service.log' 2>&1"));
  });

  it("renders the matching auto-update command for each package manager", () => {
    expect(autoUpdateCommandDescription("bun")).toBe(
      "bun update -g @851-labs/tokenmaxxing --latest --silent",
    );
    expect(autoUpdateCommandDescription("npm")).toBe(
      "npm install -g @851-labs/tokenmaxxing@latest --silent",
    );
    expect(autoUpdateCommandDescription("pnpm")).toBe(
      "pnpm add -g @851-labs/tokenmaxxing@latest --silent",
    );
    expect(autoUpdateCommandDescription("yarn")).toBe(
      "yarn global add @851-labs/tokenmaxxing@latest --silent",
    );
  });

  it("renders Windows wrappers without package-manager updates", () => {
    const wrapper = renderServiceWrapper({
      env: { PATH: "/usr/bin" },
      logPath: "/tmp/tokenmaxxing.log",
      platform: "win32",
      runnerPointerPath: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing\\service-runner-current",
    });

    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).toContain("if %%~zA GEQ 5242880");
    expect(wrapper).toContain('"%TOKENMAXXING_LOG%.3"');
    expect(wrapper).toContain('move /y "%TOKENMAXXING_LOG%.1" "%TOKENMAXXING_LOG%.2"');
    expect(wrapper).toContain('move /y "%TOKENMAXXING_LOG%" "%TOKENMAXXING_LOG%.1"');
    expect(wrapper).toContain("set /p TOKENMAXXING_SERVICE_RUNNER=<");
    expect(wrapper).toContain("service run --scheduled");
  });
});

describe("native scheduler templates", () => {
  it("renders five-minute launchd, systemd, and Windows schedules", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).not.toBeNull();
    const launchdPlist = renderLaunchdPlist(paths!);
    expect(launchdPlist).toContain("<string>/tmp/tokenmaxxing/tokenmaxxing.sh</string>");
    expect(launchdPlist).not.toContain("service-sync.sh");
    expect(launchdPlist).toContain("<key>StartInterval</key>");
    expect(launchdPlist).toContain("<integer>300</integer>");
    expect(launchdPlist).not.toContain("StartCalendarInterval");
    expect(renderSystemdTimer()).toContain("OnBootSec=5min");
    expect(renderSystemdTimer()).toContain("OnUnitActiveSec=5min");
    expect(renderSystemdTimer()).toContain("Persistent=true");
    expect(scheduleDescription()).toBe("syncs every 5 minutes");

    const windowsPaths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing" },
      home: "C:\\Users\\alex",
      platform: "win32",
    });

    expect(windowsPaths).not.toBeNull();
    expect(windowsTaskCreateArgs(windowsPaths!)).toEqual([
      "/Create",
      "/TN",
      "tokenmaxxing-sync",
      "/SC",
      "MINUTE",
      "/MO",
      "5",
      "/TR",
      '"C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing/service-sync.cmd"',
      "/F",
    ]);
  });
});

describe("legacyServiceWrapperPaths", () => {
  it("tracks old POSIX wrapper names for cleanup", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).not.toBeNull();
    expect(legacyServiceWrapperPaths(paths!)).toEqual(["/tmp/tokenmaxxing/service-sync.sh"]);
  });

  it("does not add legacy cleanup paths for Windows task wrappers", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing" },
      home: "C:\\Users\\alex",
      platform: "win32",
    });

    expect(paths).not.toBeNull();
    expect(legacyServiceWrapperPaths(paths!)).toEqual([]);
  });
});

describe("windowsTaskNames", () => {
  it("includes the current task and legacy daily task names for cleanup", () => {
    expect(windowsTaskNames()).toEqual([
      "tokenmaxxing-sync",
      "tokenmaxxing-sync-0900",
      "tokenmaxxing-sync-1300",
      "tokenmaxxing-sync-1700",
      "tokenmaxxing-sync-2100",
    ]);
  });
});

describe("serviceStateJson", () => {
  it("omits legacy daily success dates from new writes", () => {
    expect(
      serviceStateJson({
        lastAttemptAt: "2026-06-16T10:00:00.000Z",
        lastSuccessAt: "2026-06-16T10:00:00.000Z",
        lastSuccessDate: "2026-06-16",
        version: 1,
      }),
    ).toEqual({
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastSuccessAt: "2026-06-16T10:00:00.000Z",
      version: 1,
    });
  });

  it("serializes enriched run diagnostics when present", () => {
    const state: ServiceState = {
      lastArch: "arm64",
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastAutoUpdate: autoUpdateReport(),
      lastAutoUpdated: true,
      lastCliVersion: "0.4.12",
      lastDurationMs: 1234,
      lastRows: 42,
      lastRepairAttemptAt: "2026-06-16T10:00:02.000Z",
      lastRepairCompletedAt: "2026-06-16T10:00:04.000Z",
      lastRepairReason: "reload-required",
      lastRepairStatus: "success",
      lastSince: "2026-06-16",
      lastSources: [
        {
          days: 3,
          models: 2,
          rows: 42,
          sessions: null,
          source: "codex",
          spendUsd: 12.34,
          status: "synced",
        },
      ],
      lastSyncStatus: "ok",
      lastSuccessAt: "2026-06-16T10:00:01.000Z",
      lastUpserted: 42,
      version: 1,
    };

    expect(serviceStateJson(state)).toEqual(state);
  });
});

describe("service repair helpers", () => {
  it("prioritizes the reason that should drive automatic repair", () => {
    expect(
      serviceRepairReason({
        autoUpdated: true,
        reloadRequired: true,
        schedulerActive: false,
        serviceFailed: true,
      }),
    ).toBe("service-failure");
    expect(serviceRepairReason({ schedulerActive: false })).toBe("scheduler-inactive");
    expect(serviceRepairReason({ reloadRequired: true })).toBe("reload-required");
    expect(serviceRepairReason({ autoUpdated: true })).toBe("auto-updated");
    expect(serviceRepairReason({ schedulerActive: true })).toBeUndefined();
  });

  it("does not reinstall an active scheduler for an auto-update-only repair", () => {
    expect(
      serviceRepairNeedsSchedulerInstall({
        reason: "auto-updated",
        schedulerActive: true,
      }),
    ).toBe(false);
    expect(
      serviceRepairNeedsSchedulerInstall({
        reason: "auto-updated",
        reloadRequired: true,
        schedulerActive: true,
      }),
    ).toBe(true);
    expect(
      serviceRepairNeedsSchedulerInstall({
        reason: "auto-updated",
        schedulerActive: false,
      }),
    ).toBe(true);
    expect(
      serviceRepairNeedsSchedulerInstall({
        reason: "reload-required",
        schedulerActive: true,
      }),
    ).toBe(true);
  });

  it("does not allow deferred launchd repairs to reinstall the scheduler", () => {
    expect(serviceRepairCanInstallScheduler({ backend: "launchd", deferred: true })).toBe(false);
    expect(serviceRepairCanInstallScheduler({ backend: "launchd", deferred: false })).toBe(true);
    expect(serviceRepairCanInstallScheduler({ backend: "systemd", deferred: true })).toBe(true);
    expect(
      serviceRepairCanInstallScheduler({ backend: "windows-task-scheduler", deferred: true }),
    ).toBe(true);
  });

  it("records repair attempts in service state", () => {
    expect(
      serviceRepairState(
        {
          lastAttemptAt: "2026-06-16T10:00:00.000Z",
          version: 1,
        },
        {
          attemptedAt: "2026-06-16T10:00:02.000Z",
          completedAt: "2026-06-16T10:00:04.000Z",
          reason: "scheduler-inactive",
          status: "success",
        },
      ),
    ).toMatchObject({
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastRepairAttemptAt: "2026-06-16T10:00:02.000Z",
      lastRepairCompletedAt: "2026-06-16T10:00:04.000Z",
      lastRepairReason: "scheduler-inactive",
      lastRepairStatus: "success",
    });
  });

  it("spawns deferred repairs quietly with json output and a reason", () => {
    expect(
      deferredServiceRepairInvocation("/usr/local/bin/tokenmaxxing", "reload-required", "darwin"),
    ).toMatchObject({
      args: [
        "-c",
        "sleep 2; exec '/usr/local/bin/tokenmaxxing' service repair --deferred --json --reason 'reload-required'",
      ],
      command: "sh",
    });
    expect(
      deferredServiceRepairInvocation(
        "C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
        "auto-updated",
        "win32",
      ).args.at(-1),
    ).toContain('service repair --deferred --json --reason "auto-updated"');
  });

  it("schedules linux deferred repairs with systemd-run outside the current service cgroup", () => {
    expect(
      deferredServiceRepairInvocation("/usr/local/bin/tokenmaxxing", "reload-required", "linux", {
        PATH: "/usr/local/bin:/usr/bin",
        TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing",
      }),
    ).toMatchObject({
      args: [
        "--user",
        "--quiet",
        "--collect",
        "--on-active=2s",
        "--unit=tokenmaxxing-sync-repair-reload-required",
        "--setenv=PATH=/usr/local/bin:/usr/bin",
        "--setenv=TOKENMAXXING_CONFIG_DIR=/tmp/tokenmaxxing",
        "/usr/local/bin/tokenmaxxing",
        "service",
        "repair",
        "--deferred",
        "--json",
        "--reason",
        "reload-required",
      ],
      command: "systemd-run",
      options: {
        detached: true,
        stdio: "ignore",
      },
    });
  });
});

describe("service auto-update reports", () => {
  const metadata: ServiceMetadata = {
    autoUpdateManager: "npm",
    backend: "launchd",
    commandPath: "/usr/local/bin/tokenmaxxing",
    installedAt: "2026-06-16T09:00:00.000Z",
    schedule: "syncs every 5 minutes",
    templateVersion: 2,
    version: 1,
  };
  const now = () => new Date("2026-06-16T10:00:00.000Z");
  const registryMetadata: ServiceMetadata = {
    autoUpdateManager: "registry",
    backend: "launchd",
    commandPath: "/tmp/tokenmaxxing/service-runners/0.4.12/darwin-arm64/tokenmaxxing",
    installedAt: "2026-06-16T09:00:00.000Z",
    runnerPackage: "@851-labs/tokenmaxxing-darwin-arm64",
    runnerPath: "/tmp/tokenmaxxing/service-runners/0.4.12/darwin-arm64/tokenmaxxing",
    runnerTarget: "darwin-arm64",
    runnerVersion: "0.4.12",
    schedule: "syncs every 5 minutes",
    templateVersion: 4,
    version: 1,
  };

  function registryRelease(version = "0.4.13") {
    return {
      integrity: "sha512-test",
      packageName: "@851-labs/tokenmaxxing-darwin-arm64",
      tarballUrl: "https://registry.example/tokenmaxxing.tgz",
      target: "darwin-arm64" as const,
      version,
    };
  }

  it("skips when the latest version is already installed", async () => {
    await expect(
      runAutoUpdate(
        metadata,
        {
          fetchLatestVersion: () => Effect.succeed("0.4.12"),
          now,
        },
        "0.4.12",
      ),
    ).resolves.toMatchObject({
      currentVersion: "0.4.12",
      installedVersion: "0.4.12",
      latestVersion: "0.4.12",
      reason: null,
      status: "not-needed",
    });
  });

  it("ignores legacy disabled auto-update metadata", async () => {
    await expect(
      runAutoUpdate({ ...metadata, autoUpdate: false } as ServiceMetadata, {
        commandExists: () => Effect.succeed(false),
        fetchLatestVersion: () => Effect.succeed("0.4.13"),
        now,
      }),
    ).resolves.toMatchObject({
      enabled: true,
      reason: "manager-not-found",
      status: "skipped",
    });
  });

  it("reports missing service metadata", async () => {
    await expect(
      runAutoUpdate(null, {
        fetchLatestVersion: () => Effect.succeed("0.4.13"),
        now,
      }),
    ).resolves.toMatchObject({
      enabled: false,
      manager: null,
      reason: "metadata-missing",
      status: "skipped",
    });
  });

  it("reports missing update manager metadata", async () => {
    await expect(
      runAutoUpdate(
        { ...metadata, autoUpdateManager: null },
        {
          fetchLatestVersion: () => Effect.succeed("0.4.13"),
          now,
        },
      ),
    ).resolves.toMatchObject({
      manager: null,
      reason: "manager-missing",
      status: "skipped",
    });
  });

  it("reports unknown latest version", async () => {
    await expect(
      runAutoUpdate(metadata, {
        fetchLatestVersion: () => Effect.succeed(null),
        now,
      }),
    ).resolves.toMatchObject({
      latestVersion: null,
      reason: "latest-unknown",
      status: "skipped",
    });
  });

  it("reports update manager missing from PATH", async () => {
    await expect(
      runAutoUpdate(metadata, {
        commandExists: () => Effect.succeed(false),
        fetchLatestVersion: () => Effect.succeed("0.4.13"),
        now,
      }),
    ).resolves.toMatchObject({
      manager: "npm",
      reason: "manager-not-found",
      status: "skipped",
    });
  });

  it("reports package-manager update failure", async () => {
    await expect(
      runAutoUpdate(metadata, {
        commandExists: () => Effect.succeed(true),
        fetchLatestVersion: () => Effect.succeed("0.4.13"),
        now,
        runPackageManagerUpdate: () => Effect.fail(new Error("npm failed")),
      }),
    ).resolves.toMatchObject({
      error: "npm failed",
      reason: "package-manager-failed",
      status: "failure",
    });
  });

  it("reports a successful update that did not change the installed version", async () => {
    await expect(
      runAutoUpdate(metadata, {
        commandExists: () => Effect.succeed(true),
        fetchLatestVersion: () => Effect.succeed("0.4.13"),
        now,
        readInstalledVersion: () => Effect.succeed("0.4.12"),
        runPackageManagerUpdate: () => Effect.void,
      }),
    ).resolves.toMatchObject({
      installedVersion: "0.4.12",
      reason: "version-unchanged",
      status: "failure",
    });
  });

  it("reports package-manager success when the installed version is latest", async () => {
    await expect(
      runAutoUpdate(metadata, {
        commandExists: () => Effect.succeed(true),
        fetchLatestVersion: () => Effect.succeed("0.4.13"),
        now,
        readInstalledVersion: () => Effect.succeed("0.4.13"),
        runPackageManagerUpdate: () => Effect.void,
      }),
    ).resolves.toMatchObject({
      installedVersion: "0.4.13",
      reason: null,
      status: "success",
    });
  });

  it("skips registry runner updates when the current runner is latest", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: () => Effect.succeed(registryRelease("0.4.12")),
          now,
        },
        "0.4.12",
        paths!,
      ),
    ).resolves.toMatchObject({
      installedVersion: "0.4.12",
      manager: "registry",
      reason: null,
      status: "not-needed",
    });
  });

  it("fetches registry runner updates from the current release channel", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    })!;
    const cases = [
      { currentVersion: "0.4.12", nextVersion: "0.4.13", specifier: "latest" },
      { currentVersion: "0.4.18-alpha.1", nextVersion: "0.4.18-alpha.2", specifier: "alpha" },
      { currentVersion: "0.4.18-beta.1", nextVersion: "0.4.18-beta.2", specifier: "beta" },
      { currentVersion: "0.4.18-rc.0", nextVersion: "0.4.18-rc.1", specifier: "rc" },
    ];

    for (const testCase of cases) {
      const fetchedSpecifiers: string[] = [];

      await expect(
        runAutoUpdate(
          registryMetadata,
          {
            fetchRunnerRelease: (_target, versionSpecifier) => {
              fetchedSpecifiers.push(versionSpecifier);
              return Effect.succeed(registryRelease(testCase.nextVersion));
            },
            installRunnerRelease: (release) =>
              Effect.succeed({
                packageName: release.packageName,
                path: `/tmp/tokenmaxxing/service-runners/${release.version}/darwin-arm64/tokenmaxxing`,
                target: release.target,
                version: release.version,
              }),
            now,
          },
          testCase.currentVersion,
          paths,
        ),
      ).resolves.toMatchObject({
        installedVersion: testCase.nextVersion,
        latestVersion: testCase.nextVersion,
        manager: "registry",
        reason: null,
        status: "success",
      });
      expect(fetchedSpecifiers).toEqual([testCase.specifier]);
    }
  });

  it("does not install an older registry runner candidate", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: () => Effect.succeed(registryRelease("0.4.18-alpha.1")),
          installRunnerRelease: () => Effect.fail(new Error("should not install")),
          now,
        },
        "0.4.18-alpha.2",
        paths!,
      ),
    ).resolves.toMatchObject({
      installedVersion: "0.4.18-alpha.2",
      latestVersion: "0.4.18-alpha.1",
      manager: "registry",
      reason: null,
      status: "not-needed",
    });
  });

  it("does not install a registry runner candidate from a different release channel", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: () => Effect.succeed(registryRelease("0.4.18")),
          installRunnerRelease: () => Effect.fail(new Error("should not install")),
          now,
        },
        "0.4.18-alpha.1",
        paths!,
      ),
    ).resolves.toMatchObject({
      installedVersion: "0.4.18-alpha.1",
      latestVersion: "0.4.18",
      manager: "registry",
      reason: null,
      status: "not-needed",
    });
  });

  it("reports registry runner install failures without blocking sync", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: () => Effect.succeed(registryRelease("0.4.13")),
          installRunnerRelease: () => Effect.fail(new Error("disk full")),
          now,
        },
        "0.4.12",
        paths!,
      ),
    ).resolves.toMatchObject({
      error: "disk full",
      latestVersion: "0.4.13",
      manager: "registry",
      reason: "install-failed",
      status: "failure",
    });
  });

  it("falls back when preferred registry runner package metadata is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-registry-update-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const fetchedTargets: string[] = [];
      const fetchedSpecifiers: string[] = [];
      const installedTargets: string[] = [];

      await expect(
        runAutoUpdate(
          registryMetadata,
          {
            fetchRunnerRelease: (target, versionSpecifier) => {
              fetchedTargets.push(target);
              fetchedSpecifiers.push(versionSpecifier);
              return Effect.succeed(
                target === "darwin-x64-baseline"
                  ? {
                      integrity: "sha512-test",
                      packageName: serviceRunnerPackageName(target),
                      tarballUrl: "https://registry.example/tokenmaxxing.tgz",
                      target,
                      version: "0.4.18-alpha.2",
                    }
                  : null,
              );
            },
            installRunnerRelease: (release) => {
              installedTargets.push(release.target);
              return Effect.succeed({
                packageName: release.packageName,
                path: "/tmp/tokenmaxxing/service-runners/0.4.18-alpha.2/darwin-x64-baseline/tokenmaxxing",
                target: release.target,
                version: release.version,
              });
            },
            now,
            runnerTargetCandidates: () => ["darwin-x64", "darwin-x64-baseline"],
          },
          "0.4.18-alpha.1",
          paths,
        ),
      ).resolves.toMatchObject({
        installedVersion: "0.4.18-alpha.2",
        latestVersion: "0.4.18-alpha.2",
        manager: "registry",
        reason: null,
        status: "success",
      });
      expect(fetchedTargets).toEqual(["darwin-x64", "darwin-x64-baseline"]);
      expect(fetchedSpecifiers).toEqual(["alpha", "alpha"]);
      expect(installedTargets).toEqual(["darwin-x64-baseline"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not fallback when preferred registry runner metadata fetch fails", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });
    const fetchedTargets: string[] = [];

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: (target) => {
            fetchedTargets.push(target);
            return Effect.fail(
              new ServiceRunnerUpdateError({
                cause: "registry returned 500",
                reason: "download-failed",
              }),
            );
          },
          now,
          runnerTargetCandidates: () => ["darwin-x64", "darwin-x64-baseline"],
        },
        "0.4.12",
        paths!,
      ),
    ).resolves.toMatchObject({
      error: "registry returned 500",
      latestVersion: null,
      manager: "registry",
      reason: "download-failed",
      status: "failure",
    });
    expect(fetchedTargets).toEqual(["darwin-x64"]);
  });

  it("does not silently fallback after an integrity mismatch for a selected registry package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-registry-update-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const fetchedTargets: string[] = [];

      await expect(
        runAutoUpdate(
          registryMetadata,
          {
            fetchRunnerRelease: (target) => {
              fetchedTargets.push(target);
              return Effect.succeed({
                integrity: "sha512-test",
                packageName: serviceRunnerPackageName(target),
                tarballUrl: "https://registry.example/tokenmaxxing.tgz",
                target,
                version: "0.4.13",
              });
            },
            installRunnerRelease: () =>
              Effect.fail(
                new ServiceRunnerUpdateError({
                  cause: "npm integrity verification failed",
                  reason: "integrity-mismatch",
                }),
              ),
            now,
            runnerTargetCandidates: () => ["darwin-x64", "darwin-x64-baseline"],
          },
          "0.4.12",
          paths,
        ),
      ).resolves.toMatchObject({
        error: "npm integrity verification failed",
        manager: "registry",
        reason: "integrity-mismatch",
        status: "failure",
      });
      expect(fetchedTargets).toEqual(["darwin-x64"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not advance the runner pointer when registry update metadata write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-registry-update-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const oldRunnerPath = join(dir, "service-runners", "0.4.12", "darwin-arm64", "tokenmaxxing");
      const newRunnerPath = join(dir, "service-runners", "0.4.13", "darwin-arm64", "tokenmaxxing");
      await mkdir(dirname(oldRunnerPath), { recursive: true });
      await writeFile(oldRunnerPath, "#!/bin/sh\n");
      await writeFile(paths.runnerPointerPath, `${oldRunnerPath}\n`);
      await mkdir(paths.metadataPath, { recursive: true });

      await expect(
        runAutoUpdate(
          registryMetadata,
          {
            fetchRunnerRelease: () => Effect.succeed(registryRelease("0.4.13")),
            installRunnerRelease: (release) =>
              Effect.succeed({
                packageName: release.packageName,
                path: newRunnerPath,
                target: release.target,
                version: release.version,
              }),
            now,
          },
          "0.4.12",
          paths,
        ),
      ).resolves.toMatchObject({
        manager: "registry",
        reason: "install-failed",
        status: "failure",
      });
      await expect(readFile(paths.runnerPointerPath, "utf8")).resolves.toBe(`${oldRunnerPath}\n`);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("serviceScheduledSyncSince", () => {
  it("uses the previous successful local date for scheduled syncs", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "2026-06-16T23:30:00.000Z", version: 1 },
        new Date("2026-06-17T00:05:00.000Z"),
        true,
      ),
    ).toBe("2026-06-16");
  });

  it("falls back to the legacy success date when no timestamp marker exists", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessDate: "2026-06-15", version: 1 },
        new Date("2026-06-17T12:00:00.000Z"),
        true,
      ),
    ).toBe("2026-06-15");
  });

  it("falls back to yesterday when no reliable marker exists", () => {
    expect(
      serviceScheduledSyncSince({ version: 1 }, new Date("2026-06-17T12:00:00.000Z"), true),
    ).toBe("2026-06-16");
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "not-a-date", version: 1 },
        new Date("2026-06-17T12:00:00.000Z"),
        true,
      ),
    ).toBe("2026-06-16");
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "2026-06-18T00:00:00.000Z", version: 1 },
        new Date("2026-06-17T12:00:00.000Z"),
        true,
      ),
    ).toBe("2026-06-16");
  });

  it("does not set since for manual service runs", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "2026-06-16T23:30:00.000Z", version: 1 },
        new Date("2026-06-17T00:05:00.000Z"),
        false,
      ),
    ).toBeUndefined();
  });
});

describe("service run state", () => {
  const syncResult: SyncResult = {
    dryRun: false,
    rows: 42,
    sourceResults: [
      {
        source: "codex",
        status: "synced",
        summary: { days: 3, models: 2, rows: 42, sessions: null, spendUsd: 12.34 },
      },
      { reason: "no_data", source: "gemini", status: "skipped", summary: null },
    ],
    sources: {
      codex: { days: 3, models: 2, rows: 42, sessions: null, spendUsd: 12.34 },
      gemini: null,
    },
    status: "ok",
    upserted: 40,
  };

  it("captures success diagnostics and source summaries", () => {
    const state = serviceRunSuccessState(
      { lastError: "old error", version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        autoUpdate: autoUpdateReport({
          reason: "manager-not-found",
          status: "skipped",
        }),
        durationMs: 1234,
        result: syncResult,
        since: "2026-06-16",
        successAt: "2026-06-16T10:00:01.000Z",
        version: "0.4.12",
      },
    );

    expect(state).toMatchObject({
      lastArch: "arm64",
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastAutoUpdate: expect.objectContaining({
        reason: "manager-not-found",
        status: "skipped",
      }),
      lastAutoUpdated: false,
      lastCliVersion: "0.4.12",
      lastDurationMs: 1234,
      lastError: undefined,
      lastRows: 42,
      lastSince: "2026-06-16",
      lastSuccessAt: "2026-06-16T10:00:01.000Z",
      lastSyncStatus: "ok",
      lastUpserted: 40,
      version: 1,
    });
    expect(state.lastSources).toEqual([
      {
        days: 3,
        models: 2,
        rows: 42,
        sessions: null,
        source: "codex",
        spendUsd: 12.34,
        status: "synced",
      },
      { source: "gemini", status: "skipped" },
    ]);
  });

  it("records source collection failures without advancing the last success", () => {
    const failedResult: SyncResult = {
      dryRun: false,
      rows: 0,
      sourceResults: [
        {
          issue: {
            code: "command_not_found",
            message: "ccusage command not found",
            report: "daily",
          },
          source: "codex",
          status: "failed",
          summary: null,
        },
      ],
      sources: { codex: null },
      status: "error",
    };

    const state = serviceRunSuccessState(
      {
        lastSuccessAt: "2026-06-16T09:00:00.000Z",
        version: 1,
      },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        autoUpdate: autoUpdateReport(),
        durationMs: 1234,
        result: failedResult,
        successAt: "2026-06-16T10:00:01.000Z",
        version: "0.4.23",
      },
    );

    expect(state).toMatchObject({
      lastError: "ccusage source collection failed",
      lastRows: 0,
      lastSuccessAt: "2026-06-16T09:00:00.000Z",
      lastSyncStatus: "error",
      lastUpserted: 0,
    });
    expect(state.lastSources).toEqual([
      {
        issue: {
          code: "command_not_found",
          message: "ccusage command not found",
          report: "daily",
        },
        source: "codex",
        status: "failed",
      },
    ]);
  });

  it("records partial source diagnostics while advancing the last success", () => {
    const partialResult: SyncResult = {
      dryRun: false,
      rows: 42,
      sourceResults: [
        {
          issue: {
            code: "invalid_report",
            message: "ccusage returned an invalid session report",
            report: "session",
          },
          source: "codex",
          status: "partial",
          summary: { days: 3, models: 2, rows: 42, sessions: null, spendUsd: 12.34 },
        },
      ],
      sources: {
        codex: { days: 3, models: 2, rows: 42, sessions: null, spendUsd: 12.34 },
      },
      status: "partial",
      upserted: 40,
    };

    const state = serviceRunSuccessState(
      { version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        autoUpdate: autoUpdateReport(),
        durationMs: 1234,
        result: partialResult,
        successAt: "2026-06-16T10:00:01.000Z",
        version: "0.4.23",
      },
    );

    expect(state).toMatchObject({
      lastError: undefined,
      lastRows: 42,
      lastSuccessAt: "2026-06-16T10:00:01.000Z",
      lastSyncStatus: "partial",
      lastUpserted: 40,
    });
    expect(state.lastSources).toEqual([
      {
        days: 3,
        issue: {
          code: "invalid_report",
          message: "ccusage returned an invalid session report",
          report: "session",
        },
        models: 2,
        rows: 42,
        sessions: null,
        source: "codex",
        spendUsd: 12.34,
        status: "partial",
      },
    ]);
  });

  it("captures failure diagnostics without clobbering previous success", () => {
    const state = serviceRunFailureState(
      {
        lastRows: 42,
        lastSources: [{ source: "codex", status: "synced" }],
        lastSuccessAt: "2026-06-16T09:00:00.000Z",
        lastUpserted: 40,
        version: 1,
      },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        durationMs: 222,
        error: "network unavailable",
        since: "2026-06-16",
        version: "0.4.12",
      },
    );

    expect(state).toMatchObject({
      lastArch: "arm64",
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastCliVersion: "0.4.12",
      lastDurationMs: 222,
      lastError: "network unavailable",
      lastRows: 42,
      lastSince: "2026-06-16",
      lastSuccessAt: "2026-06-16T09:00:00.000Z",
      lastUpserted: 40,
    });
  });

  it("renders structured service log lines without undefined fields", () => {
    const line = serviceRunLogLine(
      {
        lastArch: "arm64",
        lastAttemptAt: "2026-06-16T10:00:00.000Z",
        lastCliVersion: "0.4.12",
        lastDurationMs: 222,
        lastError: "network unavailable",
        lastSince: "2026-06-16",
        version: 1,
      },
      "failure",
    );

    expect(JSON.parse(JSON.stringify(line))).toMatchObject({
      arch: "arm64",
      durationMs: 222,
      error: "network unavailable",
      event: "service_run",
      since: "2026-06-16",
      status: "failure",
      version: "0.4.12",
    });
  });
});

describe("deterministicServiceJitterMs", () => {
  it("returns a stable delay within the configured jitter window", () => {
    const first = deterministicServiceJitterMs("device_123");
    const second = deterministicServiceJitterMs("device_123");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(60 * 1000);
  });
});

describe("service lock status", () => {
  it("marks recent locks as active and old locks as stale", () => {
    const recent = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: 123,
        version: 1,
      },
      new Date("2026-06-16T11:59:59.000Z"),
    );
    const stale = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: 123,
        version: 1,
      },
      new Date("2026-06-16T12:00:00.000Z"),
    );

    expect(recent.locked).toBe(true);
    expect(recent.stale).toBe(false);
    expect(stale.locked).toBe(true);
    expect(stale.stale).toBe(true);
    expect(formatServiceLockStatus(stale)).toContain("(stale)");
  });

  it("does not replace a stale lock while the recorded process is alive", async () => {
    const stale = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: process.pid,
        version: 1,
      },
      new Date("2026-06-16T12:00:00.000Z"),
    );

    await expect(serviceLockCanBeReplaced(stale, { pidAwareStaleTakeover: true })).resolves.toBe(
      false,
    );
    await expect(serviceLockCanBeReplaced(stale, { pidAwareStaleTakeover: false })).resolves.toBe(
      true,
    );
  });
});

describe("service runner registry artifacts", () => {
  it("verifies npm SRI integrity strings", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = createHash("sha512").update(bytes).digest("base64");

    expect(verifyNpmIntegrity(bytes, `sha512-${digest}`)).toBe(true);
    expect(verifyNpmIntegrity(bytes, "sha512-not-the-digest")).toBe(false);
  });

  it("extracts only the expected runner path from an npm tarball", async () => {
    const runner = new TextEncoder().encode("#!/bin/sh\n");
    const tarball = makeTarball([
      { data: new TextEncoder().encode("{}"), path: "package/package.json" },
      { data: runner, path: "package/bin/tokenmaxxing" },
    ]);

    await expect(extractServiceRunnerFromTarball(tarball, "tokenmaxxing")).resolves.toEqual(runner);
  });

  it("rejects unsafe tar paths before installing runner bytes", async () => {
    const tarball = makeTarball([
      { data: new TextEncoder().encode("bad"), path: "package/../tokenmaxxing" },
    ]);

    await expect(extractServiceRunnerFromTarball(tarball, "tokenmaxxing")).rejects.toMatchObject({
      _tag: "ServiceRunnerUpdateError",
    });
  });
});

describe("service runner installation", () => {
  it("copies an installed optional runner package into config-owned storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-install-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const packageName = serviceRunnerPackageName("darwin-arm64");
      const packageJsonPath = await writeFakeRunnerPackage(dir, packageName, "tokenmaxxing");

      const installed = await Effect.runPromise(
        installServiceRunnerFromOptionalPackage(paths, {
          cpuArch: "arm64",
          platform: "darwin",
          resolvePackageJson: (name) => (name === packageName ? packageJsonPath : null),
        }),
      );

      expect(installed).toMatchObject({
        packageName,
        target: "darwin-arm64",
        version: "9.9.9",
      });
      expect(installed.path).toBe(join(paths.runnersDir, "9.9.9", "darwin-arm64", "tokenmaxxing"));
      await expect(readFile(paths.runnerPointerPath, "utf8")).resolves.toBe(`${installed.path}\n`);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("can stage an installed optional runner package without advancing the pointer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-install-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const packageName = serviceRunnerPackageName("darwin-arm64");
      const packageJsonPath = await writeFakeRunnerPackage(dir, packageName, "tokenmaxxing");

      const installed = await Effect.runPromise(
        installServiceRunnerFromOptionalPackage(paths, {
          cpuArch: "arm64",
          platform: "darwin",
          resolvePackageJson: (name) => (name === packageName ? packageJsonPath : null),
          updatePointer: false,
        }),
      );

      await expect(readFile(installed.path, "utf8")).resolves.toBe("#!/bin/sh\n");
      await expect(readFile(paths.runnerPointerPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("copies a nested optional native package from a native main package install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-install-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const mainPackageDir = join(dir, "global", "@851-labs", "tokenmaxxing");
      const mainBinaryPath = join(mainPackageDir, "bin", "tokenmaxxing.exe");
      await mkdir(dirname(mainBinaryPath), { recursive: true });
      await writeFile(mainBinaryPath, "#!/bin/sh\n");
      await chmod(mainBinaryPath, 0o755);

      const packageName = serviceRunnerPackageName("darwin-arm64");
      const packageJsonPath = await writeFakeRunnerPackage(
        join(mainPackageDir, "node_modules"),
        packageName,
        "tokenmaxxing",
      );

      await expect(
        realpath(resolveExecutableSiblingPackageJson(packageName, [mainBinaryPath])!),
      ).resolves.toBe(await realpath(packageJsonPath));

      const installed = await Effect.runPromise(
        installServiceRunnerFromOptionalPackage(paths, {
          cpuArch: "arm64",
          platform: "darwin",
          resolvePackageJson: (name) => resolveExecutableSiblingPackageJson(name, [mainBinaryPath]),
        }),
      );

      expect(installed).toMatchObject({
        packageName,
        target: "darwin-arm64",
        version: "9.9.9",
      });
      await expect(readFile(installed.path, "utf8")).resolves.toBe("#!/bin/sh\n");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back when the preferred optional package is absent but a candidate package exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-install-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const fallbackPackageName = serviceRunnerPackageName("darwin-x64-baseline");
      const fallbackPackageJsonPath = await writeFakeRunnerPackage(
        dir,
        fallbackPackageName,
        "tokenmaxxing",
      );

      const installed = await Effect.runPromise(
        installServiceRunnerFromOptionalPackage(paths, {
          avx2: true,
          cpuArch: "x64",
          platform: "darwin",
          resolvePackageJson: (name) =>
            name === fallbackPackageName ? fallbackPackageJsonPath : null,
        }),
      );

      expect(installed.packageName).toBe(fallbackPackageName);
      expect(installed.target).toBe("darwin-x64-baseline");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to a registry runner when no optional package is installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-install-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const release = {
        integrity: "sha512-test",
        packageName: serviceRunnerPackageName("darwin-arm64"),
        tarballUrl: "https://registry.example/tokenmaxxing.tgz",
        target: "darwin-arm64" as const,
        version: "1.2.3",
      };
      const fetchedSpecifiers: string[] = [];

      const installed = await Effect.runPromise(
        installServiceRunner(paths, {
          cpuArch: "arm64",
          fetchRunnerRelease: (target, versionSpecifier) => {
            fetchedSpecifiers.push(versionSpecifier);
            return Effect.succeed(target === "darwin-arm64" ? release : null);
          },
          installRunnerRelease: (candidateRelease) =>
            Effect.succeed({
              packageName: candidateRelease.packageName,
              path: "/tmp/tokenmaxxing/service-runners/1.2.3/darwin-arm64/tokenmaxxing",
              target: candidateRelease.target,
              version: candidateRelease.version,
            }),
          platform: "darwin",
          resolvePackageJson: () => null,
        }),
      );

      expect(installed).toMatchObject({
        packageName: release.packageName,
        target: "darwin-arm64",
        version: "1.2.3",
      });
      expect(fetchedSpecifiers).toEqual([packageJson.version]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("tries registry runner candidates in order and reports all-missing clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-install-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const fetchedTargets: string[] = [];
      const fetchedSpecifiers: string[] = [];

      const installed = await Effect.runPromise(
        installServiceRunner(paths, {
          avx2: true,
          cpuArch: "x64",
          fetchRunnerRelease: (target, versionSpecifier) => {
            fetchedTargets.push(target);
            fetchedSpecifiers.push(versionSpecifier);
            return Effect.succeed(
              target === "darwin-x64-baseline"
                ? {
                    integrity: "sha512-test",
                    packageName: serviceRunnerPackageName(target),
                    tarballUrl: "https://registry.example/tokenmaxxing.tgz",
                    target,
                    version: "1.2.3",
                  }
                : null,
            );
          },
          installRunnerRelease: (release) =>
            Effect.succeed({
              packageName: release.packageName,
              path: "/tmp/tokenmaxxing/service-runners/1.2.3/darwin-x64-baseline/tokenmaxxing",
              target: release.target,
              version: release.version,
            }),
          platform: "darwin",
          resolvePackageJson: () => null,
        }),
      );

      expect(fetchedTargets).toEqual(["darwin-x64", "darwin-x64-baseline"]);
      expect(fetchedSpecifiers).toEqual([packageJson.version, packageJson.version]);
      expect(installed.target).toBe("darwin-x64-baseline");

      const exit = await Effect.runPromiseExit(
        installServiceRunner(paths, {
          cpuArch: "arm64",
          fetchRunnerRelease: () => Effect.succeed(null),
          platform: "darwin",
          resolvePackageJson: () => null,
        }),
      );
      expect(failureTag(exit)).toBe("ServiceRunnerPackageMissingError");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps an existing valid runner during repair before using registry fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-repair-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: "/Users/alex",
        platform: "darwin",
      })!;
      const existingRunnerPath = join(paths.runnersDir, "0.4.17", "darwin-arm64", "tokenmaxxing");
      await mkdir(dirname(existingRunnerPath), { recursive: true });
      await writeFile(existingRunnerPath, "#!/bin/sh\n");
      await mkdir(dirname(paths.runnerPointerPath), { recursive: true });
      await writeFile(paths.runnerPointerPath, `${existingRunnerPath}\n`);
      await writeFile(
        paths.metadataPath,
        `${JSON.stringify({
          autoUpdateManager: "registry",
          backend: "launchd",
          commandPath: existingRunnerPath,
          installedAt: "2026-06-16T09:00:00.000Z",
          runnerPackage: serviceRunnerPackageName("darwin-arm64"),
          runnerPath: existingRunnerPath,
          runnerTarget: "darwin-arm64",
          runnerVersion: "0.4.17",
          schedule: "syncs every 5 minutes",
          templateVersion: 4,
          version: 1,
        })}\n`,
      );

      const installed = await Effect.runPromise(
        installServiceRunnerForRepair(paths, {
          cpuArch: "arm64",
          fetchRunnerRelease: () =>
            Effect.fail(
              new ServiceRunnerUpdateError({
                cause: "should not fetch registry",
                reason: "download-failed",
              }),
            ),
          platform: "darwin",
          resolvePackageJson: () => null,
        }),
      );

      expect(installed).toEqual({
        packageName: serviceRunnerPackageName("darwin-arm64"),
        path: existingRunnerPath,
        target: "darwin-arm64",
        version: "0.4.17",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("formatServiceStatusAutoUpdate", () => {
  it("does not imply auto-update is enabled before service metadata exists", () => {
    expect(formatServiceStatusAutoUpdate(null)).toBe("unknown (service not installed)");
    expect(
      formatServiceStatusAutoUpdate({
        autoUpdate: false,
        backend: "launchd",
        commandPath: "/usr/local/bin/tokenmaxxing",
        installedAt: "2026-06-16T00:00:00.000Z",
        schedule: "daily",
        version: 1,
      } as ServiceMetadata),
    ).toBe("enabled (package manager not detected)");
    expect(
      formatServiceStatusAutoUpdate({
        autoUpdateManager: "npm",
        backend: "launchd",
        commandPath: "/usr/local/bin/tokenmaxxing",
        installedAt: "2026-06-16T00:00:00.000Z",
        schedule: "daily",
        version: 1,
      }),
    ).toBe("enabled via npm");
  });
});

describe("serviceInstallProgram", () => {
  it("starts browser login and installs the service when no stored token exists", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, pointerWrites, runtime, runner, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.logs).toContain("Not logged in; starting browser login");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
    expect(state.logs).toContain("Detecting tokenmaxxing install");
    expect(state.logs).toContain("Found tokenmaxxing install");
    expect(state.logs).toContain("Installing service runner");
    expect(state.logs).toContain("Service runner installed (0.4.17/darwin-arm64)");
    expect(state.logs).toContain("Writing service files");
    expect(state.logs).toContain("Service files written");
    expect(state.logs).toContain("Installing scheduler");
    expect(state.logs).toContain("Scheduler installed");
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
    expect(written).toHaveLength(1);
    expect(installed).toEqual([written[0]?.paths]);
    expect(pointerWrites).toEqual([{ paths: written[0]?.paths, runnerPath: runner.path }]);
    expect(written[0]?.metadata).toMatchObject({
      autoUpdateManager: "registry",
      commandPath: "/tmp/tokenmaxxing/service-runners/0.4.17/darwin-arm64/tokenmaxxing",
      installedAt: "2026-06-16T12:00:00.000Z",
      runnerTarget: "darwin-arm64",
      runnerVersion: "0.4.17",
      templateVersion: 5,
    });
    expect(written[0]?.metadata).not.toHaveProperty("autoUpdate");
    expect(state.logs).toContain("Automatic sync installed");
  });

  it("installs the service when the package manager cannot be detected", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_existing",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime({
      install: {
        autoUpdateManager: null,
        commandPath: "/usr/local/bin/tokenmaxxing",
        resolvedCommandPath: "/usr/local/bin/tokenmaxxing",
      },
    });

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(written).toHaveLength(1);
    expect(written[0]?.metadata.autoUpdateManager).toBe("registry");
    expect(written[0]?.metadata).not.toHaveProperty("autoUpdate");
    expect(installed).toEqual([written[0]?.paths]);
    expect(state.logs).toContain("Auto-update: enabled via registry runner packages");
  });

  it("does not persist a discovered vite-plus runtime path into scheduled service files", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_existing",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const transientPath = "/Users/joel/.vite-plus/js_runtime/node/24.17.0/bin/tokenmaxxing";
    const { runtime, runner, written } = makeInstallRuntime({
      install: {
        autoUpdateManager: "npm",
        commandPath: transientPath,
        resolvedCommandPath: transientPath,
      },
    });

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(written[0]?.metadata.commandPath).toBe(runner.path);
    expect(written[0]?.metadata.runnerPath).toBe(runner.path);
    expect(written[0]?.wrapper).toContain("/tmp/tokenmaxxing/service-runner-current");
    expect(written[0]?.wrapper).not.toContain(transientPath);
  });

  it("relogs in and continues installing when the stored token is revoked", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.clearedTokens).toBe(1);
    expect(state.logs).toContain("Stored token is no longer valid; starting browser login");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
    expect(written).toHaveLength(1);
    expect(installed).toEqual([written[0]?.paths]);
    expect(written[0]?.metadata).not.toHaveProperty("autoUpdate");
  });

  it("still rejects TOKENMAXXING_API_TOKEN before starting login or installing", async () => {
    const { layer, state } = makeTestLayer({
      envTokenActive: true,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_env",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("ServiceEnvTokenError");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(written).toEqual([]);
    expect(installed).toEqual([]);
  });

  it("does not install while a service repair or runner update lock is active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-install-lock-"));

    try {
      await writeFile(
        join(dir, "service-update.lock"),
        `${JSON.stringify({
          acquiredAt: new Date().toISOString(),
          ownerId: "test-lock",
          pid: process.pid,
          version: 1,
        })}\n`,
      );
      const { layer } = makeTestLayer({
        initialConfig: {
          apiUrl: "https://api.tokenmaxxing.example",
          token: "tmx_existing",
          wwwUrl: "https://tokenmaxxing.example",
        },
      });
      const { installed, runtime, written } = makeInstallRuntime({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
      });

      const exit = await Effect.runPromiseExit(
        serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(
          Effect.provide(layer),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(failureTag(exit)).toBe("ServiceInstallError");
      expect(written).toEqual([]);
      expect(installed).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not install when login cannot run in a non-interactive shell", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("NonInteractiveLoginError");
    expect(state.logs).toContain("Not logged in; starting browser login");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(written).toEqual([]);
    expect(installed).toEqual([]);
  });

  it("does not start browser login when service install runs with --json", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, json: true, refresh: false }, runtime).pipe(
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("NotLoggedInError");
    expect(state.browserUrls).toEqual([]);
    expect(state.logs).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(written).toEqual([]);
    expect(installed).toEqual([]);
  });

  it("refreshes service files without starting login", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: true }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(state.logs).toContain("Detecting tokenmaxxing install");
    expect(state.logs).toContain("Found tokenmaxxing install");
    expect(state.logs).toContain("Installing service runner");
    expect(state.logs).toContain("Service runner installed (0.4.17/darwin-arm64)");
    expect(state.logs).toContain("Writing service files");
    expect(state.logs).toContain("Service files written");
    expect(state.logs).toContain("Installing scheduler");
    expect(state.logs).toContain("Scheduler installed");
    expect(written).toHaveLength(1);
    expect(written[0]?.metadata).not.toHaveProperty("autoUpdate");
    expect(installed).toEqual([written[0]?.paths]);
  });
});

describe("command lookup", () => {
  it("finds an executable tokenmaxxing binary on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-"));

    try {
      const binary = join(dir, "tokenmaxxing");
      await writeFile(binary, "#!/bin/sh\n");
      await chmod(binary, 0o755);

      await expect(
        findCommandOnPath("tokenmaxxing", { PATH: ["/missing", dir].join(delimiter) }, "linux"),
      ).resolves.toBe(binary);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("detects temporary package-runner paths", () => {
    expect(isEphemeralCommandPath("/home/alex/.npm/_npx/123/node_modules/.bin/tokenmaxxing")).toBe(
      true,
    );
    expect(isEphemeralCommandPath("/Users/alex/.bun/install/cache/@851-labs/tokenmaxxing")).toBe(
      true,
    );
    expect(
      isEphemeralCommandPath("/Users/alex/.local/state/fnm_multishells/123/bin/tokenmaxxing"),
    ).toBe(true);
    expect(isEphemeralCommandPath("/usr/local/bin/tokenmaxxing")).toBe(false);
  });

  it("uses stable resolved paths only for transient command shims", () => {
    const commandPath = "/Users/alex/.local/state/fnm_multishells/123/bin/tokenmaxxing";
    const resolvedCommandPath =
      "/Users/alex/.local/share/fnm/node-versions/v22.21.0/installation/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js";

    expect(isTransientCommandShimPath(commandPath)).toBe(true);
    expect(durableTokenmaxxingCommandPath(commandPath, resolvedCommandPath)).toBe(
      resolvedCommandPath,
    );
    expect(durableTokenmaxxingCommandPath("/usr/local/bin/tokenmaxxing", resolvedCommandPath)).toBe(
      "/usr/local/bin/tokenmaxxing",
    );
    expect(
      durableTokenmaxxingCommandPath("/Users/alex/.volta/bin/tokenmaxxing", resolvedCommandPath),
    ).toBe("/Users/alex/.volta/bin/tokenmaxxing");
    expect(
      durableTokenmaxxingCommandPath(
        commandPath,
        "/Users/alex/.npm/_npx/123/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      ),
    ).toBe(commandPath);
  });

  it("detects the package manager for common global install paths", () => {
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/.bun/bin/tokenmaxxing",
        resolvedCommandPath:
          "/Users/alex/.bun/install/global/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("bun");
    expect(
      detectAutoUpdateManager({
        commandPath: "/opt/homebrew/bin/tokenmaxxing",
        resolvedCommandPath: "/opt/homebrew/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("npm");
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/Library/pnpm/tokenmaxxing",
        resolvedCommandPath: "/Users/alex/Library/pnpm/tokenmaxxing",
      }),
    ).toBe("pnpm");
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/.yarn/bin/tokenmaxxing",
        resolvedCommandPath:
          "/Users/alex/.config/yarn/global/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("yarn");
    expect(
      detectAutoUpdateManager({
        commandPath: "/opt/custom/bin/tokenmaxxing",
        resolvedCommandPath: "/opt/custom/bin/tokenmaxxing",
      }),
    ).toBeNull();
  });
});
