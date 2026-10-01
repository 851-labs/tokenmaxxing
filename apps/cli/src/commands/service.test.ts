import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { Cause, Effect, Exit, Layer } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Unauthorized, UserId, type AuthUser, type UsageSource } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

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
  npmPrefixOfInstall,
  npmUpdatePrefix,
  commandShimInvocation,
  deferredServiceRepairInvocation,
  doctorServiceEnvCheck,
  parseServiceWrapperEnv,
  serviceEnvDrift,
  detectAutoUpdateManager,
  deterministicServiceJitterMs,
  durableTokenmaxxingCommandPath,
  ensureServiceConfigDirSupported,
  extractServiceRunnerFromTarball,
  findCommandOnPath,
  formatServiceLastError,
  formatServiceLockStatus,
  installNativeScheduler,
  installServiceRunner,
  installServiceRunnerBinary,
  isTransientServiceFailure,
  windowsElevatedOverFilteredToken,
  ServiceInstallError,
  WindowsTaskAccessDeniedError,
  installServiceRunnerForRepair,
  installServiceRunnerFromOptionalPackage,
  isEphemeralCommandPath,
  isTransientCommandShimPath,
  isWindowsNpmPrefixShim,
  keepNewerCurrentRunner,
  launchdJobMatches,
  legacyServiceWrapperPaths,
  PackageManagerUpdateError,
  packageManagerFailureOutput,
  readCurrentServiceRunnerInstall,
  readWindowsLauncherStatus,
  removeServiceFiles,
  resolveExecutableSiblingPackageJson,
  renderLaunchdPlist,
  renderSystemdService,
  renderServiceWrapper,
  renderSystemdTimer,
  renderWindowsLauncher,
  runServiceAutoUpdate,
  scheduleDescription,
  acquireServiceRunLock,
  inspectServiceRunner,
  serviceLockCanBeReplaced,
  serviceRepairCanInstallScheduler,
  serviceReloadRequired,
  serviceRepairNeedsSchedulerInstall,
  serviceRepairReason,
  serviceRepairReasons,
  serviceRepairState,
  serviceNewerThanCli,
  ServiceNewerThanCliError,
  doctorTemplateCheck,
  reportServiceDoctor,
  serviceAutoUpdateCheck,
  serviceDoctorChecks,
  serviceDoctorHealth,
  ServiceDoctorProblemsError,
  serviceLockCheck,
  serviceStatusRunnerLines,
  serviceRunnerPackageName,
  serviceRunnerTarget,
  serviceCompletedUsageReplacementBackfill,
  serviceDefinitionOwner,
  serviceDefinitionUsesConfigDir,
  windowsTaskMatches,
  withInstalledWindowsSpelling,
  decodeWindowsCommandOutput,
  readRegisteredWindowsTaskXml,
  serviceNeedsUsageReplacementBackfill,
  serviceReconcileDue,
  serviceReconcileSince,
  serviceReconcileWindowDays,
  serviceScheduledSyncSince,
  serviceInstallProgram,
  serviceLockStatus,
  serviceRunFailureState,
  serviceAuthFailureError,
  serviceRunLogLine,
  redactHomePaths,
  serviceRunSuccessState,
  ServiceConfigDirUnsupportedError,
  ServiceRepairError,
  ServiceRunError,
  ServiceRunnerUpdateError,
  ServiceSourcesFailedError,
  type CommandInstall,
  type DoctorCheck,
  type ServiceDoctorFacts,
  type ServiceLockStatus,
  type ServiceAutoUpdateReport,
  type ServiceFilesChange,
  type ServiceMetadata,
  type ServicePaths,
  type ServiceState,
  servicePaths,
  serviceStateJson,
  systemdUnitsAreCurrent,
  verifyNpmIntegrity,
  waitForServiceRunExit,
  encodeWindowsTaskXml,
  renderWindowsTaskXml,
  windowsLauncherDoctorCheck,
  windowsLauncherPath,
  windowsScriptHostPath,
  windowsTaskCreateArgs,
  windowsTaskNames,
  writeServiceFiles,
} from "./service";
import { ApiTimeoutError } from "../api-failure";
import {
  SyncAuthValidationError,
  SyncPushError,
  type SyncResult,
  type SyncSourceIssue,
  type SyncSourceResult,
} from "./sync";
import { NotLoggedInError } from "./whoami";

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
  id: UserId.make("user_123"),
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
                deviceCode: "device-secret",
                expiresAt: "2026-06-13T20:00:00.000Z",
                userCode: "ABC123",
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

function makeInstallRuntime(
  options: {
    env?: Record<string, string | undefined>;
    install?: CommandInstall;
    metadata?: ServiceMetadata;
  } = {},
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
  const schedulerChanges: ServiceFilesChange[] = [];
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
      installScheduler: (paths: ServicePaths, change: ServiceFilesChange) =>
        Effect.sync(() => {
          installed.push(paths);
          schedulerChanges.push(change);
        }),
      installServiceRunner: () => Effect.succeed(runner),
      now: new Date("2026-06-16T12:00:00.000Z"),
      platform: "darwin" as const,
      readMetadata:
        options.metadata === undefined
          ? () => Effect.succeed(null)
          : () => Effect.succeed(options.metadata!),
      writeFiles: (paths: ServicePaths, wrapper: string, metadata: ServiceMetadata) =>
        Effect.sync(() => {
          written.push({ metadata, paths, wrapper });
          return { definition: false, wrapper: true };
        }),
      writeRunnerPointer: (paths: ServicePaths, runnerPath: string): Effect.Effect<void, never> =>
        Effect.sync(() => {
          pointerWrites.push({ paths, runnerPath });
        }),
    },
    pointerWrites,
    runner,
    schedulerChanges,
    written,
  };
}

function unauthorizedError() {
  return new Unauthorized({});
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

const execFileAsync = promisify(execFile);

describe("capturedServiceEnv", () => {
  it("captures nonempty source roots literally and omits empty ones", () => {
    expect(
      capturedServiceEnv({
        CLAUDE_CONFIG_DIR: "/data/Claude Logs, extra",
        CODEX_HOME: "/data/Codex Logs",
        HERMES_HOME: "/data/hermes,/data/hermes/profiles/work",
        HOME: "/home/alex",
        PATH: "/usr/bin",
        TOKENMAXXING_API_TOKEN: "tmx_secret",
        TOKENMAXXING_NPM_REGISTRY: "http://127.0.0.1:4873",
      }),
    ).toEqual({
      CLAUDE_CONFIG_DIR: "/data/Claude Logs, extra",
      CODEX_HOME: "/data/Codex Logs",
      HERMES_HOME: "/data/hermes,/data/hermes/profiles/work",
      HOME: "/home/alex",
      PATH: "/usr/bin",
      TOKENMAXXING_NPM_REGISTRY: "http://127.0.0.1:4873",
    });

    expect(
      capturedServiceEnv({
        CLAUDE_CONFIG_DIR: "",
        CODEX_HOME: undefined,
        HERMES_HOME: "",
        HOME: "/home/alex",
        PATH: "/usr/bin",
      }),
    ).toEqual({ HOME: "/home/alex", PATH: "/usr/bin" });
  });
});

describe("capturedServiceEnv agent data directories", () => {
  it("carries every agent's custom data directory into scheduled syncs", () => {
    const agentDirs = {
      AMP_DATA_DIR: "/data/amp",
      ANTIGRAVITY_DATA_DIR: "/data/antigravity",
      CODEBUFF_DATA_DIR: "/data/codebuff",
      DROID_SESSIONS_DIR: "/data/droid",
      GOOSE_PATH_ROOT: "/data/goose",
      GROK_HOME: "/data/grok",
      KILO_DATA_DIR: "/data/kilo",
      KIMI_DATA_DIR: "/data/kimi",
      OPENCLAW_DIR: "/data/openclaw",
      PI_CONFIG_DIR: ".omp-work",
      QWEN_DATA_DIR: "/data/qwen",
      XDG_DATA_HOME: "/data/xdg",
      ZCODE_HOME: "/data/zcode",
    };

    expect(capturedServiceEnv({ ...agentDirs, GROK_API_KEY: "secret", PATH: "/usr/bin" })).toEqual({
      ...agentDirs,
      PATH: "/usr/bin",
    });
  });
});

describe("serviceEnvDrift", () => {
  const shell = {
    CLAUDE_CONFIG_DIR: "/data/Claude Logs, it's mine",
    CODEX_HOME: 'C:\\Users\\alex\\Codex "Logs"',
    HOME: "/home/alex",
    PATH: "/usr/bin",
    // A batch file writes a literal % as %%.
    TOKENMAXXING_CONFIG_DIR: "C:\\bt\\Zoë O'Neil (Work) & Co 100% ✓\\tm",
  };

  for (const platform of ["linux", "win32"] as const) {
    it(`round-trips the source roots of a ${platform} wrapper`, () => {
      const wrapper = renderServiceWrapper({
        env: capturedServiceEnv(shell),
        logPath: "/tmp/tokenmaxxing.log",
        platform,
        runnerPointerPath: "/tmp/service-runner-current",
      });

      expect(parseServiceWrapperEnv(wrapper)).toMatchObject({
        CLAUDE_CONFIG_DIR: shell.CLAUDE_CONFIG_DIR,
        CODEX_HOME: shell.CODEX_HOME,
        TOKENMAXXING_CONFIG_DIR: shell.TOKENMAXXING_CONFIG_DIR,
      });
      expect(serviceEnvDrift(wrapper, shell)).toEqual([]);
    });
  }

  it("reports roots that changed, appeared, or disappeared since install", () => {
    const wrapper = renderServiceWrapper({
      env: capturedServiceEnv({ ...shell, HERMES_HOME: "/data/hermes" }),
      logPath: "/tmp/tokenmaxxing.log",
      platform: "linux",
      runnerPointerPath: "/tmp/service-runner-current",
    });

    expect(
      serviceEnvDrift(wrapper, {
        ...shell,
        CLAUDE_CONFIG_DIR: "/data/claude-new",
        CODEX_HOME: "",
      }),
    ).toEqual([
      {
        current: "/data/claude-new",
        key: "CLAUDE_CONFIG_DIR",
        service: shell.CLAUDE_CONFIG_DIR,
      },
      { current: undefined, key: "CODEX_HOME", service: shell.CODEX_HOME },
      { current: undefined, key: "HERMES_HOME", service: "/data/hermes" },
    ]);
  });

  it("nudges doctor users to repair when roots drifted", () => {
    const wrapper = renderServiceWrapper({
      env: capturedServiceEnv({ CODEX_HOME: "/data/codex-old", PATH: "/usr/bin" }),
      logPath: "/tmp/tokenmaxxing.log",
      platform: "linux",
      runnerPointerPath: "/tmp/service-runner-current",
    });

    expect(doctorServiceEnvCheck(wrapper, { CODEX_HOME: "/data/codex-old" })).toEqual({
      detail: "match this shell",
      label: "source roots",
      status: "ok",
    });
    expect(doctorServiceEnvCheck(wrapper, { CODEX_HOME: "/data/codex" })).toEqual({
      detail:
        "CODEX_HOME is /data/codex-old for the service but /data/codex here; repair with tokenmaxxing service repair",
      fix: "repair with tokenmaxxing service repair",
      label: "source roots",
      status: "warn",
    });
    expect(doctorServiceEnvCheck(null, {}).status).toBe("info");
  });
});

describe("renderServiceWrapper", () => {
  it.skipIf(process.platform === "win32")(
    "exports captured source roots with spaces, commas, and quotes to the runner",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tokenmaxxing-service-env-"));
      try {
        const runnerPath = join(root, "fake-runner");
        const pointerPath = join(root, "service-runner-current");
        const logPath = join(root, "service.log");
        const claudeRoot = join(root, "Claude Logs, extra");
        const codexRoot = join(root, "Codex's Logs");
        await writeFile(
          runnerPath,
          `#!/bin/sh
printf 'CLAUDE_CONFIG_DIR=%s\\n' "$CLAUDE_CONFIG_DIR"
printf 'CODEX_HOME=%s\\n' "$CODEX_HOME"
printf 'HERMES_HOME=%s\\n' "\${HERMES_HOME-unset}"
`,
          { encoding: "utf8", mode: 0o755 },
        );
        await writeFile(pointerPath, `${runnerPath}\n`, "utf8");
        const wrapperPath = join(root, "tokenmaxxing.sh");
        await writeFile(
          wrapperPath,
          renderServiceWrapper({
            env: capturedServiceEnv({
              CLAUDE_CONFIG_DIR: claudeRoot,
              CODEX_HOME: codexRoot,
              HERMES_HOME: "",
              HOME: root,
              PATH: "/usr/bin:/bin",
            }),
            logPath,
            platform: "linux",
            runnerPointerPath: pointerPath,
          }),
          { encoding: "utf8", mode: 0o755 },
        );

        await execFileAsync("/bin/sh", [wrapperPath], { env: {}, timeout: 5000 });

        const log = await readFile(logPath, "utf8");
        expect(log).toContain(`CLAUDE_CONFIG_DIR=${claudeRoot}\n`);
        expect(log).toContain(`CODEX_HOME=${codexRoot}\n`);
        expect(log).toContain("HERMES_HOME=unset\n");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("runs sync with a durable command without embedding package-manager updates", () => {
    const env = capturedServiceEnv({
      HERMES_HOME: "/data/hermes",
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
    expect(wrapper).toContain("export HERMES_HOME='/data/hermes'");
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

  it("renders an exact-version, cache-bypassing install for each package manager", () => {
    expect(autoUpdateCommandDescription("bun", "0.7.0")).toBe(
      "bun add -g @851-labs/tokenmaxxing@0.7.0 --no-cache --silent",
    );
    expect(autoUpdateCommandDescription("npm", "0.7.0")).toBe(
      "npm install -g @851-labs/tokenmaxxing@0.7.0 --prefer-online --loglevel=error",
    );
    expect(autoUpdateCommandDescription("pnpm", "0.7.0")).toBe(
      "pnpm add -g @851-labs/tokenmaxxing@0.7.0 --loglevel=error",
    );
    expect(autoUpdateCommandDescription("yarn", "0.7.0")).toBe(
      "yarn global add @851-labs/tokenmaxxing@0.7.0 --silent",
    );
  });

  it("runs npm's Windows .cmd shim through cmd.exe, and anything else directly", () => {
    expect(
      commandShimInvocation(
        "C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.CMD",
        ["--version"],
        "win32",
        { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.CMD" --version"',
      ],
      command: "C:\\Windows\\system32\\cmd.exe",
      windowsVerbatimArguments: true,
    });
    expect(
      commandShimInvocation("C:\\bun\\bin\\tokenmaxxing.exe", ["--version"], "win32", {}),
    ).toEqual({
      args: ["--version"],
      command: "C:\\bun\\bin\\tokenmaxxing.exe",
      windowsVerbatimArguments: false,
    });
    expect(commandShimInvocation("/usr/local/bin/tokenmaxxing", ["--version"], "linux")).toEqual({
      args: ["--version"],
      command: "/usr/local/bin/tokenmaxxing",
      windowsVerbatimArguments: false,
    });
  });

  it("finds the npm prefix an install lives under, and passes it only when npm's differs", () => {
    const posix = {
      commandPath: "/Users/alex/tools/npm-global/bin/tokenmaxxing",
      resolvedCommandPath:
        "/Users/alex/tools/npm-global/lib/node_modules/@851-labs/tokenmaxxing/node_modules/@851-labs/tokenmaxxing-darwin-arm64/bin/tokenmaxxing",
    };
    expect(npmPrefixOfInstall(posix, "darwin")).toBe("/Users/alex/tools/npm-global");
    expect(npmUpdatePrefix(posix, "/Users/alex/tools/npm-global/", "darwin")).toBeUndefined();
    expect(npmUpdatePrefix(posix, "/opt/homebrew", "darwin")).toBe("/Users/alex/tools/npm-global");
    expect(npmUpdatePrefix(posix, null, "darwin")).toBeUndefined();

    const windows = {
      commandPath: "D:\\tools\\npm\\tokenmaxxing.CMD",
      resolvedCommandPath: "D:\\tools\\npm\\tokenmaxxing.cmd",
    };
    expect(npmPrefixOfInstall(windows, "win32")).toBe("D:\\tools\\npm");
    expect(npmUpdatePrefix(windows, "d:/tools/npm", "win32")).toBeUndefined();
    expect(npmUpdatePrefix(windows, "C:\\Users\\alex\\AppData\\Roaming\\npm", "win32")).toBe(
      "D:\\tools\\npm",
    );

    expect(autoUpdateCommandDescription("npm", "0.7.0", { npmPrefix: "D:\\my tools\\npm" })).toBe(
      'npm install -g --prefix "D:\\my tools\\npm" @851-labs/tokenmaxxing@0.7.0 --prefer-online --loglevel=error',
    );
    // Only npm takes a prefix.
    expect(autoUpdateCommandDescription("bun", "0.7.0", { npmPrefix: "/x" })).toBe(
      "bun add -g @851-labs/tokenmaxxing@0.7.0 --no-cache --silent",
    );
  });

  it("keeps the package manager's error output, trimmed and without colors", () => {
    const output = packageManagerFailureOutput({
      stderr: `${Array.from({ length: 30 }, (_, index) => `npm error line ${index}`).join("\n")}\n\u001b[31mnpm error code ETARGET\u001b[0m\n`,
      stdout: "added 1 package",
    });

    expect(output.split("\n")).toHaveLength(20);
    expect(output.endsWith("npm error code ETARGET")).toBe(true);
    expect(packageManagerFailureOutput({ stderr: "", stdout: "yarn error x\n" })).toBe(
      "yarn error x",
    );
    expect(packageManagerFailureOutput(new Error("spawn npm ENOENT"))).toBe("");
  });

  it("names the failed command and its output in PackageManagerUpdateError", () => {
    expect(
      new PackageManagerUpdateError({
        cause: undefined,
        command: "npm install -g x@1",
        output: "npm error code ETARGET",
        timedOut: false,
      }).message,
    ).toBe("npm install -g x@1 failed:\nnpm error code ETARGET");
    expect(
      new PackageManagerUpdateError({
        cause: undefined,
        command: "npm install -g x@1",
        output: "",
        timedOut: true,
      }).message,
    ).toBe("npm install -g x@1 did not finish within 4 minutes");
  });

  it("renders Windows wrappers without package-manager updates", () => {
    const wrapper = renderServiceWrapper({
      env: capturedServiceEnv({
        CLAUDE_CONFIG_DIR: "D:\\Claude Logs, extra",
        CODEX_HOME: "C:\\Users\\alex\\Codex Logs",
        PATH: "C:\\Windows\\System32",
      }),
      logPath: "/tmp/tokenmaxxing.log",
      platform: "win32",
      runnerPointerPath: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing\\service-runner-current",
    });

    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).toContain("set /p TOKENMAXXING_SERVICE_RUNNER=<");
    expect(wrapper).toContain("service run --scheduled");
    expect(wrapper).toContain('set "CLAUDE_CONFIG_DIR=D:\\Claude Logs, extra"\r\n');
    expect(wrapper).toContain('set "CODEX_HOME=C:\\Users\\alex\\Codex Logs"\r\n');
  });

  it("addresses its own files through %~dp0 so no profile path is embedded", () => {
    const configDir = "C:\\Users\\Zoë O'Neil (Work)\\Tm & Co\\tokenmaxxing";
    const wrapper = renderServiceWrapper({
      env: { PATH: "C:\\Program Files (x86)\\Tools;C:\\100%\\bin" },
      logPath: `${configDir}\\service.log`,
      platform: "win32",
      runnerPointerPath: `${configDir}\\service-runner-current`,
    });
    const lines = wrapper.split("\r\n");

    expect(wrapper.endsWith("\r\n")).toBe(true);
    expect(wrapper.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(wrapper).not.toContain(configDir);
    expect(wrapper).not.toContain("Zo");
    expect(lines[1]).toBe('"%SystemRoot%\\System32\\chcp.com" 65001 >nul');
    expect(lines).toContain('set "TOKENMAXXING_SERVICE_DIR=%~dp0"');
    expect(lines).toContain('set "TOKENMAXXING_LOG=%~dp0service.log"');
    expect(lines).toContain(
      'set /p TOKENMAXXING_SERVICE_RUNNER=<"%TOKENMAXXING_SERVICE_DIR%service-runner-current"',
    );
    // A literal percent sign must not start a variable expansion.
    expect(lines).toContain('set "PATH=C:\\Program Files (x86)\\Tools;C:\\100%%\\bin"');
    // The runner path may contain & ( ): expand it only inside quotes, never inside a block.
    expect(lines).toContain("if not defined TOKENMAXXING_SERVICE_RUNNER goto runner_pointer_empty");
    expect(lines).toContain('if not exist "%TOKENMAXXING_SERVICE_RUNNER%" goto runner_missing');
    expect(lines).toContain('"%TOKENMAXXING_SERVICE_RUNNER%" service run --scheduled');
    expect(lines).toContain(
      'echo tokenmaxxing service runner missing: "%TOKENMAXXING_SERVICE_RUNNER%"',
    );
    for (const line of lines) {
      expect(line.replaceAll(/"[^"]*"/g, '""')).not.toMatch(
        /%TOKENMAXXING_(SERVICE_RUNNER|LOG|SERVICE_DIR)%/,
      );
    }
    // No parenthesized blocks at all: every path expansion is a line of its own.
    expect(lines.filter((line) => line.endsWith("(") || line.trim() === ")")).toEqual([]);
  });

  describe("when another run holds service.log", () => {
    const wrapper = renderServiceWrapper({
      env: { PATH: "C:\\Windows\\System32" },
      logPath: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing\\service.log",
      platform: "win32",
      runnerPointerPath: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing\\service-runner-current",
    });
    const lines = wrapper.split("\r\n");
    const label = (name: string) => lines.indexOf(`:${name}`);

    // cmd skips a command whose >> target is held without changing ERRORLEVEL,
    // so the overlapping run exited 0 without a trace (Windows battle test 5f).
    it("tells a run that never started from one that failed", () => {
      const redirect = lines.indexOf('(call :sync >> "%TOKENMAXXING_LOG%" 2>&1) 2>nul');

      expect(redirect).toBeGreaterThan(label("open_log"));
      expect(lines[redirect - 1]).toBe('set "TOKENMAXXING_LOG_OPENED="');
      expect(lines[redirect + 1]).toBe("if defined TOKENMAXXING_LOG_OPENED exit /b %ERRORLEVEL%");
      // The marker is :sync's first step, before anything that can fail.
      expect(lines[label("sync") + 1]).toBe('set "TOKENMAXXING_LOG_OPENED=1"');
    });

    it("falls back to side logs, then to the console", () => {
      const fallback = lines.slice(
        lines.indexOf("if defined TOKENMAXXING_LOG_OPENED exit /b %ERRORLEVEL%") + 1,
        label("no_log"),
      );

      expect(fallback).toEqual([
        "set /a TOKENMAXXING_LOG_SLOT+=1",
        "if %TOKENMAXXING_LOG_SLOT% GTR 4 goto no_log",
        'set "TOKENMAXXING_LOG=%TOKENMAXXING_SERVICE_DIR%service-overlap-%TOKENMAXXING_LOG_SLOT%.log"',
        "goto open_log",
      ]);
      expect(lines.slice(label("no_log"), label("sync"))).toEqual([
        ":no_log",
        "call :sync",
        "exit /b %ERRORLEVEL%",
      ]);
      expect(lines).toContain(
        "if not %TOKENMAXXING_LOG_SLOT%==0 echo service.log is in use by another run",
      );
    });

    it("rotates whichever log it opens, and a held log not at all", () => {
      expect(lines[label("open_log") + 1]).toBe("call :rotate_log");
      expect(lines.slice(label("rotate_log"))).toEqual([
        ":rotate_log",
        'if not exist "%TOKENMAXXING_LOG%" exit /b 0',
        'for %%A in ("%TOKENMAXXING_LOG%") do if %%~zA LSS 5242880 exit /b 0',
        // Moving the log aside first fails while it is held, before any
        // rotation has shifted.
        'move /y "%TOKENMAXXING_LOG%" "%TOKENMAXXING_LOG%.0" >nul 2>nul || exit /b 0',
        'if exist "%TOKENMAXXING_LOG%.3" del /f /q "%TOKENMAXXING_LOG%.3" >nul 2>nul',
        'if exist "%TOKENMAXXING_LOG%.2" move /y "%TOKENMAXXING_LOG%.2" "%TOKENMAXXING_LOG%.3" >nul 2>nul',
        'if exist "%TOKENMAXXING_LOG%.1" move /y "%TOKENMAXXING_LOG%.1" "%TOKENMAXXING_LOG%.2" >nul 2>nul',
        'move /y "%TOKENMAXXING_LOG%.0" "%TOKENMAXXING_LOG%.1" >nul 2>nul',
        "exit /b 0",
        "",
      ]);
    });

    it("never falls through into a subroutine", () => {
      for (const name of [
        "no_log",
        "sync",
        "runner_pointer_empty",
        "runner_missing",
        "rotate_log",
      ]) {
        expect(lines[label(name) - 1]).toMatch(/^(exit \/b|goto) /);
      }
    });
  });
});

function registeredTask(xml: string | null) {
  return xml === null ? { _tag: "missing" as const } : { _tag: "xml" as const, xml };
}

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

    const linuxPath = (configDir: string) =>
      renderSystemdService(
        servicePaths({
          env: { TOKENMAXXING_CONFIG_DIR: configDir },
          home: "/home/alex",
          platform: "linux",
        })!,
      );
    // The Linux service e2e caught both: systemd expands %-specifiers inside
    // quotes, and refuses an executable path with a quote or backslash at all.
    expect(linuxPath("/home/alex/Zoë (Work) & Co 100%/tm")).toContain(
      'ExecStart="/home/alex/Zoë (Work) & Co 100%%/tm/tokenmaxxing.sh"\n',
    );
    // A wedged run must not keep the oneshot unit activating forever.
    expect(linuxPath("/home/alex/.config/tokenmaxxing")).toContain("TimeoutStartSec=30min\n");
    expect(linuxPath(`/home/alex/Zoë O'Neil "x"\\y/tm`)).toContain(
      `ExecStart=/bin/sh "/home/alex/Zoë O'Neil \\"x\\"\\\\y/tm/tokenmaxxing.sh"\n`,
    );

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
      "/XML",
      "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing/service-task.xml",
      "/F",
    ]);
    expect(
      renderWindowsTaskXml(
        windowsPaths!,
        { SystemRoot: "C:\\Windows" },
        new Date(2026, 8, 5, 7, 3, 44),
      ),
    ).toContain(
      "<TimeTrigger>\r\n      <StartBoundary>2026-09-05T07:03:00</StartBoundary>\r\n      <Repetition>\r\n        <Interval>PT5M</Interval>",
    );
  });
});

describe("unchanged service refresh", () => {
  const metadata: ServiceMetadata = {
    autoUpdateManager: "registry",
    backend: "launchd",
    commandPath: "/Users/alex/.config/tokenmaxxing/service-runners/0.7.0/tokenmaxxing",
    installedAt: "2026-09-28T09:00:00.000Z",
    schedule: "syncs every 5 minutes",
    templateVersion: 8,
    version: 1,
  };
  const wrapper = "#!/bin/sh\nexport PATH='/usr/bin:/bin'\n";

  async function fileIdentity(path: string) {
    const info = await stat(path);
    return { ino: info.ino, mode: info.mode & 0o777, mtimeMs: info.mtimeMs };
  }

  it("leaves an identical plist and wrapper untouched and reports what changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-refresh-launchd-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config") },
        home: dir,
        platform: "darwin",
      })!;

      expect(await Effect.runPromise(writeServiceFiles(paths, wrapper, metadata))).toEqual({
        definition: true,
        wrapper: true,
      });
      const plist = await fileIdentity(paths.definitionPath!);
      const script = await fileIdentity(paths.wrapperPath);
      expect(script.mode).toBe(0o755);

      expect(await Effect.runPromise(writeServiceFiles(paths, wrapper, metadata))).toEqual({
        definition: false,
        wrapper: false,
      });
      expect(await fileIdentity(paths.definitionPath!)).toEqual(plist);
      expect(await fileIdentity(paths.wrapperPath)).toEqual(script);

      // A lost executable bit is restored in place, without replacing the file.
      await chmod(paths.wrapperPath, 0o644);
      expect(await Effect.runPromise(writeServiceFiles(paths, wrapper, metadata))).toEqual({
        definition: false,
        wrapper: false,
      });
      expect(await fileIdentity(paths.wrapperPath)).toEqual(script);

      const changed = `${wrapper}# changed\n`;
      expect(await Effect.runPromise(writeServiceFiles(paths, changed, metadata))).toEqual({
        definition: false,
        wrapper: true,
      });
      expect(await readFile(paths.wrapperPath, "utf8")).toBe(changed);
      expect((await fileIdentity(paths.wrapperPath)).mode).toBe(0o755);
      expect(await fileIdentity(paths.definitionPath!)).toEqual(plist);

      await writeFile(paths.definitionPath!, "<plist/>\n");
      expect(await Effect.runPromise(writeServiceFiles(paths, changed, metadata))).toEqual({
        definition: true,
        wrapper: false,
      });
      expect(await readFile(paths.definitionPath!, "utf8")).toBe(renderLaunchdPlist(paths));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("tells a definition that runs this config dir's wrapper from another config dir's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-owner-"));

    try {
      for (const platform of ["darwin", "linux"] as const) {
        const env = { XDG_CONFIG_HOME: join(dir, "xdg") };
        const profile = (name: string) =>
          servicePaths({
            env: { ...env, TOKENMAXXING_CONFIG_DIR: join(dir, name) },
            home: join(dir, platform),
            platform,
          })!;
        // A config dir that needs escaping in both the plist and the unit.
        const real = profile(`Zoë O'Neil & Co 100%`);
        const scratch = profile("scratch");
        // A name that starts with the real one must not pass as it.
        const lookalike = profile(`Zoë O'Neil & Co 100%-2`);
        const owner = (paths: ServicePaths) => Effect.runPromise(serviceDefinitionOwner(paths));

        expect(await owner(real)).toBe("none");
        await Effect.runPromise(writeServiceFiles(real, wrapper, metadata));
        expect(await owner(real)).toBe("this");
        // Same HOME, so the same definition file, but it runs the other wrapper.
        expect(scratch.definitionPath).toBe(real.definitionPath);
        expect(await owner(scratch)).toBe("other");
        expect(await owner(lookalike)).toBe("other");
        expect(await Effect.runPromise(serviceDefinitionUsesConfigDir(scratch))).toBe(false);
        expect(await Effect.runPromise(serviceDefinitionUsesConfigDir(real))).toBe(true);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("tells whose config dir the registered Windows task runs", async () => {
    const windows = (configDir: string) =>
      servicePaths({
        env: { SystemRoot: "C:\\Windows", TOKENMAXXING_CONFIG_DIR: configDir },
        home: "C:\\Users\\alex",
        platform: "win32",
      })!;
    const mine = windows("C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing");
    const other = windows("D:\\custom\\tm");
    const registered = renderWindowsTaskXml(mine, { SystemRoot: "C:\\Windows" });
    const owner = (paths: ServicePaths, xml: string | null) =>
      Effect.runPromise(serviceDefinitionOwner(paths, () => Effect.succeed(registeredTask(xml))));

    expect(await owner(mine, null)).toBe("none");
    expect(await owner(mine, registered)).toBe("this");
    // Task Scheduler may hand the paths back in another case.
    expect(await owner(mine, registered.toUpperCase())).toBe("this");
    expect(await owner(other, registered)).toBe("other");
    // A template 5 task ran the .cmd wrapper directly, with no working directory.
    expect(
      await owner(
        mine,
        "<Task><Actions><Exec><Command>C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing\\service-sync.cmd</Command></Exec></Actions></Task>",
      ),
    ).toBe("this");
  });

  it("re-registers the Windows task only when the registered one differs or is disabled", () => {
    const paths = servicePaths({
      env: { SystemRoot: "C:\\Windows", TOKENMAXXING_CONFIG_DIR: "C:\\tm" },
      home: "C:\\Users\\alex",
      platform: "win32",
    })!;
    const env = { SystemRoot: "C:\\Windows" };
    // What Task Scheduler hands back: its own formatting, an Enabled element,
    // quotes unescaped, and a different start boundary.
    const registered = renderWindowsTaskXml(paths, env, new Date("2026-01-01T00:00:00"))
      .replaceAll("&quot;", '"')
      .replace("<Settings>\r\n", "<Settings>\r\n    <Enabled>true</Enabled>\r\n")
      .replaceAll("\r\n", "\n");

    expect(windowsTaskMatches(registered, paths, env)).toBe(true);
    expect(
      windowsTaskMatches(
        registered.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"),
        paths,
        env,
      ),
    ).toBe(false);
    expect(windowsTaskMatches(registered.replace("PT5M", "PT10M"), paths, env)).toBe(false);
    expect(windowsTaskMatches(registered.replace("C:\\tm", "D:\\other"), paths, env)).toBe(false);
    expect(windowsTaskMatches("", paths, env)).toBe(false);
    // Windows paths ignore case: a config dir spelled differently is the same task.
    expect(windowsTaskMatches(registered.replaceAll("C:\\tm", "c:\\TM"), paths, env)).toBe(true);
  });

  it("keeps the installed Windows spelling of the config dir and env", () => {
    const shell = (configDir: string) =>
      servicePaths({
        env: { SystemRoot: "C:\\Windows", TOKENMAXXING_CONFIG_DIR: configDir },
        home: "C:\\Users\\zoe",
        platform: "win32",
      })!;
    const installedDir = "C:\\Users\\Zoe\u0308\\tm";
    const installed = shell(installedDir);
    const captured = {
      CODEX_HOME: "D:\\new-codex",
      PATH: "c:\\windows\\system32;C:\\Program Files\\nodejs",
      TOKENMAXXING_CONFIG_DIR: "c:\\users\\ZOË\\TM",
    };
    const spelling = {
      configDir: installedDir,
      env: {
        CODEX_HOME: "D:\\old-codex",
        PATH: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
        TOKENMAXXING_CONFIG_DIR: installedDir,
      },
    };

    const kept = withInstalledWindowsSpelling(shell("c:\\users\\ZOË\\TM"), captured, spelling);
    expect(kept.paths).toEqual(installed);
    expect(kept.env).toEqual({
      // A real change still reaches the wrapper.
      CODEX_HOME: "D:\\new-codex",
      PATH: spelling.env.PATH,
      TOKENMAXXING_CONFIG_DIR: installedDir,
    });
    // Another dir, or nothing installed: the shell's own spelling.
    const other = shell("D:\\tm");
    expect(withInstalledWindowsSpelling(other, captured, spelling).paths).toBe(other);
    expect(withInstalledWindowsSpelling(other, captured, null)).toEqual({
      env: captured,
      paths: other,
    });
  });

  it("decodes task XML in UTF-16 or UTF-8, and nothing it cannot be sure of", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-16"?><Task><WorkingDirectory>C:\\Users\\Zoë</WorkingDirectory></Task>';
    expect(decodeWindowsCommandOutput(encodeWindowsTaskXml(xml))).toBe(xml);
    expect(decodeWindowsCommandOutput(Buffer.from(xml, "utf16le"))).toBe(xml);
    expect(decodeWindowsCommandOutput(Buffer.from(xml, "utf8"))).toBe(xml);
    // What schtasks /Query /XML wrote to a pipe on the win11 VM: code page 437, "ë" as 0x89.
    expect(
      decodeWindowsCommandOutput(
        Buffer.from([...Buffer.from("<W>C:\\Users\\Zo"), 0x89, ...Buffer.from("</W>")]),
      ),
    ).toBeNull();
  });

  // #116's Service e2e: the deferred template migration of a service under
  // D:\\a\\_temp\\tmx-e2e\\Zoë\\tm refused itself as "another config dir's".
  it("owns a task whose config dir has non-ASCII characters, in any Unicode form or case", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-task-file-"));
    try {
      const configDir = "D:\\a\\_temp\\tmx-e2e\\Zo\u00EB\\tm";
      const paths = servicePaths({
        env: { SystemRoot: "C:\\Windows", TOKENMAXXING_CONFIG_DIR: configDir },
        home: "C:\\Users\\Zo\u00EB",
        platform: "win32",
      })!;
      const registered = renderWindowsTaskXml(paths, { SystemRoot: "C:\\Windows" });
      const owner = (
        task: ReturnType<typeof registeredTask> | { _tag: "unreadable" },
        of = paths,
      ) => Effect.runPromise(serviceDefinitionOwner(of, () => Effect.succeed(task)));

      expect(await owner(registeredTask(registered))).toBe("this");
      // Decomposed "ë" (e + U+0308), as a path typed on macOS arrives, and another case.
      expect(await owner(registeredTask(registered.normalize("NFD").toUpperCase()))).toBe("this");
      // A definition that exists but cannot be read never blocks a repair.
      expect(await owner({ _tag: "unreadable" })).toBe("unknown");
      const other = servicePaths({
        env: {
          SystemRoot: "C:\\Windows",
          TOKENMAXXING_CONFIG_DIR: "D:\\a\\_temp\\tmx-e2e\\Zoe\\tm",
        },
        home: "C:\\Users\\Zoe",
        platform: "win32",
      })!;
      expect(await owner(registeredTask(registered), other)).toBe("other");

      // The task file itself: UTF-16 with a BOM, which keeps "ë" intact.
      const tasks = join(dir, "System32", "Tasks");
      await mkdir(tasks, { recursive: true });
      await writeFile(join(tasks, "tokenmaxxing-sync"), encodeWindowsTaskXml(registered));
      const read = await Effect.runPromise(readRegisteredWindowsTaskXml({ SystemRoot: dir }));
      expect(read).toEqual({ _tag: "xml", xml: registered });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports a systemd change when either unit differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-refresh-systemd-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: join(dir, "config"), XDG_CONFIG_HOME: join(dir, "xdg") },
        home: dir,
        platform: "linux",
      })!;
      const timerPath = paths.definitionPath!.replace(/\.service$/, ".timer");

      await Effect.runPromise(writeServiceFiles(paths, wrapper, metadata));
      const unit = await fileIdentity(paths.definitionPath!);
      expect(await Effect.runPromise(writeServiceFiles(paths, wrapper, metadata))).toEqual({
        definition: false,
        wrapper: false,
      });
      expect(await fileIdentity(paths.definitionPath!)).toEqual(unit);

      await writeFile(timerPath, "[Timer]\n");
      expect(await Effect.runPromise(writeServiceFiles(paths, wrapper, metadata))).toEqual({
        definition: true,
        wrapper: false,
      });
      expect(await readFile(timerPath, "utf8")).toBe(renderSystemdTimer());
      expect(await fileIdentity(paths.definitionPath!)).toEqual(unit);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  const launchdPaths = servicePaths({
    env: { TOKENMAXXING_CONFIG_DIR: "/Users/alex/.config/tokenmaxxing" },
    home: "/Users/alex",
    platform: "darwin",
  })!;
  // Trimmed `launchctl print gui/501/sh.tokenmaxxing.sync` output from macOS 27.
  const launchctlPrint = (overrides: { interval?: number; program?: string } = {}) =>
    [
      "gui/501/sh.tokenmaxxing.sync = {",
      "\tactive count = 0",
      "\tpath = /Users/alex/Library/LaunchAgents/sh.tokenmaxxing.sync.plist",
      "\ttype = LaunchAgent",
      "\tstate = not running",
      "",
      `\tprogram = ${overrides.program ?? "/Users/alex/.config/tokenmaxxing/tokenmaxxing.sh"}`,
      "\targuments = {",
      "\t\t/Users/alex/.config/tokenmaxxing/tokenmaxxing.sh",
      "\t}",
      "",
      "\tstdout path = /Users/alex/.config/tokenmaxxing/service.log",
      "\tstderr path = /Users/alex/.config/tokenmaxxing/service.log",
      "\tdefault environment = {",
      "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin",
      "\t}",
      "",
      "\truns = 122",
      "\tlast exit code = 0",
      `\trun interval = ${overrides.interval ?? 300} seconds`,
      "\tproperties = inferred program",
      "}",
      "",
    ].join("\n");

  function recordingScheduler(output: string | null) {
    const commands: string[] = [];
    const runtime = {
      readOutput: (command: string, args: readonly string[]) =>
        Effect.sync(() => {
          commands.push(`read ${command} ${args[0] === "--user" ? args[1] : args[0]}`);
          return output;
        }),
      run: (command: string, args: readonly string[]) =>
        Effect.sync(() => {
          commands.push(`${command} ${args.filter((arg) => !arg.startsWith("/")).join(" ")}`);
        }),
    };
    return { commands, runtime };
  }

  // W1 (F3): every refresh and repair re-registered the task, moving its
  // start boundary and rewriting the task file.
  it("leaves a matching, enabled Windows task registered as it is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-wintask-"));
    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: dir,
        platform: "win32",
      })!;
      const withTask = (xml: string | null) => {
        const commands: string[] = [];
        const runtime = {
          readTaskXml: () => Effect.succeed(registeredTask(xml)),
          run: (command: string, args: readonly string[]) =>
            Effect.sync(() => {
              commands.push(`${command} ${args[0]} ${args[2]}`);
            }),
        };
        return { commands, runtime };
      };

      const unchanged = { definition: false, wrapper: false };
      const current = withTask(renderWindowsTaskXml(paths, process.env, new Date(2020, 0, 1)));
      await Effect.runPromise(installNativeScheduler(paths, unchanged, current.runtime));
      // Only the pre-0.5 per-time tasks are cleaned up; the task itself is kept.
      expect(current.commands).toEqual([
        "schtasks /Delete tokenmaxxing-sync-0900",
        "schtasks /Delete tokenmaxxing-sync-1300",
        "schtasks /Delete tokenmaxxing-sync-1700",
        "schtasks /Delete tokenmaxxing-sync-2100",
      ]);

      const missing = withTask(null);
      await Effect.runPromise(installNativeScheduler(paths, unchanged, missing.runtime));
      expect(missing.commands.at(-1)).toBe("schtasks /Create tokenmaxxing-sync");

      const disabled = withTask(
        renderWindowsTaskXml(paths).replace("<Settings>", "<Settings><Enabled>false</Enabled>"),
      );
      await Effect.runPromise(installNativeScheduler(paths, unchanged, disabled.runtime));
      expect(disabled.commands.at(-1)).toBe("schtasks /Create tokenmaxxing-sync");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("explains an Access is denied from a task an administrator registered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-wintask-denied-"));
    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: dir,
        platform: "win32",
      })!;
      const exit = await Effect.runPromiseExit(
        installNativeScheduler(
          paths,
          { definition: false, wrapper: false },
          {
            readTaskXml: () => Effect.succeed(registeredTask(null)),
            run: (_command: string, args: readonly string[]) =>
              args[0] === "/Create"
                ? Effect.fail(
                    Object.assign(new Error("Command failed: schtasks /Create"), {
                      stderr: "ERROR: Access is denied.\r\n",
                    }),
                  )
                : Effect.void,
          },
        ),
      );

      expect(failureTag(exit)).toBe("WindowsTaskAccessDeniedError");
      expect(
        new ServiceInstallError({
          cause: new WindowsTaskAccessDeniedError({ cause: undefined }),
        }).message,
      ).toContain(
        "cause: the tokenmaxxing-sync task was registered from an administrator terminal",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("matches the loaded launchd job against every setting the plist renders", () => {
    expect(launchdJobMatches(launchctlPrint(), launchdPaths)).toBe(true);
    expect(launchdJobMatches(launchctlPrint({ interval: 3600 }), launchdPaths)).toBe(false);
    expect(
      launchdJobMatches(
        launchctlPrint({ program: "/Users/alex/.config/tokenmaxxing/service-sync.sh" }),
        launchdPaths,
      ),
    ).toBe(false);
    expect(launchdJobMatches("", launchdPaths)).toBe(false);
  });

  it("does not reload launchd when the plist is unchanged and the loaded job matches it", async () => {
    const unchanged = { definition: false, wrapper: true };
    const current = recordingScheduler(launchctlPrint());
    await Effect.runPromise(installNativeScheduler(launchdPaths, unchanged, current.runtime));
    expect(current.commands).toEqual(["read launchctl print"]);

    // Not loaded (bootout by hand, a failed bootstrap): the scheduler is broken, so reload.
    const unloaded = recordingScheduler(null);
    await Effect.runPromise(installNativeScheduler(launchdPaths, unchanged, unloaded.runtime));
    expect(unloaded.commands).toEqual(
      [
        "read launchctl print",
        "launchctl bootout gui/501",
        "launchctl bootstrap gui/501",
        "launchctl enable gui/501/sh.tokenmaxxing.sync",
      ].map((command) => command.replaceAll("501", String(process.getuid?.() ?? 501))),
    );

    // Loaded from older settings (a deferred repair rewrote the plist without reloading).
    const stale = recordingScheduler(launchctlPrint({ interval: 3600 }));
    await Effect.runPromise(installNativeScheduler(launchdPaths, unchanged, stale.runtime));
    expect(stale.commands).toHaveLength(4);

    const changed = recordingScheduler(launchctlPrint());
    await Effect.runPromise(
      installNativeScheduler(launchdPaths, { definition: true, wrapper: false }, changed.runtime),
    );
    expect(changed.commands).toHaveLength(3);
    expect(changed.commands[0]).toMatch(/^launchctl bootout/);
  });

  const systemdPaths = servicePaths({
    env: { TOKENMAXXING_CONFIG_DIR: "/home/alex/.config/tokenmaxxing" },
    home: "/home/alex",
    platform: "linux",
  })!;
  const systemctlShow = (timer: { active?: string; needReload?: string; state?: string } = {}) =>
    [
      "Id=tokenmaxxing-sync.service",
      "NeedDaemonReload=no",
      "ActiveState=inactive",
      "UnitFileState=static",
      "",
      "Id=tokenmaxxing-sync.timer",
      `NeedDaemonReload=${timer.needReload ?? "no"}`,
      `ActiveState=${timer.active ?? "active"}`,
      `UnitFileState=${timer.state ?? "enabled"}`,
      "",
    ].join("\n");

  it("reads systemd's view of both units", () => {
    expect(systemdUnitsAreCurrent(systemctlShow())).toBe(true);
    expect(systemdUnitsAreCurrent(systemctlShow({ needReload: "yes" }))).toBe(false);
    expect(systemdUnitsAreCurrent(systemctlShow({ active: "inactive" }))).toBe(false);
    expect(systemdUnitsAreCurrent(systemctlShow({ state: "disabled" }))).toBe(false);
    expect(
      systemdUnitsAreCurrent(
        systemctlShow().replace("NeedDaemonReload=no", "NeedDaemonReload=yes"),
      ),
    ).toBe(false);
  });

  it("skips daemon-reload and the timer when the units are unchanged and current", async () => {
    const unchanged = { definition: false, wrapper: true };
    const current = recordingScheduler(systemctlShow());
    await Effect.runPromise(installNativeScheduler(systemdPaths, unchanged, current.runtime));
    expect(current.commands).toEqual(["read systemctl show"]);

    const inactive = recordingScheduler(systemctlShow({ active: "inactive" }));
    await Effect.runPromise(installNativeScheduler(systemdPaths, unchanged, inactive.runtime));
    expect(inactive.commands).toEqual([
      "read systemctl show",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now tokenmaxxing-sync.timer",
    ]);

    const changed = recordingScheduler(systemctlShow());
    await Effect.runPromise(
      installNativeScheduler(systemdPaths, { definition: true, wrapper: false }, changed.runtime),
    );
    expect(changed.commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now tokenmaxxing-sync.timer",
    ]);
  });
});

describe("Windows hidden launcher", () => {
  const windowsPaths = (configDir: string) =>
    servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: configDir },
      home: "C:\\Users\\alex",
      platform: "win32",
    })!;

  it("imports a task that starts the launcher through wscript", () => {
    const paths = windowsPaths(
      "C:\\Users\\Zoë O'Neil (Work)\\AppData\\Roaming\\token maxxing & <co>",
    );
    const xml = renderWindowsTaskXml(paths, { SystemRoot: "D:\\WINDOWS\\" });
    const exec = {
      arguments: xmlElementText(xml, "Arguments"),
      command: xmlElementText(xml, "Command"),
      workingDirectory: xmlElementText(xml, "WorkingDirectory"),
    };

    // Task Scheduler splits Command/Arguments like any Windows command line and wscript parses
    // its own arguments the same way, so the launcher path must survive as one argument. The
    // apostrophe stays an apostrophe (schtasks /TR would have turned it into a quote).
    expect(splitWindowsCommandLine(exec.command)).toEqual(["D:\\WINDOWS\\System32\\wscript.exe"]);
    expect(splitWindowsCommandLine(exec.arguments)).toEqual([
      "//B",
      "//NoLogo",
      "//E:VBScript",
      windowsLauncherPath(paths),
    ]);
    expect(exec.workingDirectory).toBe(paths.configDir);
    expect(windowsLauncherPath(paths)).toBe(join(paths.configDir, "service-sync.vbs"));
    expect(xml).not.toContain("service-sync.cmd");
    expect(xml).toContain("&amp; &lt;co&gt;");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).not.toContain("<UserId>");
    expect(xml).not.toContain("<RunLevel>HighestAvailable</RunLevel>");
  });

  it("encodes the task XML as UTF-16 LE with a byte-order mark", () => {
    const xml = renderWindowsTaskXml(windowsPaths("C:\\Users\\Zoë\\tm"), {});
    const bytes = Buffer.from(encodeWindowsTaskXml(xml));

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(xml);
    expect(bytes.subarray(2).toString("utf16le")).toContain("Zoë");
  });

  it("uses the native System32 script host", () => {
    expect(windowsScriptHostPath({ SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\wscript.exe",
    );
    expect(windowsScriptHostPath({ SYSTEMROOT: "E:\\Win" })).toBe("E:\\Win\\System32\\wscript.exe");
    expect(windowsScriptHostPath({})).toBe("C:\\Windows\\System32\\wscript.exe");
    expect(windowsScriptHostPath({ SystemRoot: "C:\\Windows" })).not.toMatch(/SysWOW64|Sysnative/i);
  });

  it("only tracks a launcher for the Windows backend", () => {
    const darwinPaths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    })!;

    expect(windowsLauncherPath(darwinPaths)).toBeNull();
  });

  it("renders a pure-ASCII VBScript that hides the wrapper and propagates its exit code", () => {
    const launcher = renderWindowsLauncher();
    const lines = launcher.split("\r\n");

    expect(launcher.endsWith("\r\n")).toBe(true);
    expect(launcher.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(launcher).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(lines).toContain("Option Explicit");
    expect(lines).toContain(
      'cmd = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\cmd.exe"""',
    );
    // The wrapper runs by relative name from the launcher's folder, so no profile path is embedded
    // or re-parsed by cmd.exe; /d skips AutoRun commands that could change directory.
    expect(lines).toContain('command = cmd & " /d /c .\\service-sync.cmd"');
    expect(basename(windowsPaths("C:\\tokenmaxxing").wrapperPath)).toBe("service-sync.cmd");
    expect(lines).toContain(
      'shell.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\"))',
    );
    // Style 0 hides the console; waiting returns the wrapper exit code for WScript.Quit.
    expect(lines).toContain("If Err.Number = 0 Then exitCode = shell.Run(command, 0, True)");
    expect(lines).toContain("If Err.Number <> 0 Then exitCode = 127");
    expect(lines.at(-2)).toBe("WScript.Quit exitCode");
    expect(launcher).not.toMatch(/[A-Z]:\\/);
    expect(launcher).not.toMatch(/powershell|timeout/i);
  });

  it("builds the deferred repair command line in the launcher's repair mode", () => {
    const repairLine = renderWindowsLauncher()
      .split("\r\n")
      .find((line) => line.trim().startsWith('command = cmd & " /d /s /c'))!;
    const commandPath = "C:\\Users\\Zoë O'Neil (Work)\\Tm & Co\\tokenmaxxing.exe";
    const commandLine = evaluateVbsConcatenation(repairLine.trim().slice("command = ".length), {
      cmd: '"C:\\Windows\\System32\\cmd.exe"',
      'shell.Environment("PROCESS")("TOKENMAXXING_SERVICE_REPAIR_COMMAND")': commandPath,
      "WScript.Arguments(1)": "reload-required",
    });

    expect(commandLine).toBe(
      `"C:\\Windows\\System32\\cmd.exe" /d /s /c ""${commandPath}" service repair --deferred --json --reason reload-required"`,
    );
    // cmd /s strips exactly the outer pair of quotes, leaving the command path quoted.
    const afterC = commandLine.slice(commandLine.indexOf(" /c ") + 4);
    expect(afterC.slice(1, -1)).toBe(
      `"${commandPath}" service repair --deferred --json --reason reload-required`,
    );
  });

  it("passes schtasks and wscript arguments through Windows argv quoting intact", () => {
    const configDir = "C:\\Users\\Zoë O'Neil (Work)\\token maxxing & co";
    const args = windowsTaskCreateArgs(windowsPaths(configDir));
    const repair = deferredServiceRepairInvocation(
      "C:\\x\\tokenmaxxing.exe",
      "reload-required",
      "win32",
      {
        SystemRoot: "C:\\Windows",
        TOKENMAXXING_CONFIG_DIR: configDir,
      },
    );
    // execFile/spawn quote each argument the way libuv does before CreateProcessW; schtasks and
    // wscript parse their command lines back with CommandLineToArgvW rules.
    const roundTrip = (argv: string[]) =>
      splitWindowsCommandLine(argv.map(quoteWindowsArg).join(" "));

    expect(roundTrip(["schtasks", ...args])).toEqual(["schtasks", ...args]);
    expect(roundTrip([repair.command, ...repair.args])).toEqual([repair.command, ...repair.args]);
  });

  it("writes the launcher on install and repair and removes it on uninstall", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-windows-launcher-"));

    try {
      const paths = windowsPaths(join(dir, "Zoë (Work)"));
      const launcherPath = windowsLauncherPath(paths)!;
      const metadata: ServiceMetadata = {
        autoUpdateManager: "registry",
        backend: "windows-task-scheduler",
        commandPath: join(paths.runnersDir, "tokenmaxxing.exe"),
        installedAt: "2026-06-16T09:00:00.000Z",
        schedule: "syncs every 5 minutes",
        templateVersion: 8,
        version: 1,
      };

      expect(await Effect.runPromise(readWindowsLauncherStatus(launcherPath))).toBe("missing");

      await Effect.runPromise(writeServiceFiles(paths, "@echo off\r\n", metadata));
      expect(await readFile(launcherPath, "utf8")).toBe(renderWindowsLauncher());
      expect(await readFile(paths.wrapperPath, "utf8")).toBe("@echo off\r\n");
      expect(await Effect.runPromise(readWindowsLauncherStatus(launcherPath))).toBe("current");

      // A current launcher is left in place, so a running wscript.exe never sees it replaced.
      const installedLauncher = await stat(launcherPath);
      await Effect.runPromise(writeServiceFiles(paths, "@echo off\r\n", metadata));
      expect((await stat(launcherPath)).ino).toBe(installedLauncher.ino);

      // Repair rewrites an outdated launcher in place.
      await writeFile(launcherPath, "' stale launcher\r\n");
      expect(await Effect.runPromise(readWindowsLauncherStatus(launcherPath))).toBe("outdated");
      await Effect.runPromise(writeServiceFiles(paths, "@echo off\r\n", metadata));
      expect(await Effect.runPromise(readWindowsLauncherStatus(launcherPath))).toBe("current");

      await writeFile(join(paths.configDir, "service-task.xml"), "leftover");
      await Effect.runPromise(removeServiceFiles(paths));
      expect(await Effect.runPromise(readWindowsLauncherStatus(launcherPath))).toBe("missing");
      await expect(readFile(join(paths.configDir, "service-task.xml"))).rejects.toThrow();
      await expect(readFile(paths.wrapperPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not write a launcher for POSIX backends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-posix-launcher-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir, XDG_CONFIG_HOME: join(dir, "xdg") },
        home: dir,
        platform: "linux",
      })!;

      await Effect.runPromise(
        writeServiceFiles(paths, "#!/bin/sh\n", {
          backend: "systemd",
          commandPath: "/usr/local/bin/tokenmaxxing",
          installedAt: "2026-06-16T09:00:00.000Z",
          schedule: "syncs every 5 minutes",
          version: 1,
        }),
      );

      expect(
        await Effect.runPromise(readWindowsLauncherStatus(join(dir, "service-sync.vbs"))),
      ).toBe("missing");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports missing or outdated launchers in service doctor", () => {
    expect(windowsLauncherDoctorCheck("C:\\tm\\service-sync.vbs", "current")).toEqual({
      detail: "C:\\tm\\service-sync.vbs",
      label: "launcher",
      status: "ok",
    });
    // A missing launcher fails every scheduled run.
    expect(windowsLauncherDoctorCheck("C:\\tm\\service-sync.vbs", "missing")).toEqual({
      detail: "C:\\tm\\service-sync.vbs missing; repair with tokenmaxxing service repair",
      fix: "repair with tokenmaxxing service repair",
      label: "launcher",
      status: "fail",
    });
    expect(windowsLauncherDoctorCheck("C:\\tm\\service-sync.vbs", "outdated").status).toBe("warn");
  });

  it("marks installs from older templates for repair so their task is re-registered", () => {
    const metadata: ServiceMetadata = {
      autoUpdateManager: "registry",
      backend: "windows-task-scheduler",
      commandPath: "C:\\tm\\service-runners\\0.7.0\\windows-x64\\tokenmaxxing.exe",
      installedAt: "2026-06-16T09:00:00.000Z",
      runnerTarget: "windows-x64",
      runnerVersion: "0.7.0",
      schedule: "syncs every 5 minutes",
      templateVersion: 5,
      version: 1,
    };

    expect(serviceReloadRequired(metadata)).toBe(true);
    expect(serviceReloadRequired({ ...metadata, templateVersion: 7 })).toBe(true);
    expect(serviceReloadRequired({ ...metadata, templateVersion: 8 })).toBe(false);
    // A newer runner wrote a newer template: not this CLI's to reload.
    expect(serviceReloadRequired({ ...metadata, templateVersion: 9 })).toBe(false);
    expect(
      serviceRepairNeedsSchedulerInstall({
        reason: serviceRepairReason({ reloadRequired: true, schedulerActive: true })!,
        reloadRequired: true,
        schedulerActive: true,
      }),
    ).toBe(true);
  });
});

function xmlElementText(xml: string, name: string): string {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  if (match === null) {
    throw new Error(`missing <${name}>`);
  }

  return match[1]!
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// Evaluates a VBScript `a & "literal" & b` expression: string literals double their quotes, and
// every other operand is looked up in `values`.
function evaluateVbsConcatenation(expression: string, values: Record<string, string>): string {
  let result = "";
  let rest = expression.trim();
  while (rest !== "") {
    if (rest.startsWith('"')) {
      let index = 1;
      let literal = "";
      while (index < rest.length) {
        if (rest[index] === '"') {
          if (rest[index + 1] === '"') {
            literal += '"';
            index += 2;
            continue;
          }
          break;
        }
        literal += rest[index];
        index += 1;
      }
      result += literal;
      rest = rest.slice(index + 1).trim();
    } else {
      const end = rest.indexOf(" & ");
      const operand = end === -1 ? rest : rest.slice(0, end);
      if (!(operand in values)) {
        throw new Error(`unknown VBScript operand ${operand}`);
      }
      result += values[operand];
      rest = end === -1 ? "" : rest.slice(end).trim();
    }
    rest = rest.replace(/^&\s*/, "").trim();
  }

  return result;
}

// libuv quote_cmd_arg: quote arguments with whitespace or quotes, escape embedded quotes, and
// double the backslashes that precede an escaped or closing quote.
function quoteWindowsArg(arg: string): string {
  if (arg === "") {
    return '""';
  }
  if (!/[\s"]/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

// CommandLineToArgvW rules: 2n backslashes + quote -> n backslashes and a quote toggle,
// 2n+1 backslashes + quote -> n backslashes and a literal quote, other backslashes are literal.
function splitWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasArg = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]!;
    if (char === "\\") {
      let backslashes = 0;
      while (commandLine[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
      } else {
        current += "\\".repeat(backslashes);
        index -= 1;
      }
      hasArg = true;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      hasArg = true;
    } else if ((char === " " || char === "\t") && !inQuotes) {
      if (hasArg) {
        args.push(current);
        current = "";
        hasArg = false;
      }
    } else {
      current += char;
      hasArg = true;
    }
  }
  if (hasArg) {
    args.push(current);
  }

  return args;
}

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

  // W1: a failing run (offline, 5xx, revoked token) re-registered the scheduler
  // through its deferred repair every 5 minutes.
  it("does not reinstall an active, current scheduler for a failed run's deferred repair", () => {
    expect(
      serviceRepairNeedsSchedulerInstall({
        deferred: true,
        reason: "service-failure",
        schedulerActive: true,
      }),
    ).toBe(false);
    expect(
      serviceRepairNeedsSchedulerInstall({
        deferred: true,
        reason: "service-failure",
        schedulerActive: false,
      }),
    ).toBe(true);
    expect(
      serviceRepairNeedsSchedulerInstall({
        deferred: true,
        reason: "service-failure",
        reloadRequired: true,
        schedulerActive: true,
      }),
    ).toBe(true);
    // A foreground repair still checks the scheduler (which leaves a current one alone).
    expect(
      serviceRepairNeedsSchedulerInstall({ reason: "service-failure", schedulerActive: true }),
    ).toBe(true);
  });

  it("schedules no repair for failures a repair cannot fix", () => {
    const request = HttpClientRequest.get("https://api.tokenmaxxing.example/me");
    const status = (code: number) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
          request,
          response: HttpClientResponse.fromWeb(request, new Response(null, { status: code })),
        }),
      });
    const offline = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") }),
    });

    for (const cause of [
      new SyncPushError({ cause: offline }),
      new SyncAuthValidationError({ cause: status(503) }),
      new SyncPushError({ cause: status(429) }),
      new SyncPushError({ cause: new ApiTimeoutError({ timeoutMs: 60_000 }) }),
      new Cause.TimeoutError(),
    ]) {
      expect(isTransientServiceFailure(cause)).toBe(true);
    }
    const unreadable = new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request,
        response: HttpClientResponse.fromWeb(request, new Response("<html>", { status: 200 })),
      }),
    });
    for (const cause of [
      new NotLoggedInError(),
      new SyncAuthValidationError({ cause: status(400) }),
      new SyncAuthValidationError({ cause: unreadable }),
      new Error("EACCES"),
    ]) {
      expect(isTransientServiceFailure(cause)).toBe(false);
    }
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
  });

  it("spawns Windows deferred repairs through the hidden launcher", () => {
    const env = {
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TOKENMAXXING_CONFIG_DIR: "C:\\Users\\Zoë\\tm",
    };

    expect(
      deferredServiceRepairInvocation(
        "C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
        "auto-updated",
        "win32",
        env,
      ),
    ).toEqual({
      args: [
        "//B",
        "//NoLogo",
        "//E:VBScript",
        join("C:\\Users\\Zoë\\tm", "service-sync.vbs"),
        "repair",
        "auto-updated",
      ],
      command: "C:\\Windows\\System32\\wscript.exe",
      options: {
        detached: true,
        env: {
          ...env,
          TOKENMAXXING_SERVICE_REPAIR_COMMAND:
            "C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
        },
        stdio: "ignore",
        windowsHide: true,
      },
    });
  });

  it("waits for the scheduled sync to release the run lock before a Windows repair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-repair-wait-"));

    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: "C:\\Users\\alex",
        platform: "win32",
      })!;
      await writeFile(
        paths.lockPath,
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          ownerId: "sync",
          pid: 1,
          version: 1,
        }),
      );
      const sleeps: number[] = [];
      const clock = Layer.succeed(ClockService)({
        sleep: (ms: number) =>
          Effect.promise(async () => {
            sleeps.push(ms);
            if (sleeps.length === 2) {
              await rm(paths.lockPath, { force: true });
            }
          }),
      });

      await Effect.runPromise(waitForServiceRunExit(paths).pipe(Effect.provide(clock)));

      expect(sleeps).toEqual([500, 500, 2000]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("schedules linux deferred repairs with systemd-run outside the current service cgroup", () => {
    expect(
      deferredServiceRepairInvocation("/usr/local/bin/tokenmaxxing", "reload-required", "linux", {
        CODEX_HOME: "/data/Codex Logs, extra",
        PATH: "/usr/local/bin:/usr/bin",
        TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing",
      }),
    ).toMatchObject({
      args: [
        "--user",
        "--quiet",
        "--collect",
        "--on-active=2s",
        "--timer-property=AccuracySec=100ms",
        "--unit=tokenmaxxing-sync-repair-reload-required",
        "--setenv=PATH=/usr/local/bin:/usr/bin",
        "--setenv=CODEX_HOME=/data/Codex Logs, extra",
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

  it("starts a linux deferred repair from the runner's directory when systemd cannot re-read its path", () => {
    const argsFor = (commandPath: string) =>
      deferredServiceRepairInvocation(commandPath, "reload-required", "linux", {}).args;
    const runnerDir = `/home/alex/Zoë O'Neil "dq" \\back $HOME 100%/tm/service-runners/0.7.1/linux-x64`;

    // A daemon-reload before the timer fires re-parses the transient unit: an executable path with
    // a quote, backslash or $ no longer loads, and a $ in an argument changes meaning.
    for (const dir of [runnerDir, "/home/alex/O'Neil/tm", "/home/alex/$HOME/tm"]) {
      expect(argsFor(`${dir}/tokenmaxxing`).slice(-4)).toEqual([
        `--working-directory=${dir}`,
        "/bin/sh",
        "-c",
        "exec ./'tokenmaxxing' 'service' 'repair' '--deferred' '--json' '--reason' 'reload-required'",
      ]);
    }
    // Other paths (specifiers included) keep the direct form.
    expect(argsFor("/home/alex/Zoë (Work) 100%/tm/tokenmaxxing").slice(-7)).toEqual([
      "/home/alex/Zoë (Work) 100%/tm/tokenmaxxing",
      "service",
      "repair",
      "--deferred",
      "--json",
      "--reason",
      "reload-required",
    ]);
  });
});

describe("service config dir", () => {
  it("refuses a config dir with a tab, newline or other control character", async () => {
    for (const configDir of ["/home/alex/tab\there/tm", "/home/alex/new\nline/tm", "/tmp/\u0001"]) {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: configDir },
        home: "/home/alex",
        platform: "linux",
      })!;
      const exit = await Effect.runPromiseExit(ensureServiceConfigDirSupported(paths));
      expect(failureTag(exit)).toBe("ServiceConfigDirUnsupportedError");
    }
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/home/alex/Zoë O'Neil (Work) & Co 100%/tm" },
      home: "/home/alex",
      platform: "linux",
    })!;
    await expect(
      Effect.runPromise(ensureServiceConfigDirSupported(paths)),
    ).resolves.toBeUndefined();
    expect(new ServiceConfigDirUnsupportedError({ configDir: "/home/a\tb/tm" }).message).toBe(
      'error: the config dir contains a control character (such as a tab or newline)\npath: "/home/a\\tb/tm"\nhint: set TOKENMAXXING_CONFIG_DIR to a path without control characters, then run tokenmaxxing service install',
    );
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
          fetchDistTags: () => Effect.succeed({ latest: "0.4.12" }),
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
        fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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
        fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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
          fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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
        fetchDistTags: () => Effect.succeed(null),
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
        fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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
        fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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
        fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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
        fetchDistTags: () => Effect.succeed({ latest: "0.4.13" }),
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

  describe("package-manager release channels", () => {
    async function runChannelUpdate(currentVersion: string, distTags: Record<string, string>) {
      const updates: Array<{ manager: string; specifier: string }> = [];
      const report = await runAutoUpdate(
        metadata,
        {
          commandExists: () => Effect.succeed(true),
          fetchDistTags: () => Effect.succeed(distTags),
          now,
          readInstalledVersion: () => Effect.succeed(updates.at(-1)?.specifier ?? currentVersion),
          runPackageManagerUpdate: (manager, specifier) =>
            Effect.sync(() => {
              updates.push({ manager, specifier });
            }),
        },
        currentVersion,
      );

      return { report, updates };
    }

    it("never downgrades an alpha runner to an older latest", async () => {
      const { report, updates } = await runChannelUpdate("0.7.0-alpha.0", {
        alpha: "0.7.0-alpha.0",
        latest: "0.6.0",
      });

      expect(updates).toEqual([]);
      expect(report).toMatchObject({
        currentVersion: "0.7.0-alpha.0",
        installedVersion: "0.7.0-alpha.0",
        latestVersion: "0.7.0-alpha.0",
        status: "not-needed",
      });
    });

    it("keeps an alpha runner when only an older latest is published", async () => {
      const { report, updates } = await runChannelUpdate("0.7.0-alpha.0", { latest: "0.6.0" });

      expect(updates).toEqual([]);
      expect(report).toMatchObject({ latestVersion: "0.6.0", status: "not-needed" });
    });

    it("updates an alpha runner along the alpha channel by exact version", async () => {
      const { report, updates } = await runChannelUpdate("0.7.0-alpha.9", {
        alpha: "0.7.0-alpha.10",
        latest: "0.6.0",
      });

      expect(updates).toEqual([{ manager: "npm", specifier: "0.7.0-alpha.10" }]);
      expect(report).toMatchObject({
        installedVersion: "0.7.0-alpha.10",
        latestVersion: "0.7.0-alpha.10",
        status: "success",
      });
    });

    it("graduates an alpha runner to the release on latest", async () => {
      const { report, updates } = await runChannelUpdate("0.7.0-alpha.1", {
        alpha: "0.7.0-alpha.1",
        latest: "0.7.0",
      });

      expect(updates).toEqual([{ manager: "npm", specifier: "0.7.0" }]);
      expect(report).toMatchObject({ installedVersion: "0.7.0", status: "success" });
    });

    it("keeps a stable runner off prerelease channels", async () => {
      const { report, updates } = await runChannelUpdate("0.6.0", {
        alpha: "0.7.0-alpha.1",
        latest: "0.6.0",
      });

      expect(updates).toEqual([]);
      expect(report).toMatchObject({ latestVersion: "0.6.0", status: "not-needed" });
    });

    it("updates a stable runner through latest", async () => {
      const { report, updates } = await runChannelUpdate("0.6.0", {
        alpha: "0.7.0-alpha.1",
        latest: "0.6.1",
      });

      expect(updates).toEqual([{ manager: "npm", specifier: "0.6.1" }]);
      expect(report).toMatchObject({ installedVersion: "0.6.1", status: "success" });
    });

    it("never downgrades a stable runner that is ahead of latest", async () => {
      const { report, updates } = await runChannelUpdate("0.6.1", { latest: "0.6.0" });

      expect(updates).toEqual([]);
      expect(report).toMatchObject({ latestVersion: "0.6.0", status: "not-needed" });
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
      expect(fetchedSpecifiers).toEqual(
        testCase.specifier === "latest" ? ["latest"] : [testCase.specifier, "latest"],
      );
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

  it("never downgrades a prerelease registry runner to an older latest", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });
    const releases: Record<string, string> = { alpha: "0.7.0-alpha.0", latest: "0.6.0" };

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: (_target, distTag) =>
            Effect.succeed(registryRelease(releases[distTag]!)),
          installRunnerRelease: () => Effect.fail(new Error("should not install")),
          now,
        },
        "0.7.0-alpha.0",
        paths!,
      ),
    ).resolves.toMatchObject({
      installedVersion: "0.7.0-alpha.0",
      latestVersion: "0.7.0-alpha.0",
      manager: "registry",
      reason: null,
      status: "not-needed",
    });
  });

  it("graduates a prerelease registry runner once its release lands on latest", async () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    })!;
    const releases: Record<string, string | null> = { alpha: "0.4.18-alpha.1", latest: "0.4.18" };
    const installed: string[] = [];

    await expect(
      runAutoUpdate(
        registryMetadata,
        {
          fetchRunnerRelease: (_target, distTag) => {
            const version = releases[distTag];
            return Effect.succeed(
              version === null || version === undefined ? null : registryRelease(version),
            );
          },
          installRunnerRelease: (release) =>
            Effect.sync(() => {
              installed.push(release.version);
              return {
                packageName: release.packageName,
                path: `/tmp/tokenmaxxing/service-runners/${release.version}/darwin-arm64/tokenmaxxing`,
                target: release.target,
                version: release.version,
              };
            }),
          now,
        },
        "0.4.18-alpha.1",
        paths,
      ),
    ).resolves.toMatchObject({
      installedVersion: "0.4.18",
      latestVersion: "0.4.18",
      manager: "registry",
      status: "success",
    });
    expect(installed).toEqual(["0.4.18"]);
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
      expect(fetchedTargets).toEqual([
        "darwin-x64",
        "darwin-x64",
        "darwin-x64-baseline",
        "darwin-x64-baseline",
      ]);
      expect(fetchedSpecifiers).toEqual(["alpha", "latest", "alpha", "latest"]);
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
  const localDateTime = (year: number, month: number, day: number, hour = 12, minute = 0): Date =>
    new Date(year, month - 1, day, hour, minute);

  it("uses the previous successful local date for scheduled syncs", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: localDateTime(2026, 6, 16, 23, 30).toISOString(), version: 1 },
        localDateTime(2026, 6, 17, 0, 5),
        true,
      ),
    ).toBe("2026-06-16");
  });

  it("falls back to the legacy success date when no timestamp marker exists", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessDate: "2026-06-15", version: 1 },
        localDateTime(2026, 6, 17),
        true,
      ),
    ).toBe("2026-06-15");
  });

  it("falls back to yesterday when no reliable marker exists", () => {
    expect(serviceScheduledSyncSince({ version: 1 }, localDateTime(2026, 6, 17), true)).toBe(
      "2026-06-16",
    );
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "not-a-date", version: 1 },
        localDateTime(2026, 6, 17),
        true,
      ),
    ).toBe("2026-06-16");
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: localDateTime(2026, 6, 18).toISOString(), version: 1 },
        localDateTime(2026, 6, 17),
        true,
      ),
    ).toBe("2026-06-16");
  });

  it("does not set since for manual service runs", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: localDateTime(2026, 6, 16, 23, 30).toISOString(), version: 1 },
        localDateTime(2026, 6, 17, 0, 5),
        false,
      ),
    ).toBeUndefined();
  });
});

describe("scheduled reconciliation window", () => {
  const localDateTime = (year: number, month: number, day: number, hour = 12, minute = 0): Date =>
    new Date(year, month - 1, day, hour, minute);
  const now = localDateTime(2026, 9, 22, 16, 45);

  it("reconciles on the first scheduled run after upgrading", () => {
    expect(
      serviceReconcileDue(
        { lastSuccessAt: localDateTime(2026, 9, 22, 16, 40).toISOString(), version: 1 },
        now,
        true,
      ),
    ).toBe(true);
  });

  it("reconciles again once the interval has elapsed", () => {
    const reconciledAt = (hoursAgo: number) =>
      new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();

    expect(serviceReconcileDue({ lastReconcileAt: reconciledAt(1), version: 1 }, now, true)).toBe(
      false,
    );
    expect(serviceReconcileDue({ lastReconcileAt: reconciledAt(5.9), version: 1 }, now, true)).toBe(
      false,
    );
    expect(serviceReconcileDue({ lastReconcileAt: reconciledAt(6), version: 1 }, now, true)).toBe(
      true,
    );
  });

  it("treats unreadable or future markers as due", () => {
    expect(serviceReconcileDue({ lastReconcileAt: "not-a-date", version: 1 }, now, true)).toBe(
      true,
    );
    expect(
      serviceReconcileDue(
        { lastReconcileAt: localDateTime(2026, 9, 23).toISOString(), version: 1 },
        now,
        true,
      ),
    ).toBe(true);
  });

  it("never reconciles manual service runs, which already sync everything", () => {
    expect(serviceReconcileDue({ version: 1 }, now, false)).toBe(false);
  });

  it("re-sends a trailing window of local days including today", () => {
    expect(serviceReconcileSince(now, {})).toBe("2026-09-02");
    expect(serviceReconcileSince(now, { TOKENMAXXING_SYNC_WINDOW_DAYS: "1" })).toBe("2026-09-22");
    expect(serviceReconcileSince(now, { TOKENMAXXING_SYNC_WINDOW_DAYS: "14" })).toBe("2026-09-09");
    expect(serviceReconcileSince(localDateTime(2026, 3, 10), {})).toBe("2026-02-18");
  });

  it("falls back to the default window for invalid overrides", () => {
    for (const value of ["", "0", "-3", "7.5", "abc", "91"]) {
      expect(serviceReconcileWindowDays({ TOKENMAXXING_SYNC_WINDOW_DAYS: value })).toBe(21);
    }
    expect(serviceReconcileWindowDays({ TOKENMAXXING_SYNC_WINDOW_DAYS: " 90 " })).toBe(90);
  });
});

describe("usage replacement backfill", () => {
  it("runs once on a scheduled service after upgrading", () => {
    expect(serviceNeedsUsageReplacementBackfill({ version: 1 }, true)).toBe(true);
    expect(
      serviceNeedsUsageReplacementBackfill(
        { usageReplacementBackfillVersion: 1, version: 1 },
        true,
      ),
    ).toBe(false);
    expect(serviceNeedsUsageReplacementBackfill({ version: 1 }, false)).toBe(false);
  });

  it("completes after Codex daily collection succeeds or finds no local data", () => {
    expect(
      serviceCompletedUsageReplacementBackfill({
        dryRun: false,
        rows: 1,
        sourceResults: [
          {
            source: "codex",
            status: "synced",
            summary: { days: 1, models: 1, rows: 1, sessions: 1, spendUsd: 1 },
          },
        ],
        sources: {
          codex: { days: 1, models: 1, rows: 1, sessions: 1, spendUsd: 1 },
        },
        status: "ok",
        upserted: 1,
      }),
    ).toBe(true);
    expect(
      serviceCompletedUsageReplacementBackfill({
        dryRun: false,
        rows: 0,
        sourceResults: [
          {
            issue: {
              code: "command_failed",
              message: "ccusage command failed",
              report: "daily",
            },
            source: "codex",
            status: "failed",
            summary: null,
          },
        ],
        sources: { codex: null },
        status: "error",
      }),
    ).toBe(false);
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
        usageReplacementBackfillVersion: 1,
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
      usageReplacementBackfillVersion: 1,
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

  it("logs why a source was skipped and how long each of its reports took", () => {
    const state = serviceRunSuccessState(
      { version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        autoUpdate: autoUpdateReport(),
        durationMs: 1234,
        result: {
          ...syncResult,
          sourceResults: [
            ...syncResult.sourceResults,
            { reason: "unchanged", source: "claude", status: "skipped", summary: null },
          ],
          timings: { codex: { dailyMs: 95_000, sessionMs: 90_000 }, gemini: { dailyMs: 300 } },
        },
        since: "2026-06-16",
        successAt: "2026-06-16T10:00:01.000Z",
        version: "0.8.0",
      },
    );

    expect(state.lastSources).toEqual([
      expect.objectContaining({ dailyMs: 95_000, sessionMs: 90_000, source: "codex" }),
      { dailyMs: 300, source: "gemini", status: "skipped" },
      { reason: "unchanged", source: "claude", status: "skipped" },
    ]);
  });

  it("records a completed reconciliation", () => {
    const state = serviceRunSuccessState(
      { lastReconcileAt: "2026-06-16T02:00:00.000Z", version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        autoUpdate: autoUpdateReport(),
        durationMs: 1234,
        reconciledAt: "2026-06-16T10:00:00.000Z",
        result: syncResult,
        since: "2026-05-27",
        successAt: "2026-06-16T10:00:01.000Z",
        version: "0.6.1",
      },
    );

    expect(state.lastReconcileAt).toBe("2026-06-16T10:00:00.000Z");
    expect(serviceStateJson(state)).toMatchObject({
      lastReconcileAt: "2026-06-16T10:00:00.000Z",
    });
  });

  it("keeps the previous reconciliation marker for incremental or failed runs", () => {
    const base = {
      arch: "arm64",
      attemptAt: "2026-06-16T10:00:00.000Z",
      autoUpdate: autoUpdateReport(),
      durationMs: 1234,
      successAt: "2026-06-16T10:00:01.000Z",
      version: "0.6.1",
    };
    const current = { lastReconcileAt: "2026-06-16T02:00:00.000Z", version: 1 as const };

    expect(serviceRunSuccessState(current, { ...base, result: syncResult }).lastReconcileAt).toBe(
      "2026-06-16T02:00:00.000Z",
    );
    expect(
      serviceRunSuccessState(current, {
        ...base,
        reconciledAt: "2026-06-16T10:00:00.000Z",
        result: { ...syncResult, rows: 0, status: "error" },
      }).lastReconcileAt,
    ).toBe("2026-06-16T02:00:00.000Z");
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
      lastError: `no usage synced; could not run ccusage for codex: neither bun nor ${
        process.platform === "win32" ? "npx.cmd" : "npx"
      } is on PATH`,
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

  // A Windows device failing every run only reported "ccusage source
  // collection failed"; the reasons lived in its service.log alone.
  it("records why each source failed as the run's error", () => {
    const failed = (
      source: UsageSource,
      issue: Omit<SyncSourceIssue, "report">,
    ): SyncSourceResult => ({
      issue: { ...issue, report: "daily" },
      source,
      status: "failed",
      summary: null,
    });
    const npmFailed = {
      code: "command_failed" as const,
      detail: "npm error code E401\nnpm error 401 Unauthorized - GET https://registry.corp/ccusage",
      message: "ccusage command failed",
    };
    const input = {
      arch: "x64",
      attemptAt: "2026-10-01T10:00:00.000Z",
      autoUpdate: autoUpdateReport(),
      durationMs: 1234,
      successAt: "2026-10-01T10:00:01.000Z",
      version: "0.7.2",
    };
    const result: SyncResult = {
      dryRun: false,
      rows: 0,
      sourceResults: [
        failed("claude", npmFailed),
        failed("codex", { code: "command_timed_out", message: "ccusage command timed out" }),
        failed("gemini", npmFailed),
        failed("amp", npmFailed),
      ],
      sources: {},
      status: "error",
    };

    const state = serviceRunSuccessState({ version: 1 }, { ...input, result });

    expect(state.lastError).toBe(
      [
        "no usage synced; ccusage failed for claude, codex, gemini, amp",
        "claude, gemini, amp: ccusage command failed: npm error 401 Unauthorized - GET https://registry.corp/ccusage",
        "codex: ccusage command timed out",
      ].join("\n"),
    );
    expect(serviceRunLogLine(state, "failure")).toMatchObject({ error: state.lastError });
    // doctor and status show the summary line.
    expect(formatServiceLastError(state.lastError ?? "")).toBe(
      "no usage synced; ccusage failed for claude, codex, gemini, amp",
    );

    // Agents without logs are counted, as on the console.
    expect(
      serviceRunSuccessState({ version: 1 }, { ...input, result, withoutLogs: ["gemini", "amp"] })
        .lastError,
    ).toBe(
      [
        "no usage synced; ccusage failed for claude, codex and 2 agents without logs",
        "claude and 2 agents without logs: ccusage command failed: npm error 401 Unauthorized - GET https://registry.corp/ccusage",
        "codex: ccusage command timed out",
      ].join("\n"),
    );
  });

  // The check-in's error leaves the machine: a profile path names the user.
  it("redacts home directories from a failed run's error", () => {
    const state = serviceRunSuccessState(
      { version: 1 },
      {
        arch: "x64",
        attemptAt: "2026-10-01T10:00:00.000Z",
        autoUpdate: autoUpdateReport(),
        durationMs: 1234,
        result: {
          dryRun: false,
          rows: 0,
          sourceResults: [
            {
              issue: {
                code: "command_failed",
                detail: `npm error A complete log of this run can be found in: ${homedir()}/.npm/_logs/debug-0.log`,
                message: "ccusage command failed",
                report: "daily",
              },
              source: "claude",
              status: "failed",
              summary: null,
            },
          ],
          sources: {},
          status: "error",
        },
        successAt: "2026-10-01T10:00:01.000Z",
        version: "0.7.2",
      },
    );

    expect(state.lastError).toBe(
      [
        "no usage synced; ccusage failed for claude",
        "claude: ccusage command failed: npm error A complete log of this run can be found in: <home>/.npm/_logs/debug-0.log",
      ].join("\n"),
    );
  });

  it.each([
    [
      "npm error path C:\\Users\\jdoe\\AppData\\Local\\npm-cache",
      "npm error path <home>\\AppData\\Local\\npm-cache",
    ],
    ["at c:/users/jdoe/AppData/x.js:1", "at <home>/AppData/x.js:1"],
    ['{"path":"C:\\\\Users\\\\jdoe\\\\AppData"}', '{"path":"<home>\\\\AppData"}'],
    ["open C:\\Users\\Jo Doe\\AppData\\npmrc", "open <home>\\AppData\\npmrc"],
    ["C:\\Users\\Zoë O'Neil (Work)\\.npmrc", "<home>\\.npmrc"],
    ["EACCES: /Users/jdoe/.npm, '/home/jdoe'", "EACCES: <home>/.npm, '<home>'"],
    ["no profile path here: /usr/local/bin/npx", "no profile path here: /usr/local/bin/npx"],
  ])("redacts the profile directory in %s", (text, redacted) => {
    expect(redactHomePaths(text, "/nonexistent-home")).toBe(redacted);
  });

  it("redacts the home directory wherever it lives", () => {
    expect(redactHomePaths("cannot read D:\\Profiles\\jdoe\\.npmrc", "D:\\Profiles\\jdoe")).toBe(
      "cannot read <home>\\.npmrc",
    );
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

  it("records sources a ccusage timeout left for the next run as the run's error", () => {
    const timedOut: SyncSourceResult = {
      issue: { code: "command_timed_out", message: "ccusage command timed out", report: "daily" },
      source: "claude",
      status: "failed",
      summary: null,
    };
    const deferred = (source: UsageSource, reason: "run_deadline" | "runner_timed_out") => ({
      reason,
      source,
      status: "skipped" as const,
      summary: null,
    });
    const input = {
      arch: "arm64",
      attemptAt: "2026-06-16T10:00:00.000Z",
      autoUpdate: autoUpdateReport(),
      durationMs: 181_000,
      successAt: "2026-06-16T10:03:01.000Z",
      version: "0.7.0",
    };

    const failed = serviceRunSuccessState(
      { version: 1 },
      {
        ...input,
        result: {
          dryRun: false,
          rows: 0,
          sourceResults: [
            timedOut,
            deferred("codex", "runner_timed_out"),
            deferred("gemini", "runner_timed_out"),
          ],
          sources: {},
          status: "error",
        },
      },
    );
    expect(failed.lastError).toBe(
      "ccusage timed out for claude; skipped 2 sources until the next run",
    );
    expect(failed.lastSources?.[1]).toEqual({
      reason: "runner_timed_out",
      source: "codex",
      status: "skipped",
    });
    const failedLine = serviceRunLogLine(failed, "failure");
    expect(failedLine).toMatchObject({ error: failed.lastError, syncStatus: "error" });

    // Sources that synced before the timeout still count as a success, but
    // doctor and the log line say what was left out.
    const partial = serviceRunSuccessState(
      { version: 1 },
      {
        ...input,
        result: {
          dryRun: false,
          rows: 2,
          sourceResults: [
            {
              source: "codex",
              status: "synced",
              summary: { days: 2, models: 1, rows: 2, sessions: 1, spendUsd: 1 },
            },
            { ...timedOut, source: "gemini" },
            deferred("pi", "runner_timed_out"),
          ],
          sources: {},
          status: "partial",
          upserted: 2,
        },
      },
    );
    expect(partial).toMatchObject({
      lastError: "ccusage timed out for gemini; skipped 1 source until the next run",
      lastSuccessAt: input.successAt,
    });
    expect(serviceRunLogLine(partial, "success")).toMatchObject({
      error: partial.lastError,
      status: "success",
    });

    const deadline = serviceRunSuccessState(
      { version: 1 },
      {
        ...input,
        result: {
          dryRun: false,
          rows: 0,
          sourceResults: [deferred("claude", "run_deadline")],
          sources: {},
          status: "ok",
        },
      },
    );
    expect(deadline.lastError).toBe(
      "the run reached its 10-minute limit; skipped 1 source until the next run",
    );
  });

  it("names the sources a timeout left for the next run when every source failed", () => {
    const error = new ServiceSourcesFailedError({
      deferred: 17,
      failures: [
        {
          issue: {
            code: "command_timed_out",
            message: "ccusage command timed out",
            report: "daily",
          },
          source: "claude",
        },
      ],
    });

    expect(error.message).toBe(
      [
        "error: no usage synced; ccusage failed for claude",
        "claude: ccusage command timed out",
        "skipped 17 more sources until the next run",
        "hint: check that ccusage runs for this agent, then run tokenmaxxing sync again",
      ].join("\n"),
    );
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

  it("leaves the previous run's results out of a failed run's log line", () => {
    const state = serviceRunFailureState(
      { lastRows: 42, lastSyncStatus: "ok", lastUpserted: 40, version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        durationMs: 222,
        error: "network unavailable",
        version: "0.4.12",
      },
    );

    const line = serviceRunLogLine(state, "failure", { hasResults: false });
    expect(line).toMatchObject({ error: "network unavailable", status: "failure" });
    expect(line.rows).toBeUndefined();
    expect(line.upserted).toBeUndefined();
    expect(line.syncStatus).toBeUndefined();
    expect(serviceRunLogLine(state, "success")).toMatchObject({ rows: 42, syncStatus: "ok" });
  });

  it("says what a failed login check ran into, and when the next run can fix it", () => {
    const request = HttpClientRequest.get("https://api.tokenmaxxing.example/me");
    const offline = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        cause: Object.assign(new TypeError("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
        request,
      }),
    });
    const forbidden = new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request,
        response: HttpClientResponse.fromWeb(request, new Response("denied", { status: 403 })),
      }),
    });
    const networkFailure = new SyncAuthValidationError({ attempts: 3, cause: offline });

    expect(serviceAuthFailureError(networkFailure)).toBe(
      "failed to validate stored login after 3 attempts; network unavailable (ENOTFOUND); will retry next run",
    );
    expect(serviceAuthFailureError(new SyncAuthValidationError({ cause: forbidden }))).toBe(
      "failed to validate stored login; the tokenmaxxing API answered HTTP 403",
    );
    expect(serviceAuthFailureError(new NotLoggedInError())).toBe(
      "NotLoggedInError: error: not logged in\nhint: run tokenmaxxing login",
    );

    const state = serviceRunFailureState(
      { version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-09-29T20:33:25.000Z",
        durationMs: 36_000,
        error: serviceAuthFailureError(networkFailure),
        version: "0.7.0",
      },
    );
    const line = JSON.parse(
      JSON.stringify(
        serviceRunLogLine(state, "failure", {
          hasResults: false,
          loginCheck: networkFailure.loginCheck,
        }),
      ),
    );
    expect(line).toMatchObject({
      error:
        "failed to validate stored login after 3 attempts; network unavailable (ENOTFOUND); will retry next run",
      loginCheck: { attempts: 3, code: "ENOTFOUND", kind: "network" },
      status: "failure",
    });
    expect(JSON.stringify(line)).not.toContain("authorization");
    expect(serviceRunLogLine(state, "failure")).not.toHaveProperty("loginCheck", expect.anything());
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

describe("service run and repair errors", () => {
  it("name the cause, since a scheduled run's only output is the log", () => {
    const eacces = new Error(
      "EACCES: permission denied, open '/home/alex/.config/tokenmaxxing/service-state.json'",
    );

    expect(new ServiceRunError({ cause: eacces }).message).toBe(
      "error: tokenmaxxing service run failed\ncause: EACCES: permission denied, open '/home/alex/.config/tokenmaxxing/service-state.json'\nhint: inspect the service log for details",
    );
    expect(new ServiceRepairError({ cause: eacces }).message).toContain("\ncause: EACCES");
    expect(new ServiceRunError({ cause: undefined }).message).toBe(
      "error: tokenmaxxing service run failed\nhint: inspect the service log for details",
    );
  });

  it("fail a scheduled run in which every source failed, with the reason", () => {
    expect(
      new ServiceSourcesFailedError({
        failures: [
          {
            issue: {
              code: "command_failed",
              detail: "/usr/bin/env: 'node': No such file or directory",
              message: "ccusage command failed",
              report: "daily",
            },
            source: "claude",
          },
        ],
      }).message,
    ).toBe(
      [
        "error: no usage synced; ccusage failed for claude",
        "claude: ccusage command failed: /usr/bin/env: 'node': No such file or directory",
        "hint: check that ccusage runs for this agent, then run tokenmaxxing sync again",
      ].join("\n"),
    );
  });
});

describe("dead lock holders", () => {
  // L2: a run killed by SIGKILL, OOM or a power loss left its lock, and every
  // sync was skipped until the lock went stale 2 hours later.
  const now = new Date("2026-06-16T10:05:00.000Z");
  const lock = (pid: number, host?: string) =>
    serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ...(host === undefined ? {} : { hostname: host }),
        ownerId: "test",
        pid,
        version: 1,
      },
      now,
    );
  const deadPid = 2 ** 22 + 12_345;

  it("takes over a fresh lock whose process is gone on this machine", async () => {
    expect(lock(deadPid, "this-mac").stale).toBe(false);
    await expect(
      serviceLockCanBeReplaced(
        lock(deadPid, "this-mac"),
        { pidAwareStaleTakeover: true },
        "this-mac",
      ),
    ).resolves.toBe(true);
    // Locks written before 0.7.0 have no hostname; the config dir is local.
    await expect(
      serviceLockCanBeReplaced(lock(deadPid), { pidAwareStaleTakeover: true }, "this-mac"),
    ).resolves.toBe(true);
  });

  it("keeps a fresh lock whose process is alive, or that another machine wrote", async () => {
    await expect(
      serviceLockCanBeReplaced(
        lock(process.pid, "this-mac"),
        { pidAwareStaleTakeover: true },
        "this-mac",
      ),
    ).resolves.toBe(false);
    await expect(
      serviceLockCanBeReplaced(
        lock(deadPid, "other-mac"),
        { pidAwareStaleTakeover: true },
        "this-mac",
      ),
    ).resolves.toBe(false);
  });

  it("acquires a lock file left by a dead process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-dead-lock-"));
    try {
      const path = join(dir, "service.lock");
      await writeFile(
        path,
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          ownerId: "killed",
          pid: deadPid,
          version: 1,
        }),
      );

      const result = await Effect.runPromise(acquireServiceRunLock(path, new Date()));

      expect(result._tag).toBe("acquired");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("doctor runner inspection", () => {
  async function inspect(setup: (runner: string, pointer: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-doctor-runner-"));
    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: dir,
        platform: "linux",
      })!;
      const runner = join(paths.runnersDir, "0.7.0", "linux-x64", "tokenmaxxing");
      await mkdir(dirname(runner), { recursive: true });
      await writeFile(runner, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      await writeFile(paths.runnerPointerPath, `${runner}\n`);
      await setup(runner, paths.runnerPointerPath);
      const result = await Effect.runPromise(inspectServiceRunner(paths));
      return result._tag === "ok" ? "ok" : result.detail.replace(dir, "<dir>");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  it.skipIf(process.platform === "win32")(
    "reports every way the wrapper would fail to run the runner",
    async () => {
      expect(await inspect(async () => {})).toBe("ok");
      expect(await inspect((_runner, pointer) => rm(pointer))).toMatch(/^pointer missing: /);
      expect(await inspect((_runner, pointer) => writeFile(pointer, ""))).toMatch(
        /^pointer is not a runner path: /,
      );
      expect(await inspect((_runner, pointer) => writeFile(pointer, "garbage\x00"))).toMatch(
        /^pointer is not a runner path: /,
      );
      expect(await inspect((runner) => rm(runner))).toMatch(/^runner missing: /);
      expect(await inspect((runner) => writeFile(runner, ""))).toMatch(
        /^runner is empty \(0 bytes\): /,
      );
      expect(await inspect((runner) => chmod(runner, 0o644))).toMatch(
        /^runner is not executable: /,
      );
    },
  );
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

describe("installing an unchanged runner", () => {
  // W1: a refresh copied the runner over itself, which failed with EPERM on
  // Windows while a sync was running it.
  it("leaves an identical runner and pointer untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-same-"));
    try {
      const paths = servicePaths({
        env: { TOKENMAXXING_CONFIG_DIR: dir },
        home: dir,
        platform: "linux",
      })!;
      const destinationPath = join(paths.runnersDir, "0.7.0", "linux-x64", "tokenmaxxing");
      const install = (bytes: string) =>
        installServiceRunnerBinary({
          destinationPath,
          packageName: "@851-labs/tokenmaxxing-linux-x64",
          paths,
          platform: "linux",
          sourceBytes: new TextEncoder().encode(bytes),
          target: "linux-x64",
          version: "0.7.0",
        });

      await install("#!/bin/sh\necho one\n");
      const identity = async (path: string) => {
        const info = await stat(path);
        return { ino: info.ino, mtimeMs: info.mtimeMs };
      };
      const runner = await identity(destinationPath);
      const pointer = await identity(paths.runnerPointerPath);

      await install("#!/bin/sh\necho one\n");
      expect(await identity(destinationPath)).toEqual(runner);
      expect(await identity(paths.runnerPointerPath)).toEqual(pointer);

      await install("#!/bin/sh\necho two\n");
      expect(await readFile(destinationPath, "utf8")).toBe("#!/bin/sh\necho two\n");
      expect((await stat(destinationPath)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("repair never moves the runner back", () => {
  // L3: an auto-updated runner (alpha.2) was "repaired" back to the global
  // CLI's own, older runner (alpha.1), which then auto-updated again.
  const paths = servicePaths({
    env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing-repair-downgrade" },
    home: "/Users/alex",
    platform: "darwin",
  })!;
  const current = {
    packageName: serviceRunnerPackageName("darwin-arm64"),
    path: "/tmp/tokenmaxxing-repair-downgrade/service-runners/0.7.0-alpha.2/darwin-arm64/tokenmaxxing",
    target: "darwin-arm64" as const,
    version: "0.7.0-alpha.2",
  };
  const repair = (runnerVersion: string) =>
    Effect.runPromiseExit(
      installServiceRunnerForRepair(paths, {
        cpuArch: "arm64",
        fetchRunnerRelease: () => Effect.succeed(null),
        platform: "darwin",
        readCurrentRunner: () => Effect.succeed(current),
        resolvePackageJson: () => null,
        runnerVersion,
      }),
    );

  it("keeps a current runner that is newer than this CLI", async () => {
    const exit = await repair("0.7.0-alpha.1");

    expect(exit).toEqual(Exit.succeed(current));
  });

  it("installs this CLI's runner when it is newer than the current one", async () => {
    const exit = await repair("0.7.0");

    // No optional package or registry release in this test: it tried to install.
    expect(failureTag(exit)).toBe("ServiceRunnerPackageMissingError");
  });
});

describe("keepNewerCurrentRunner", () => {
  const paths = servicePaths({
    env: { TOKENMAXXING_CONFIG_DIR: "C:\\Users\\Zoë\\.config\\tokenmaxxing" },
    home: "C:\\Users\\Zoë",
    platform: "win32",
  })!;
  const current = {
    packageName: serviceRunnerPackageName("windows-arm64"),
    path: "C:\\Users\\Zoë\\.config\\tokenmaxxing\\service-runners\\0.7.0\\windows-arm64\\tokenmaxxing.exe",
    target: "windows-arm64" as const,
    version: "0.7.0",
  };
  const keep = (ownVersion: string, runningPath: string) =>
    Effect.runPromise(
      keepNewerCurrentRunner(
        paths,
        ownVersion,
        () => Effect.succeed(current),
        runningPath,
        "win32",
      ),
    );

  it("keeps the current runner when it is the exe running this command", async () => {
    // A runner sits in no npm package: installing "its own" runner would download itself again.
    expect(await keep("0.7.0", current.path.toUpperCase())).toEqual(current);
  });

  it("installs this CLI's runner from any other exe at the same version", async () => {
    expect(
      await keep(
        "0.7.0",
        "C:\\Users\\Zoë\\AppData\\Roaming\\npm\\node_modules\\@851-labs\\tokenmaxxing\\bin\\tokenmaxxing.exe",
      ),
    ).toBeNull();
  });
});

describe("serviceAutoUpdateCheck", () => {
  const base = {
    backend: "launchd" as const,
    commandPath: "/usr/local/bin/tokenmaxxing",
    installedAt: "2026-06-16T00:00:00.000Z",
    schedule: "daily",
    version: 1 as const,
  };
  const check = (
    metadata: ServiceMetadata | null,
    input: Partial<Parameters<typeof serviceAutoUpdateCheck>[1]> = {},
  ) =>
    serviceAutoUpdateCheck(metadata, {
      installed: true,
      manager: metadata?.autoUpdateManager,
      managerExists: true,
      ...input,
    });

  it("does not imply auto-update is enabled before service metadata exists", () => {
    expect(check(null, { installed: false })).toEqual({
      detail: "unknown (service not installed)",
      label: "auto-update",
      status: "info",
    });
    // Installed, but service.json is gone or garbage: the runner cannot auto-update.
    expect(check(null)).toEqual({
      detail: "off (service.json missing or unreadable); repair with tokenmaxxing service repair",
      fix: "repair with tokenmaxxing service repair",
      label: "auto-update",
      status: "warn",
    });
  });

  it("is OK via registry runner packages or a package manager on PATH", () => {
    expect(check({ ...base, autoUpdateManager: "registry" })).toEqual({
      detail: "enabled via registry runner packages",
      label: "auto-update",
      status: "ok",
    });
    expect(check({ ...base, autoUpdateManager: "npm" })).toMatchObject({
      detail: `enabled via npm (${autoUpdateCommandDescription("npm", "<version>")})`,
      status: "ok",
    });
    expect(check({ ...base, autoUpdateManager: "npm" }, { managerExists: false })).toMatchObject({
      detail: "enabled via npm, but npm is not on PATH; repair with tokenmaxxing service repair",
      status: "warn",
    });
    expect(check(base)).toMatchObject({
      detail:
        "enabled, but the package manager was not detected; repair with tokenmaxxing service repair",
      status: "warn",
    });
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
    const { installed, pointerWrites, runtime, runner, schedulerChanges, written } =
      makeInstallRuntime();

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
    // The scheduler decides whether to reload from what the file write changed.
    expect(schedulerChanges).toEqual([{ definition: false, wrapper: true }]);
    expect(pointerWrites).toEqual([{ paths: written[0]?.paths, runnerPath: runner.path }]);
    expect(written[0]?.metadata).toMatchObject({
      autoUpdateManager: "registry",
      commandPath: "/tmp/tokenmaxxing/service-runners/0.4.17/darwin-arm64/tokenmaxxing",
      installedAt: "2026-06-16T12:00:00.000Z",
      runnerTarget: "darwin-arm64",
      runnerVersion: "0.4.17",
      templateVersion: 8,
    });
    expect(written[0]?.metadata).not.toHaveProperty("autoUpdate");
    expect(state.logs).toContain("Automatic sync installed");
  });

  // W4 (F4): a task registered from an elevated shell can only be changed from one.
  // Measured with e2e/windows/elevation-probe.ps1 on the win11 VM and on
  // GitHub's Windows runners (see #116).
  it("refuses elevated shells whose user normally runs with a UAC-filtered token", () => {
    const high = "Mandatory Label\\High Mandatory Level Label S-1-16-12288";
    const medium = "Mandatory Label\\Medium Mandatory Level Label S-1-16-8192";
    const tmx = '"tmx-win11\\tmx","S-1-5-21-4004653193-2516152334-1041241692-1000"\r\n';
    const runneradmin =
      '"runnervm99s1a\\runneradmin","S-1-5-21-3162555376-3447873500-144036907-500"';
    const policies = (entries: string) =>
      `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\r\n${entries}`;
    const uacOn = policies(
      "    ConsentPromptBehaviorAdmin    REG_DWORD    0x0\r\n    EnableLUA    REG_DWORD    0x1\r\n",
    );
    const check = (groups: string | null, user: string | null, policy: string | null) =>
      windowsElevatedOverFilteredToken({ groups, policies: policy, user });

    // "Run as administrator" (elevation type Full) and an admin's SSH session (Default).
    expect(check(high, tmx, uacOn)).toBe(true);
    // Not elevated.
    expect(check(medium, tmx, uacOn)).toBe(false);
    // GitHub's runners: the built-in Administrator, which UAC does not filter.
    expect(check(high, runneradmin, uacOn)).toBe(false);
    // ... unless FilterAdministratorToken says so.
    expect(
      check(
        high,
        runneradmin,
        policies(
          "    EnableLUA    REG_DWORD    0x1\r\n    FilterAdministratorToken    REG_DWORD    0x1\r\n",
        ),
      ),
    ).toBe(true);
    // UAC off: every process of an administrator is elevated.
    expect(check(high, tmx, policies("    EnableLUA    REG_DWORD    0x0\r\n"))).toBe(false);
    // Unreadable policy: UAC's default is on.
    expect(check(high, tmx, null)).toBe(true);
    expect(check(null, tmx, uacOn)).toBe(false);
  });

  it("refuses to install from an elevated Windows shell", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_existing",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram(
        { force: false, refresh: false },
        { ...runtime, isElevated: () => Effect.succeed(true), platform: "win32" },
      ).pipe(Effect.provide(layer)),
    );

    expect(failureTag(exit)).toBe("ServiceElevatedError");
    expect(installed).toEqual([]);
  });

  it("keeps the original installedAt on a refresh, so an unchanged service.json stays put", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_existing",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { runtime, written } = makeInstallRuntime({
      metadata: {
        backend: "launchd",
        commandPath: "/tmp/old-runner",
        installedAt: "2026-06-01T08:00:00.000Z",
        schedule: "syncs every 5 minutes",
        templateVersion: 8,
        version: 1,
      },
    });

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: true }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(written[0]?.metadata.installedAt).toBe("2026-06-01T08:00:00.000Z");
  });

  it("writes the installing shell's source roots into the service wrapper", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_existing",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { runtime, written } = makeInstallRuntime({
      env: {
        CLAUDE_CONFIG_DIR: "/Users/alex/Claude Logs, extra",
        CODEX_HOME: "/Users/alex/Codex Logs",
        HERMES_HOME: "",
      },
    });

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: false }, runtime).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(written[0]?.wrapper).toContain(
      "export CLAUDE_CONFIG_DIR='/Users/alex/Claude Logs, extra'\n",
    );
    expect(written[0]?.wrapper).toContain("export CODEX_HOME='/Users/alex/Codex Logs'\n");
    expect(written[0]?.wrapper).not.toContain("HERMES_HOME");
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

  it("refuses a config dir with a control character before writing anything", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_existing",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    for (const platform of ["darwin", "linux"] as const) {
      const { installed, pointerWrites, runtime, written } = makeInstallRuntime({
        env: { TOKENMAXXING_CONFIG_DIR: "/home/alex/tab\there/tm" },
      });

      const exit = await Effect.runPromiseExit(
        serviceInstallProgram({ force: false, refresh: false }, { ...runtime, platform }).pipe(
          Effect.provide(layer),
        ),
      );

      expect(failureTag(exit)).toBe("ServiceConfigDirUnsupportedError");
      expect(written).toEqual([]);
      expect(pointerWrites).toEqual([]);
      expect(installed).toEqual([]);
    }
  });

  it("refuses a config dir with a control character before asking to log in", async () => {
    // Windows can't create such a dir, so it never holds a login; the refusal
    // must come first, not "not logged in".
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime({
      env: { TOKENMAXXING_CONFIG_DIR: "/home/alex/tab\there/tm" },
    });

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram(
        { force: false, json: true, refresh: false },
        { ...runtime, platform: "linux" },
      ).pipe(Effect.provide(layer)),
    );

    expect(failureTag(exit)).toBe("ServiceConfigDirUnsupportedError");
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

  it("detects npm's Windows prefix shims by the package next to them", async () => {
    // npm on Windows puts tokenmaxxing.cmd straight in the prefix
    // (%APPDATA%\npm or --prefix), which matches no path pattern; the upgrade
    // e2e caught `tokenmaxxing upgrade` failing with UpgradeManagerError there.
    const prefix = await mkdtemp(join(tmpdir(), "tokenmaxxing-npm-prefix-"));
    try {
      const shim = join(prefix, "tokenmaxxing.cmd");
      expect(detectAutoUpdateManager({ commandPath: shim, resolvedCommandPath: shim })).toBeNull();
      expect(await isWindowsNpmPrefixShim(shim, "win32")).toBe(false);

      await mkdir(join(prefix, "node_modules", "@851-labs", "tokenmaxxing"), { recursive: true });
      await writeFile(
        join(prefix, "node_modules", "@851-labs", "tokenmaxxing", "package.json"),
        "{}",
      );
      expect(await isWindowsNpmPrefixShim(shim, "win32")).toBe(true);
      expect(await isWindowsNpmPrefixShim(shim, "linux")).toBe(false);
    } finally {
      await rm(prefix, { force: true, recursive: true });
    }
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

describe("a service newer than this CLI", () => {
  const metadata: ServiceMetadata = {
    autoUpdateManager: "registry",
    backend: "launchd",
    commandPath: "/tmp/tokenmaxxing/service-runners/0.7.1/darwin-arm64/tokenmaxxing",
    installedAt: "2026-06-16T09:00:00.000Z",
    runnerTarget: "darwin-arm64",
    runnerVersion: "0.7.0",
    schedule: "syncs every 5 minutes",
    templateVersion: 8,
    version: 1,
  };

  it("names what a newer release wrote", () => {
    expect(serviceNewerThanCli(metadata, "0.7.0")).toBeNull();
    expect(serviceNewerThanCli(null, "0.7.0")).toBeNull();
    expect(serviceNewerThanCli({ ...metadata, runnerVersion: "0.7.1" }, "0.7.0")).toEqual({
      runner: { cli: "0.7.0", installed: "0.7.1" },
      template: undefined,
    });
    const newer = serviceNewerThanCli(
      { ...metadata, runnerVersion: "0.8.0", templateVersion: 9 },
      "0.7.0",
    );
    expect(newer).toEqual({
      runner: { cli: "0.7.0", installed: "0.8.0" },
      template: { cli: 8, installed: 9 },
    });
    expect(new ServiceNewerThanCliError({ command: "repair", newer: newer! }).message).toBe(
      "error: the service is newer than this CLI (template 9 vs 8, runner 0.8.0 vs 0.7.0)\nhint: upgrade the CLI with tokenmaxxing upgrade, then run tokenmaxxing service repair again if it is still needed",
    );
  });

  it("doctor says to upgrade the CLI, not to reload", () => {
    expect(doctorTemplateCheck({ ...metadata, templateVersion: 9 }, false)).toEqual({
      detail:
        "the service is newer than this CLI (template 9 vs 8); upgrade the CLI with tokenmaxxing upgrade",
      fix: "upgrade the CLI with tokenmaxxing upgrade",
      label: "template",
      status: "warn",
    });
    expect(doctorTemplateCheck({ ...metadata, templateVersion: 7 }, true)).toEqual({
      detail: "reload required; repair with tokenmaxxing service repair",
      fix: "repair with tokenmaxxing service repair",
      label: "template",
      status: "warn",
    });
    expect(doctorTemplateCheck(metadata, false).status).toBe("ok");
    expect(doctorTemplateCheck({ ...metadata, runnerVersion: "99.0.0" }, false).status).toBe("ok");
  });

  it("status says so instead of 'Reload required: yes', and flags a broken runner", () => {
    const base = { runnerIssue: null, runnerTarget: "darwin-arm64", runnerVersion: "0.8.0" };
    expect(
      serviceStatusRunnerLines({
        ...base,
        newerThanCli: { template: { cli: 7, installed: 8 } },
      }),
    ).toEqual([
      "The service is newer than this CLI (template 8 vs 7); upgrade the CLI with tokenmaxxing upgrade",
      "Runner: 0.8.0 (darwin-arm64)",
    ]);
    // A runner that auto-updated past the global CLI is normal, as in doctor.
    expect(
      serviceStatusRunnerLines({
        ...base,
        newerThanCli: { runner: { cli: "0.7.0", installed: "0.8.0" } },
      }),
    ).toEqual(["Runner: 0.8.0 (darwin-arm64)"]);
    expect(
      serviceStatusRunnerLines({
        ...base,
        newerThanCli: null,
        runnerIssue: "runner is empty (0 bytes): /tmp/tm/service-runners/0.8.0/tokenmaxxing",
      }),
    ).toEqual([
      "Runner: runner is empty (0 bytes): /tmp/tm/service-runners/0.8.0/tokenmaxxing; repair with tokenmaxxing service repair",
    ]);
  });

  it("install --refresh refuses to move a newer template back", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_stored",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, pointerWrites, runtime, written } = makeInstallRuntime({
      metadata: { ...metadata, templateVersion: 99 },
    });

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ force: false, refresh: true }, runtime).pipe(Effect.provide(layer)),
    );

    expect(failureTag(exit)).toBe("ServiceNewerThanCliError");
    expect(written).toEqual([]);
    expect(pointerWrites).toEqual([]);
    expect(installed).toEqual([]);
  });
});

describe("repair reasons", () => {
  it("reports a manual repair with nothing wrong as manual, not as the last repair", () => {
    expect(
      serviceRepairReasons({ deferred: false, detected: undefined, last: "service-failure" }),
    ).toEqual({ reason: "reload-required", reported: "manual" });
    expect(
      serviceRepairReasons({ deferred: false, detected: "scheduler-inactive", last: undefined }),
    ).toEqual({ reason: "scheduler-inactive", reported: "scheduler-inactive" });
    // A deferred repair carries on the reason it was scheduled with.
    expect(
      serviceRepairReasons({ deferred: true, detected: undefined, last: "auto-updated" }),
    ).toEqual({ reason: "auto-updated", reported: "auto-updated" });
  });
});

describe("serviceLockCheck", () => {
  const paths = servicePaths({
    env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
    home: "/Users/alex",
    platform: "darwin",
  })!;
  // Far above any real pid, so it is gone on this machine.
  const deadPid = 2 ** 22 + 12_345;
  const held = (hostname: string | undefined, pid = deadPid, stale = false): ServiceLockStatus => ({
    acquiredAt: "2026-06-16T10:00:00.000Z",
    hostname,
    locked: true,
    pid,
    stale,
  });
  const lockCheck = (status: ServiceLockStatus, host = "mac") =>
    Effect.runPromise(serviceLockCheck(paths, status, host));

  it("is OK with no lock", async () => {
    await expect(lockCheck({ locked: false, stale: false })).resolves.toEqual({
      detail: "none",
      label: "lock",
      status: "ok",
    });
  });

  it("only promises a takeover for a dead pid on this machine", async () => {
    await expect(lockCheck(held("mac"), "MAC")).resolves.toEqual({
      detail: `held (since 2026-06-16T10:00:00.000Z, pid ${deadPid}); pid ${deadPid} is gone, so the next run takes it over`,
      label: "lock",
      status: "info",
    });
    await expect(lockCheck(held(undefined))).resolves.toMatchObject({
      detail: expect.stringContaining("the next run takes it over"),
      status: "info",
    });
    await expect(lockCheck(held("linux-box"))).resolves.toEqual({
      detail: `held (since 2026-06-16T10:00:00.000Z, pid ${deadPid}); held by linux-box, where a sync may be running; runs here skip until it is released`,
      label: "lock",
      status: "info",
    });
  });

  it("is fine while a sync holds it, and warns once a live process held it too long", async () => {
    await expect(lockCheck(held("mac", process.pid))).resolves.toEqual({
      detail: `held (since 2026-06-16T10:00:00.000Z, pid ${process.pid}); a sync is running`,
      label: "lock",
      status: "info",
    });
    await expect(lockCheck(held("mac", process.pid, true))).resolves.toEqual({
      detail: `held (since 2026-06-16T10:00:00.000Z, pid ${process.pid}) (stale); pid ${process.pid} on this machine has held it for over 2 hours, so every run skips; if it is not a tokenmaxxing sync, remove ${paths.lockPath}`,
      fix: `if it is not a tokenmaxxing sync, remove ${paths.lockPath}`,
      label: "lock",
      status: "warn",
    });
    // A stale lock whose process is gone is simply taken over.
    await expect(lockCheck(held("mac", deadPid, true))).resolves.toMatchObject({
      status: "info",
    });
  });
});

describe("service doctor", () => {
  const platforms = ["darwin", "linux", "win32"] as const;
  const repair = "repair with tokenmaxxing service repair";

  function healthyFacts(platform: (typeof platforms)[number]): ServiceDoctorFacts {
    const home = platform === "win32" ? "C:\\Users\\alex" : "/home/alex";
    const configDir = platform === "win32" ? "C:\\tm" : "/tmp/tm";
    const env = {
      CODEX_HOME: `${home}/codex`,
      PATH: "/usr/bin",
      TOKENMAXXING_CONFIG_DIR: configDir,
    };
    const paths = servicePaths({ env, home, platform })!;
    const runnerPath = join(paths.runnersDir, "0.7.0", "target", "tokenmaxxing");
    const metadata: ServiceMetadata = {
      autoUpdateManager: "registry",
      backend: paths.backend,
      commandPath: runnerPath,
      installedAt: "2026-06-16T09:00:00.000Z",
      runnerTarget: "target",
      runnerVersion: "0.7.0",
      schedule: "syncs every 5 minutes",
      templateVersion: 8,
      version: 1,
    };
    const launcherPath = windowsLauncherPath(paths);

    return {
      authConfig: { _tag: "success", value: { deviceId: "device_1", token: "tmx_1" } },
      autoUpdate: serviceAutoUpdateCheck(metadata, {
        installed: true,
        manager: "registry",
        managerExists: true,
      }),
      definitionExists: true,
      env,
      envToken: false,
      installed: true,
      launcher: launcherPath === null ? null : { path: launcherPath, status: "current" },
      lock: { detail: "none", label: "lock", status: "ok" },
      metadata,
      metadataCommandExists: true,
      nativeStatus: { active: true, command: "scheduler query", detail: "active" },
      owner: "this",
      paths,
      reloadRequired: false,
      runner: { _tag: "ok", path: runnerPath },
      state: { lastSuccessAt: "2026-06-16T10:00:00.000Z", version: 1 },
      wrapper: renderServiceWrapper({
        env: capturedServiceEnv(env, platform),
        logPath: paths.logPath,
        platform,
        runnerPointerPath: paths.runnerPointerPath,
      }),
    };
  }

  function report(checks: readonly DoctorCheck[], json = false) {
    const logs: string[] = [];
    return Effect.runPromiseExit(
      reportServiceDoctor(
        {
          checks,
          recentLog: [],
          reloadRequired: false,
          scheduler: healthyFacts("linux").nativeStatus,
          state: null,
        },
        { json },
      ).pipe(
        Effect.provideService(ConsoleService, {
          error: () => undefined,
          log: (message?: unknown) => {
            logs.push(String(message));
          },
        }),
      ),
    ).then((exit) => ({ exit, logs }));
  }

  function problemsMessage(exit: Exit.Exit<void, unknown>): string | undefined {
    if (exit._tag !== "Failure") {
      return undefined;
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    return failure?.error instanceof ServiceDoctorProblemsError ? failure.error.message : undefined;
  }

  // Would a script see a problem? Only WARN and FAIL lines say how to fix one.
  function expectNoHintsOnFineLines(checks: readonly DoctorCheck[]) {
    for (const check of checks.filter((c) => c.status === "ok" || c.status === "info")) {
      expect(check.fix, doctorLineFor(check)).toBeUndefined();
      expect(doctorLineFor(check)).not.toMatch(
        /\b(repair|retry|upgrade the CLI|install) with\b|\brun tokenmaxxing\b/,
      );
    }
  }

  function doctorLineFor(check: DoctorCheck) {
    return `${check.status} ${check.label} ${check.detail}`;
  }

  it.each(platforms)("exits 0 on a healthy %s install, every check OK", async (platform) => {
    const checks = serviceDoctorChecks(healthyFacts(platform));

    expect(checks.filter((check) => check.status !== "ok")).toEqual([
      { detail: "none", label: "last repair", status: "info" },
    ]);
    expect(checks.map((check) => check.label)).toEqual([
      "scheduler",
      "active",
      "template",
      "definition",
      "wrapper",
      ...(platform === "win32" ? ["launcher"] : []),
      "source roots",
      "runner",
      "metadata",
      "binary",
      "auto-update",
      "auth",
      "lock",
      "last success",
      "last error",
      "last repair",
    ]);
    expect(serviceDoctorHealth(checks)).toBe("ok");
    expectNoHintsOnFineLines(checks);

    const { exit, logs } = await report(checks);
    expect(exit._tag).toBe("Success");
    expect(logs).toContain("OK   active       active");
    expect(logs).toContain("INFO last repair  none");
  });

  it.each(platforms)("stays at exit 0 in fine but informational %s states", async (platform) => {
    const paths = healthyFacts(platform).paths;
    const liveLock = await Effect.runPromise(
      serviceLockCheck(paths, {
        acquiredAt: new Date().toISOString(),
        locked: true,
        pid: process.pid,
        stale: false,
      }),
    );
    const deadLock = await Effect.runPromise(
      serviceLockCheck(paths, {
        acquiredAt: new Date().toISOString(),
        locked: true,
        pid: 2 ** 22 + 12_345,
        stale: false,
      }),
    );
    const states: Array<Partial<ServiceDoctorFacts>> = [
      // Installed, never synced yet.
      { state: null },
      // A scheduled run holds the lock right now.
      { lock: liveLock },
      // A killed run's lock, which the next run takes over.
      { lock: deadLock },
      // The runner auto-updated past the global CLI.
      {
        metadata: { ...healthyFacts(platform).metadata!, runnerVersion: "99.0.0" },
      },
      {
        state: {
          lastRepairReason: "auto-updated",
          lastRepairStatus: "success",
          lastSuccessAt: "2026-06-16T10:00:00.000Z",
          version: 1,
        },
      },
      { authConfig: { _tag: "success", value: { token: "tmx_1" } } },
    ];

    for (const overrides of states) {
      const checks = serviceDoctorChecks({ ...healthyFacts(platform), ...overrides });
      expect(checks.filter((check) => check.status === "warn" || check.status === "fail")).toEqual(
        [],
      );
      expectNoHintsOnFineLines(checks);
      expect((await report(checks)).exit._tag).toBe("Success");
    }
  });

  it.each(platforms)("exits 1 on a %s WARN, with its fix as the hint", async (platform) => {
    const checks = serviceDoctorChecks({
      ...healthyFacts(platform),
      state: {
        lastError:
          "no usage synced; ccusage failed for claude\nclaude: ccusage command failed: npm error 401 Unauthorized",
        version: 1,
      },
    });

    expect(checks.find((check) => check.label === "last error")).toEqual({
      detail:
        "no usage synced; ccusage failed for claude; retry with tokenmaxxing service run to see why",
      fix: "retry with tokenmaxxing service run to see why",
      label: "last error",
      status: "warn",
    });
    expect(serviceDoctorHealth(checks)).toBe("warn");
    expectNoHintsOnFineLines(checks);

    const { exit, logs } = await report(checks);
    expect(problemsMessage(exit)).toBe(
      "error: service doctor found 1 warning (last error)\nhint: retry with tokenmaxxing service run to see why",
    );
    expect(logs).toContain(
      "WARN last error   no usage synced; ccusage failed for claude; retry with tokenmaxxing service run to see why",
    );
  });

  it("shows the first line of a failed run's error", () => {
    const checks = serviceDoctorChecks({
      ...healthyFacts("darwin"),
      state: {
        lastError:
          "SyncAuthValidationError: error: failed to validate stored login\nhint: check your network and run tokenmaxxing sync again",
        version: 1,
      },
    });

    expect(checks.find((check) => check.label === "last error")?.detail).toBe(
      "failed to validate stored login; retry with tokenmaxxing service run to see why",
    );
    expect(
      formatServiceLastError(
        "no usage synced; ccusage failed for claude\nclaude: ccusage command failed: npm error 401 Unauthorized",
      ),
    ).toBe("no usage synced; ccusage failed for claude");
  });

  it.each(platforms)("exits 1 on a %s FAIL, and counts every problem", async (platform) => {
    const facts = healthyFacts(platform);
    const broken = serviceDoctorChecks({
      ...facts,
      nativeStatus: { active: false, command: "scheduler query", detail: "inactive (exit 3)" },
      runner: { _tag: "broken", detail: `runner missing: ${facts.metadata!.commandPath}` },
    });

    expect(broken.filter((check) => check.status === "fail")).toEqual([
      {
        detail: `inactive (exit 3); ${repair}`,
        fix: repair,
        label: "active",
        status: "fail",
      },
      {
        detail: `runner missing: ${facts.metadata!.commandPath}; ${repair}`,
        fix: repair,
        label: "runner",
        status: "fail",
      },
    ]);
    expect(serviceDoctorHealth(broken)).toBe("fail");
    expectNoHintsOnFineLines(broken);
    expect(problemsMessage((await report(broken)).exit)).toBe(
      `error: service doctor found 2 failures (active, runner)\nhint: ${repair}`,
    );

    const mixed = serviceDoctorChecks({
      ...facts,
      authConfig: { _tag: "success", value: {} },
      reloadRequired: true,
    });
    expect(serviceDoctorHealth(mixed)).toBe("fail");
    expect(problemsMessage((await report(mixed)).exit)).toBe(
      "error: service doctor found 1 failure (auth) and 1 warning (template)\nhint: each FAIL and WARN check says how to fix it",
    );
  });

  it.each(platforms)("says to install when nothing is installed for %s", (platform) => {
    const facts = healthyFacts(platform);
    const checks = serviceDoctorChecks({
      ...facts,
      installed: false,
      metadata: null,
      owner: "none",
      state: null,
      wrapper: null,
    });

    expect(checks.map((check) => `${check.status} ${check.label}`)).toEqual([
      "fail scheduler",
      "ok auth",
      "ok lock",
      "info last success",
      "ok last error",
      "info last repair",
    ]);
    expect(checks[0]).toEqual({
      detail: `not installed (${facts.paths.backend}); install with tokenmaxxing service install`,
      fix: "install with tokenmaxxing service install",
      label: "scheduler",
      status: "fail",
    });
    // The scheduler job belongs to another config dir: a repair here refuses.
    expect(serviceDoctorChecks({ ...facts, owner: "other" })[0]).toMatchObject({
      fix: "set TOKENMAXXING_CONFIG_DIR to that service's config dir",
      status: "fail",
    });
  });

  it("names a partial install's missing files, each fixed by repair", () => {
    const facts = healthyFacts("darwin");
    const checks = serviceDoctorChecks({
      ...facts,
      definitionExists: false,
      installed: false,
      metadataCommandExists: false,
      wrapper: null,
    });

    expect(
      checks.filter((check) => check.status === "fail" || check.status === "warn"),
    ).toMatchObject([
      { detail: `not installed (launchd); ${repair}`, label: "scheduler", status: "fail" },
      { detail: `missing: ${facts.paths.definitionPath}; ${repair}`, label: "definition" },
      { detail: `missing: ${facts.paths.wrapperPath}; ${repair}`, label: "wrapper" },
      { detail: `missing: ${facts.metadata!.commandPath}; ${repair}`, label: "binary" },
    ]);
    expect(checks.find((check) => check.label === "source roots")).toEqual({
      detail: "not checked (wrapper missing)",
      label: "source roots",
      status: "info",
    });
  });

  it("reports the verdict in --json next to the command's own status", async () => {
    const healthy = await report(serviceDoctorChecks(healthyFacts("linux")), true);
    expect(healthy.exit._tag).toBe("Success");
    expect(JSON.parse(healthy.logs[0]!)).toMatchObject({ health: "ok", status: "ok" });

    const warned = await report(
      serviceDoctorChecks({ ...healthyFacts("linux"), reloadRequired: true }),
      true,
    );
    expect(problemsMessage(warned.exit)).toContain("1 warning (template)");
    const json = JSON.parse(warned.logs[0]!) as { checks: DoctorCheck[]; health: string };
    expect(json.health).toBe("warn");
    expect(json.checks.find((check) => check.label === "template")).toEqual({
      detail: `reload required; ${repair}`,
      fix: repair,
      label: "template",
      status: "warn",
    });
    expect(new ServiceDoctorProblemsError({ checks: json.checks }).jsonFields).toEqual({
      health: "warn",
    });
  });
});
