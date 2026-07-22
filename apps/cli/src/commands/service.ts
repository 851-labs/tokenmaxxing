import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, homedir, hostname } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type {
  ServiceAutoUpdateManagerValue,
  ServiceAutoUpdateReasonValue,
  ServiceAutoUpdateStatusValue,
  ServiceCheckInStatusValue,
  ServiceRepairReasonValue,
  ServiceRepairStatusValue,
} from "@tokenmaxxing/api-contract";

import { ClockService, ConfigService, ConsoleService } from "../services";
import { getConfigPath } from "../services/config";
import { humanFrame, humanLog, humanSpinner, writeJson } from "../output";
import packageJson from "../../package.json";
import {
  parseServiceRunnerTarget,
  platformForServiceRunnerTarget,
  serviceRunnerBinaryName,
  serviceRunnerPackageName,
  serviceRunnerTarget,
  serviceRunnerTargetCandidates,
  serviceRunnerTargets,
  type ServiceRunnerHostOptions,
  type ServiceRunnerTarget,
} from "../service-runner-targets";
import {
  resolveSyncAuth,
  syncProgram,
  type SyncAuth,
  type SyncResult,
  type SyncSourceIssue,
  type SyncStatus,
  type UploadRetryPolicy,
} from "./sync";

const execFilePromise = promisify(execFile);
const gunzipPromise = promisify(gunzip);
const require = createRequire(import.meta.url);

const SERVICE_LABEL = "sh.tokenmaxxing.sync";
const SERVICE_TEMPLATE_VERSION = 5;
const SYSTEMD_NAME = "tokenmaxxing-sync";
const WINDOWS_TASK_NAME = "tokenmaxxing-sync";
const POSIX_WRAPPER_NAME = "tokenmaxxing.sh";
const LEGACY_POSIX_WRAPPER_NAME = "service-sync.sh";
const WINDOWS_WRAPPER_NAME = "service-sync.cmd";
const PACKAGE_NAME = "@851-labs/tokenmaxxing";
const SERVICE_RUNNER_DIR_NAME = "service-runners";
const SERVICE_RUNNER_POINTER_NAME = "service-runner-current";
const SERVICE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const SERVICE_INTERVAL_MINUTES = 5;
const SERVICE_INTERVAL_SECONDS = SERVICE_INTERVAL_MINUTES * 60;
const SERVICE_JITTER_MAX_MS = 60 * 1000;
const SERVICE_API_TIMEOUT_MS = 60 * 1000;
const SERVICE_FETCH_TIMEOUT_MS = 15 * 1000;
const SERVICE_COMMAND_TIMEOUT_MS = 60 * 1000;
const SERVICE_PACKAGE_UPDATE_TIMEOUT_MS = 4 * 60 * 1000;
const SERVICE_VERSION_TIMEOUT_MS = 30 * 1000;
const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const SERVICE_LOG_ROTATIONS = 3;
const NPM_LATEST_URL = "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing/latest";
const SERVICE_UPLOAD_RETRY_POLICY: UploadRetryPolicy = {
  attempts: 3,
  backoffMs: [1_000, 4_000, 16_000],
  jitterRatio: 0.2,
  timeoutMs: 60_000,
};
const LEGACY_SCHEDULE_TIMES: readonly ScheduleTime[] = [
  { hour: 9, minute: 0 },
  { hour: 13, minute: 0 },
  { hour: 17, minute: 0 },
  { hour: 21, minute: 0 },
];

type ServiceBackend = "launchd" | "systemd" | "windows-task-scheduler";
type AutoUpdateManager = "bun" | "npm" | "pnpm" | "yarn";
type ServiceMetadataAutoUpdateManager = AutoUpdateManager | "registry";

interface CommandInstall {
  autoUpdateManager: AutoUpdateManager | null;
  commandPath: string;
  resolvedCommandPath: string;
}

interface ScheduleTime {
  hour: number;
  minute: number;
}

interface ServiceInstallOptions {
  force: boolean;
  json?: boolean | undefined;
  refresh: boolean;
}

interface ServicePaths {
  backend: ServiceBackend;
  configDir: string;
  definitionPath: string | null;
  lockPath: string;
  logPath: string;
  metadataPath: string;
  runnerPointerPath: string;
  runnersDir: string;
  statePath: string;
  updateLockPath: string;
  wrapperPath: string;
}

interface ServiceLock {
  acquiredAt: string;
  ownerId: string;
  pid: number;
  version: 1;
}

type ServiceRunLock =
  | {
      lock: ServiceLock;
      _tag: "acquired";
    }
  | {
      status: ServiceLockStatus;
      _tag: "locked";
    };

type ServiceLockStatus =
  | {
      locked: false;
      stale: false;
    }
  | {
      acquiredAt?: string;
      ageMs?: number;
      locked: true;
      pid?: number;
      stale: boolean;
    };

interface ServiceMetadata {
  autoUpdateManager?: ServiceMetadataAutoUpdateManager | null;
  backend: ServiceBackend;
  commandPath: string;
  resolvedCommandPath?: string | undefined;
  installedAt: string;
  runnerPackage?: string | undefined;
  runnerPath?: string | undefined;
  runnerTarget?: string | undefined;
  runnerVersion?: string | undefined;
  schedule: string;
  templateVersion?: number | undefined;
  version: 1;
}

interface ServiceRunOptions {
  force: boolean;
  json?: boolean | undefined;
  scheduled: boolean;
}

interface ServiceAutoUpdateReport {
  attemptedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  currentVersion?: string | null | undefined;
  enabled: boolean;
  error?: string | null | undefined;
  installedVersion?: string | null | undefined;
  latestVersion?: string | null | undefined;
  manager: ServiceAutoUpdateManagerValue | null;
  reason: ServiceAutoUpdateReasonValue | null;
  status: ServiceAutoUpdateStatusValue;
}

interface ServiceAutoUpdateRuntime {
  commandExists?: ((command: string) => Effect.Effect<boolean, never>) | undefined;
  fetchLatestVersion?: (() => Effect.Effect<string | null, never>) | undefined;
  fetchRunnerRelease?:
    | ((
        target: ServiceRunnerTarget,
        versionSpecifier: string,
      ) => Effect.Effect<ServiceRunnerRelease | null, ServiceRunnerUpdateError>)
    | undefined;
  installRunnerRelease?:
    | ((
        release: ServiceRunnerRelease,
        paths: ServicePaths,
      ) => Effect.Effect<ServiceRunnerInstall, unknown>)
    | undefined;
  now?: (() => Date) | undefined;
  readInstalledVersion?: ((commandPath: string) => Effect.Effect<string | null, never>) | undefined;
  runnerTargetCandidates?: (() => readonly ServiceRunnerTarget[]) | undefined;
  runPackageManagerUpdate?:
    | ((manager: AutoUpdateManager) => Effect.Effect<void, unknown>)
    | undefined;
}

interface ServiceRepairOptions {
  deferred?: boolean | undefined;
  json?: boolean | undefined;
  reason?: string | undefined;
}

interface ServiceState {
  lastArch?: string;
  lastAttemptAt?: string;
  lastAutoUpdate?: ServiceAutoUpdateReport;
  lastAutoUpdated?: boolean;
  lastCliVersion?: string;
  lastDurationMs?: number;
  lastError?: string;
  lastRepairAttemptAt?: string;
  lastRepairCompletedAt?: string;
  lastRepairError?: string;
  lastRepairReason?: ServiceRepairReasonValue;
  lastRepairStatus?: ServiceRepairStatusValue;
  lastRows?: number;
  lastSchedulerActive?: boolean;
  lastSince?: string;
  lastSources?: ServiceSourceState[];
  lastSyncStatus?: SyncStatus;
  lastSuccessAt?: string;
  lastSuccessDate?: string;
  lastUpserted?: number;
  reloadRequired?: boolean;
  version: 1;
}

interface ServiceSourceState {
  days?: number;
  issue?: SyncSourceIssue;
  models?: number;
  rows?: number;
  sessions?: number | null;
  source: string;
  spendUsd?: number;
  status: "failed" | "partial" | "skipped" | "synced";
}

interface ServiceLogWriter {
  log: (message?: unknown) => void;
}

interface ServiceNativeSchedulerStatus {
  active: boolean;
  command: string;
  detail: string;
}

interface ServiceCheckIn {
  autoUpdate?: ServiceAutoUpdateReport | undefined;
  backend: ServiceBackend;
  error?: string | undefined;
  reloadRequired: boolean;
  repairAttemptedAt?: string | undefined;
  repairCompletedAt?: string | undefined;
  repairError?: string | undefined;
  repairReason?: ServiceRepairReasonValue | undefined;
  repairStatus?: ServiceRepairStatusValue | undefined;
  runnerTarget?: string | undefined;
  runnerVersion?: string | undefined;
  schedulerActive: boolean;
  status: ServiceCheckInStatusValue;
}

interface ServiceRunnerInstall {
  packageName: string;
  path: string;
  target: ServiceRunnerTarget;
  version: string;
}

interface ServiceRunnerRelease {
  integrity: string;
  packageName: string;
  tarballUrl: string;
  target: ServiceRunnerTarget;
  version: string;
}

interface ServiceRepairReport {
  attemptedAt: string;
  completedAt?: string | undefined;
  error?: string | undefined;
  reason: ServiceRepairReasonValue;
  status: ServiceRepairStatusValue;
}

type DoctorAuthConfig =
  | {
      cause: unknown;
      _tag: "error";
    }
  | {
      value: {
        deviceId?: string;
        token?: string;
      };
      _tag: "success";
    };

type DoctorStatus = "info" | "ok" | "warn";

interface DoctorCheck {
  detail: string;
  label: string;
  status: DoctorStatus;
}

class ServiceUnsupportedPlatformError extends Data.TaggedError("ServiceUnsupportedPlatformError")<{
  readonly platform: NodeJS.Platform;
}> {
  override get message() {
    return `error: service install is not supported on ${this.platform}\nhint: supported platforms are macOS, Linux, and Windows`;
  }
}

class ServiceEnvTokenError extends Data.TaggedError("ServiceEnvTokenError")<{}> {
  override message =
    "error: service install needs a stored login, not TOKENMAXXING_API_TOKEN\nhint: unset TOKENMAXXING_API_TOKEN, run tokenmaxxing login, then run tokenmaxxing service install";
}

class ServiceCommandNotFoundError extends Data.TaggedError("ServiceCommandNotFoundError")<{}> {
  override message =
    "error: tokenmaxxing is not installed globally\nhint: install it with bun, npm, pnpm, or yarn, then run tokenmaxxing service install";
}

class ServiceEphemeralCommandError extends Data.TaggedError("ServiceEphemeralCommandError")<{
  readonly commandPath: string;
}> {
  override get message() {
    return `error: tokenmaxxing resolved to a temporary runner path\npath: ${this.commandPath}\nhint: install it globally with bun, npm, pnpm, or yarn, then run tokenmaxxing service install`;
  }
}

class ServiceRunnerUnsupportedTargetError extends Data.TaggedError(
  "ServiceRunnerUnsupportedTargetError",
)<{
  readonly arch: string;
  readonly platform: NodeJS.Platform;
}> {
  override get message() {
    return `error: tokenmaxxing service runner is not available for ${this.platform}/${this.arch}\nhint: supported runners are ${serviceRunnerTargets.join(", ")}`;
  }
}

class ServiceRunnerPackageMissingError extends Data.TaggedError(
  "ServiceRunnerPackageMissingError",
)<{
  readonly packageName?: string | undefined;
  readonly packageNames?: readonly string[] | undefined;
}> {
  override get message() {
    const packageNames =
      this.packageNames ?? (this.packageName === undefined ? [] : [this.packageName]);
    const packageList =
      packageNames.length === 0
        ? "for this platform"
        : packageNames.map((name) => `\`${name}\``).join(", ");
    return `error: missing service runner package ${packageList}\nhint: reinstall @851-labs/tokenmaxxing or retry so tokenmaxxing can fetch the platform runner package`;
  }
}

class ServiceRunnerUpdateError extends Data.TaggedError("ServiceRunnerUpdateError")<{
  readonly cause: unknown;
  readonly reason: Extract<
    ServiceAutoUpdateReasonValue,
    "download-failed" | "integrity-mismatch" | "install-failed" | "platform-package-missing"
  >;
}> {}

class ServiceUpdateLockedError extends Data.TaggedError("ServiceUpdateLockedError")<{
  readonly status: ServiceLockStatus;
}> {
  override get message() {
    return `service repair/update already in progress${formatServiceLockSince(this.status as Extract<ServiceLockStatus, { locked: true }>)}`;
  }
}

class ServiceInstallError extends Data.TaggedError("ServiceInstallError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to install tokenmaxxing service\nhint: rerun with --verbose or install manually from the generated files";
}

class ServiceUninstallError extends Data.TaggedError("ServiceUninstallError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to uninstall tokenmaxxing service\nhint: rerun with --verbose and remove the scheduler entry manually";
}

class ServiceRunError extends Data.TaggedError("ServiceRunError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: tokenmaxxing service run failed\nhint: inspect the service log for details";
}

class ServiceRepairError extends Data.TaggedError("ServiceRepairError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to repair tokenmaxxing service\nhint: rerun tokenmaxxing service doctor --verbose";
}

const installCommand = Command.make(
  "install",
  {
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Deprecated; service install uses a managed runner"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    refresh: Flag.boolean("refresh").pipe(Flag.withHidden),
  },
  ({ force, json, refresh }) => serviceInstallEffect({ force, json, refresh }),
).pipe(Command.withDescription("Install automatic sync"));

const uninstallCommand = Command.make(
  "uninstall",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceUninstallEffect({ json }),
).pipe(Command.withDescription("Uninstall automatic sync"));

const statusCommand = Command.make(
  "status",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceStatusEffect({ json }),
).pipe(Command.withDescription("Show automatic sync service status"));

const doctorCommand = Command.make(
  "doctor",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceDoctorEffect({ json }),
).pipe(Command.withDescription("Check automatic sync service health"));

const repairCommand = Command.make(
  "repair",
  {
    deferred: Flag.boolean("deferred").pipe(Flag.withHidden),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    reason: Flag.string("reason").pipe(Flag.optional, Flag.withHidden),
  },
  ({ deferred, json, reason }) =>
    serviceRepairEffect({ deferred, json, reason: Option.getOrUndefined(reason) }),
).pipe(Command.withDescription("Repair automatic sync scheduling"));

const runCommand = Command.make(
  "run",
  {
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Deprecated; service runs sync every time"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    scheduled: Flag.boolean("scheduled").pipe(Flag.withHidden),
  },
  ({ force, json, scheduled }) => serviceRunEffect({ force, json, scheduled }),
).pipe(Command.withDescription("Run the automatic sync job now"));

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage automatic sync"),
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    statusCommand,
    doctorCommand,
    repairCommand,
    runCommand,
  ]),
);

function serviceInstallEffect(options: ServiceInstallOptions) {
  return humanFrame("Install automatic sync", options, serviceInstallProgram(options));
}

function serviceInstallProgram(
  options: ServiceInstallOptions,
  runtime: {
    env?: Record<string, string | undefined>;
    findCommandInstall?: () => Effect.Effect<CommandInstall | null, unknown>;
    home?: string;
    installScheduler?: (paths: ServicePaths) => Effect.Effect<void, unknown>;
    installServiceRunner?: (paths: ServicePaths) => Effect.Effect<ServiceRunnerInstall, unknown>;
    now?: Date;
    platform?: NodeJS.Platform;
    writeFiles?: (
      paths: ServicePaths,
      wrapper: string,
      metadata: ServiceMetadata,
    ) => Effect.Effect<void, unknown>;
    writeRunnerPointer?: (paths: ServicePaths, runnerPath: string) => Effect.Effect<void, unknown>;
  } = {},
) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);

    if (!options.refresh && (yield* config.hasEnvToken())) {
      return yield* Effect.fail(new ServiceEnvTokenError());
    }

    if (!options.refresh) {
      yield* resolveSyncAuth({ json: options.json === true });
    }

    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const paths = yield* servicePathsEffect(env, runtime.home, platform);
    const installSpinner = yield* humanSpinner("Detecting tokenmaxxing install", options);
    yield* (
      runtime.findCommandInstall ?? (() => findTokenmaxxingCommandInstall(env, platform))
    )().pipe(
      Effect.flatMap((install) =>
        install === null ? Effect.fail(new ServiceCommandNotFoundError()) : Effect.succeed(install),
      ),
      Effect.tapError(() =>
        Effect.sync(() => installSpinner.error("Could not find tokenmaxxing install")),
      ),
    );
    yield* Effect.sync(() => installSpinner.stop("Found tokenmaxxing install"));

    const updateLock = yield* acquireServiceUpdateLock(
      paths.updateLockPath,
      runtime.now ?? new Date(),
    ).pipe(Effect.mapError((cause) => new ServiceInstallError({ cause })));
    if (updateLock._tag === "locked") {
      return yield* Effect.fail(
        new ServiceInstallError({
          cause: new ServiceUpdateLockedError({ status: updateLock.status }),
        }),
      );
    }

    const runner = yield* Effect.gen(function* () {
      const runnerSpinner = yield* humanSpinner("Installing service runner", options);
      const installedRunner = yield* (
        runtime.installServiceRunner ??
        ((servicePaths) => installServiceRunner(servicePaths, { updatePointer: false }))
      )(paths).pipe(
        Effect.tap((value) =>
          Effect.sync(() =>
            runnerSpinner.stop(`Service runner installed (${value.version}/${value.target})`),
          ),
        ),
        Effect.tapError(() =>
          Effect.sync(() => runnerSpinner.error("Failed installing service runner")),
        ),
        Effect.mapError((cause) => new ServiceInstallError({ cause })),
      );
      const serviceEnv = capturedServiceEnv(env);
      const wrapper = renderServiceWrapper({
        env: serviceEnv,
        logPath: paths.logPath,
        platform,
        runnerPointerPath: paths.runnerPointerPath,
      });
      const metadata: ServiceMetadata = {
        autoUpdateManager: "registry",
        backend: paths.backend,
        commandPath: installedRunner.path,
        installedAt: (runtime.now ?? new Date()).toISOString(),
        runnerPackage: installedRunner.packageName,
        runnerPath: installedRunner.path,
        runnerTarget: installedRunner.target,
        runnerVersion: installedRunner.version,
        schedule: scheduleDescription(),
        templateVersion: SERVICE_TEMPLATE_VERSION,
        version: 1,
      };

      const filesSpinner = yield* humanSpinner("Writing service files", options);
      yield* (runtime.writeFiles ?? writeServiceFiles)(paths, wrapper, metadata).pipe(
        Effect.flatMap(() =>
          (runtime.writeRunnerPointer ?? writeServiceRunnerPointer)(paths, installedRunner.path),
        ),
        Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files written"))),
        Effect.tapError(() =>
          Effect.sync(() => filesSpinner.error("Failed writing service files")),
        ),
        Effect.mapError((cause) => new ServiceInstallError({ cause })),
      );
      const schedulerSpinner = yield* humanSpinner("Installing scheduler", options);
      yield* (runtime.installScheduler ?? installNativeScheduler)(paths).pipe(
        Effect.tap(() => Effect.sync(() => schedulerSpinner.stop("Scheduler installed"))),
        Effect.tapError(() =>
          Effect.sync(() => schedulerSpinner.error("Failed installing scheduler")),
        ),
        Effect.mapError((cause) => new ServiceInstallError({ cause })),
      );

      return installedRunner;
    }).pipe(Effect.ensuring(releaseServiceRunLock(paths.updateLockPath, updateLock.lock.ownerId)));

    const autoUpdate = {
      enabled: true,
      manager: "registry",
      package: runner.packageName,
    };

    if (options.json) {
      yield* writeJson({
        autoUpdate,
        backend: paths.backend,
        logPath: paths.logPath,
        schedule: scheduleDescription(),
        status: "ok",
        wrapperPath: paths.wrapperPath,
      });
      return;
    }

    yield* humanLog("success", "Automatic sync installed", options);
    yield* humanLog("info", `Schedule: ${scheduleDescription()}`, options);
    yield* humanLog("info", `Backend: ${paths.backend}`, options);
    yield* humanLog("info", `Log: ${paths.logPath}`, options);
    yield* humanLog("info", `Runner: ${runner.path}`, options);
    yield* humanLog("info", `Auto-update: ${formatInstallAutoUpdate("registry")}`, options);
  });
}

function serviceUninstallEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Uninstall automatic sync",
    options,
    Effect.gen(function* () {
      const paths = yield* servicePathsEffect();

      const schedulerSpinner = yield* humanSpinner("Unregistering scheduler", options);
      yield* uninstallNativeScheduler(paths).pipe(
        Effect.tap(() => Effect.sync(() => schedulerSpinner.stop("Scheduler unregistered"))),
        Effect.tapError(() =>
          Effect.sync(() => schedulerSpinner.error("Failed unregistering scheduler")),
        ),
        Effect.mapError((cause) => new ServiceUninstallError({ cause })),
      );
      const filesSpinner = yield* humanSpinner("Removing service files", options);
      yield* removeServiceFiles(paths).pipe(
        Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files removed"))),
        Effect.tapError(() =>
          Effect.sync(() => filesSpinner.error("Failed removing service files")),
        ),
        Effect.mapError((cause) => new ServiceUninstallError({ cause })),
      );

      if (options.json) {
        yield* writeJson({ removed: true, status: "ok" });
        return;
      }

      yield* humanLog("success", "Automatic sync uninstalled", options);
      yield* humanLog("info", "Auth and synced usage were left untouched", options);
    }),
  );
}

function serviceRepairEffect(options: ServiceRepairOptions = {}) {
  const program = repairServiceProgram(options);

  return options.deferred ? program : humanFrame("Repair automatic sync", options, program);
}

function repairServiceProgram(options: ServiceRepairOptions = {}) {
  return Effect.gen(function* () {
    const env = process.env;
    const platform = process.platform;
    const paths = yield* servicePathsEffect(env, undefined, platform);
    const currentState = (yield* readServiceState(paths.statePath)) ?? { version: 1 as const };
    const existingMetadata = yield* readServiceMetadata(paths.metadataPath);
    const initialNativeStatus = yield* readNativeSchedulerStatus(paths);
    const reloadRequired = serviceReloadRequired(existingMetadata, currentState);
    const repairReason =
      parseServiceRepairReason(options.reason) ??
      serviceRepairReason({
        reloadRequired,
        schedulerActive: initialNativeStatus.active,
      }) ??
      currentState.lastRepairReason ??
      "reload-required";
    const attemptedAt = new Date().toISOString();

    if (options.deferred === true) {
      yield* writeServiceState(
        paths.statePath,
        serviceRepairState(currentState, {
          attemptedAt,
          reason: repairReason,
          status: "scheduled",
        }),
      ).pipe(Effect.ignore);
    }

    const repairResult = yield* Effect.gen(function* () {
      const updateLock = yield* acquireServiceUpdateLock(paths.updateLockPath, new Date()).pipe(
        Effect.mapError((cause) => new ServiceRepairError({ cause })),
      );
      if (updateLock._tag === "locked") {
        return yield* Effect.fail(
          new ServiceRepairError({
            cause: new ServiceUpdateLockedError({ status: updateLock.status }),
          }),
        );
      }

      return yield* Effect.gen(function* () {
        const runnerSpinner = yield* humanSpinner("Installing service runner", options);
        const runner = yield* installServiceRunnerForRepair(paths, { updatePointer: false }).pipe(
          Effect.tap((installedRunner) =>
            Effect.sync(() =>
              runnerSpinner.stop(
                `Service runner installed (${installedRunner.version}/${installedRunner.target})`,
              ),
            ),
          ),
          Effect.tapError(() =>
            Effect.sync(() => runnerSpinner.error("Failed installing service runner")),
          ),
          Effect.mapError((cause) => new ServiceRepairError({ cause })),
        );

        const wrapper = renderServiceWrapper({
          env: capturedServiceEnv(env),
          logPath: paths.logPath,
          platform,
          runnerPointerPath: paths.runnerPointerPath,
        });
        const metadata: ServiceMetadata = {
          autoUpdateManager: "registry",
          backend: paths.backend,
          commandPath: runner.path,
          installedAt: existingMetadata?.installedAt ?? new Date().toISOString(),
          runnerPackage: runner.packageName,
          runnerPath: runner.path,
          runnerTarget: runner.target,
          runnerVersion: runner.version,
          schedule: scheduleDescription(),
          templateVersion: SERVICE_TEMPLATE_VERSION,
          version: 1,
        };

        const filesSpinner = yield* humanSpinner("Writing service files", options);
        yield* writeServiceFiles(paths, wrapper, metadata).pipe(
          Effect.flatMap(() => writeServiceRunnerPointer(paths, runner.path)),
          Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files written"))),
          Effect.tapError(() =>
            Effect.sync(() => filesSpinner.error("Failed writing service files")),
          ),
          Effect.mapError((cause) => new ServiceRepairError({ cause })),
        );

        const nativeStatus = yield* readNativeSchedulerStatus(paths);
        const needsSchedulerInstall = serviceRepairNeedsSchedulerInstall({
          reason: repairReason,
          reloadRequired,
          schedulerActive: nativeStatus.active,
        });
        if (!needsSchedulerInstall) {
          return nativeStatus;
        }
        if (
          !serviceRepairCanInstallScheduler({ backend: paths.backend, deferred: options.deferred })
        ) {
          if (!nativeStatus.active) {
            return yield* Effect.fail(
              new ServiceRepairError({
                cause: "launchd scheduler repair requires foreground tokenmaxxing service repair",
              }),
            );
          }
          return nativeStatus;
        }

        const schedulerSpinner = yield* humanSpinner("Repairing scheduler", options);
        yield* installNativeScheduler(paths).pipe(
          Effect.tap(() => Effect.sync(() => schedulerSpinner.stop("Scheduler repaired"))),
          Effect.tapError(() =>
            Effect.sync(() => schedulerSpinner.error("Failed repairing scheduler")),
          ),
          Effect.mapError((cause) => new ServiceRepairError({ cause })),
        );

        const repairedNativeStatus = yield* readNativeSchedulerStatus(paths);
        if (!repairedNativeStatus.active) {
          return yield* Effect.fail(new ServiceRepairError({ cause: repairedNativeStatus.detail }));
        }

        return repairedNativeStatus;
      }).pipe(
        Effect.ensuring(releaseServiceRunLock(paths.updateLockPath, updateLock.lock.ownerId)),
      );
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: (nativeStatus) => ({ _tag: "success" as const, nativeStatus }),
      }),
    );

    if (repairResult._tag === "failure") {
      const failureReport: ServiceRepairReport = {
        attemptedAt,
        completedAt: new Date().toISOString(),
        error: String(repairResult.cause),
        reason: repairReason,
        status: "failure",
      };
      if (options.deferred === true) {
        yield* writeServiceState(
          paths.statePath,
          serviceRepairState(currentState, failureReport),
        ).pipe(Effect.ignore);
        yield* writeServiceRepairCheckIn(paths, failureReport).pipe(Effect.ignore);
      }

      return yield* Effect.fail(repairResult.cause);
    }

    const successReport: ServiceRepairReport = {
      attemptedAt,
      completedAt: new Date().toISOString(),
      reason: repairReason,
      status: "success",
    };
    if (options.deferred === true) {
      yield* writeServiceState(
        paths.statePath,
        serviceRepairState(currentState, successReport),
      ).pipe(Effect.ignore);
      yield* writeServiceRepairCheckIn(paths, successReport).pipe(Effect.ignore);
    }

    if (options.json) {
      yield* writeJson({
        active: repairResult.nativeStatus.active,
        backend: paths.backend,
        detail: repairResult.nativeStatus.detail,
        repair: successReport,
        status: "ok",
      });
      return;
    }

    yield* humanLog("success", "Automatic sync repaired", options);
    yield* humanLog("info", `Scheduler: ${repairResult.nativeStatus.detail}`, options);
  });
}

function serviceStatusEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Service status",
    options,
    Effect.gen(function* () {
      const console = yield* Effect.service(ConsoleService);
      const paths = yield* servicePathsEffect();
      const metadata = yield* readServiceMetadata(paths.metadataPath);
      const state = yield* readServiceState(paths.statePath);
      const installed = yield* isServiceInstalled(paths);
      const now = new Date();
      const lockStatus = yield* readServiceLockStatus(paths.lockPath, now);
      const nativeStatus = yield* readNativeSchedulerStatus(paths);
      const reloadRequired = serviceReloadRequired(metadata, state);
      const status = {
        arch: state?.lastArch ?? null,
        autoUpdate: formatServiceStatusAutoUpdate(metadata),
        backend: paths.backend,
        installed,
        lastAutoUpdate: state?.lastAutoUpdate ?? null,
        lastAutoUpdated: state?.lastAutoUpdated ?? null,
        lastDurationMs: state?.lastDurationMs ?? null,
        lastError: state?.lastError,
        lastRepairAttemptAt: state?.lastRepairAttemptAt ?? null,
        lastRepairCompletedAt: state?.lastRepairCompletedAt ?? null,
        lastRepairError: state?.lastRepairError ?? null,
        lastRepairReason: state?.lastRepairReason ?? null,
        lastRepairStatus: state?.lastRepairStatus ?? null,
        lastRows: state?.lastRows ?? null,
        lastSchedulerActive: state?.lastSchedulerActive ?? null,
        lastSince: state?.lastSince ?? null,
        lastSources: state?.lastSources ?? [],
        lastSyncStatus: state?.lastSyncStatus ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastSuccessDate: serviceLastSuccessDate(state) ?? null,
        lastUpserted: state?.lastUpserted ?? null,
        lastVersion: state?.lastCliVersion ?? null,
        lock: formatServiceLockStatus(lockStatus),
        logPath: paths.logPath,
        reloadRequired,
        runnerPath: metadata?.runnerPath ?? null,
        runnerTarget: metadata?.runnerTarget ?? null,
        runnerVersion: metadata?.runnerVersion ?? null,
        schedule: metadata?.schedule ?? scheduleDescription(),
        scheduler: nativeStatus,
        status: "ok",
        templateVersion: metadata?.templateVersion ?? null,
        wrapperPath: paths.wrapperPath,
      };

      if (options.json) {
        yield* writeJson(status);
        return;
      }

      yield* Effect.sync(() => {
        console.log(`Installed: ${status.installed ? "yes" : "no"}`);
        console.log(`Backend: ${status.backend}`);
        console.log(`Schedule: ${status.schedule}`);
        console.log(`Auto-update: ${status.autoUpdate}`);
        console.log(`Scheduler active: ${status.scheduler.active ? "yes" : "no"}`);
        console.log(`Scheduler detail: ${status.scheduler.detail}`);
        console.log(`Service template: ${status.templateVersion ?? "unknown"}`);
        console.log(`Reload required: ${status.reloadRequired ? "yes" : "no"}`);
        if (status.runnerTarget !== null || status.runnerVersion !== null) {
          console.log(
            `Runner: ${status.runnerVersion ?? "unknown"}${status.runnerTarget === null ? "" : ` (${status.runnerTarget})`}`,
          );
        }
        console.log(`Last success: ${status.lastSuccessAt ?? "never"}`);
        console.log(`Last success date: ${status.lastSuccessDate ?? "never"}`);
        if (status.lastDurationMs !== null) {
          console.log(`Last duration: ${status.lastDurationMs}ms`);
        }
        if (status.lastRows !== null) {
          console.log(`Last rows: ${status.lastRows}`);
        }
        if (status.lastSince !== null) {
          console.log(`Last since: ${status.lastSince}`);
        }
        if (status.lastUpserted !== null) {
          console.log(`Last upserted: ${status.lastUpserted}`);
        }
        if (status.lastVersion !== null) {
          console.log(
            `Last CLI: ${status.lastVersion}${status.arch === null ? "" : ` (${status.arch})`}`,
          );
        }
        if (status.lastError !== undefined) {
          console.log(`Last error: ${status.lastError}`);
        }
        if (status.lastRepairStatus !== null) {
          console.log(
            `Last repair: ${status.lastRepairStatus}${
              status.lastRepairReason === null ? "" : ` (${status.lastRepairReason})`
            }`,
          );
        }
        if (status.lastRepairAttemptAt !== null) {
          console.log(`Last repair attempt: ${status.lastRepairAttemptAt}`);
        }
        if (status.lastRepairCompletedAt !== null) {
          console.log(`Last repair completed: ${status.lastRepairCompletedAt}`);
        }
        if (status.lastRepairError !== null) {
          console.log(`Last repair error: ${status.lastRepairError}`);
        }
        console.log(`Lock: ${status.lock}`);
        console.log(`Wrapper: ${status.wrapperPath}`);
        console.log(`Log: ${status.logPath}`);
      });
    }),
  );
}

function serviceRunEffect(options: ServiceRunOptions) {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const paths = yield* servicePathsEffect();
    const lock = yield* acquireServiceRunLock(paths.lockPath, new Date()).pipe(
      Effect.mapError((cause) => new ServiceRunError({ cause })),
    );

    if (lock._tag === "locked") {
      const message = formatServiceLockSkip(lock.status);
      if (options.json) {
        yield* writeJson({
          lock: formatServiceLockStatus(lock.status),
          reason: "locked",
          status: "skipped",
        });
      } else if (!options.scheduled) {
        yield* Effect.sync(() => {
          console.log(message);
        });
      }
      if (options.scheduled) {
        yield* writeServiceLockedCheckIn(paths, lock.status);
      }
      return;
    }

    const result = yield* runServiceSyncOnce(paths, options).pipe(
      Effect.ensuring(releaseServiceRunLock(paths.lockPath, lock.lock.ownerId)),
    );

    if (options.json && !options.scheduled) {
      yield* writeJson(result);
    }
  });
}

function serviceDoctorEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Service doctor",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);
      const console = yield* Effect.service(ConsoleService);
      const paths = yield* servicePathsEffect();
      const now = new Date();

      const envToken = yield* config.hasEnvToken();
      const authConfig = yield* config.readConfig().pipe(
        Effect.match({
          onFailure: (cause) => ({ _tag: "error" as const, cause }),
          onSuccess: (value) => ({ _tag: "success" as const, value }),
        }),
      );
      const metadata = yield* readServiceMetadata(paths.metadataPath);
      const state = yield* readServiceState(paths.statePath);
      const installed = yield* isServiceInstalled(paths);
      const nativeStatus = yield* readNativeSchedulerStatus(paths);
      const reloadRequired = serviceReloadRequired(metadata, state);
      const wrapperExists = yield* fileExists(paths.wrapperPath);
      const runnerPointerExists = yield* fileExists(paths.runnerPointerPath);
      const definitionExists =
        paths.definitionPath === null ? installed : yield* fileExists(paths.definitionPath);
      const metadataCommandExists =
        metadata?.commandPath === undefined ? false : yield* fileExists(metadata.commandPath);
      const currentCommand = yield* findTokenmaxxingCommandInstall().pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const autoUpdateManager =
        metadata === null
          ? undefined
          : (metadata.autoUpdateManager ?? currentCommand?.autoUpdateManager);
      const autoUpdateManagerExists =
        autoUpdateManager === "registry"
          ? true
          : autoUpdateManager === undefined || autoUpdateManager === null
            ? false
            : yield* commandExists(autoUpdateManager);
      const lockStatus = yield* readServiceLockStatus(paths.lockPath, now);
      const logTail = yield* readLogTail(paths.logPath, 8);

      const checks = [
        doctorCheck(
          installed ? "ok" : "warn",
          "scheduler",
          installed ? `installed (${paths.backend})` : `not installed (${paths.backend})`,
        ),
        doctorCheck(
          nativeStatus.active ? "ok" : "warn",
          "active",
          `${nativeStatus.detail}; repair with ${serviceRepairCommand()}`,
        ),
        doctorCheck(
          reloadRequired ? "warn" : "ok",
          "template",
          reloadRequired
            ? `reload required; repair with ${serviceRepairCommand()}`
            : `current (${metadata?.templateVersion ?? "unknown"})`,
        ),
        doctorCheck(
          definitionExists ? "ok" : "warn",
          "definition",
          paths.definitionPath ?? "tracked by Windows Task Scheduler metadata",
        ),
        doctorCheck(wrapperExists ? "ok" : "warn", "wrapper", paths.wrapperPath),
        doctorCheck(
          runnerPointerExists ? "ok" : "warn",
          "runner",
          metadata?.runnerTarget === undefined
            ? paths.runnerPointerPath
            : `${metadata.runnerVersion ?? "unknown"} (${metadata.runnerTarget})`,
        ),
        doctorCheck(metadata === null ? "warn" : "ok", "metadata", paths.metadataPath),
        doctorCheck(
          envToken
            ? "warn"
            : authConfig._tag === "success" && authConfig.value.token
              ? "ok"
              : "warn",
          "auth",
          doctorAuthDetail(envToken, authConfig),
        ),
        doctorCheck(
          metadataCommandExists ? "ok" : currentCommand === null ? "warn" : "ok",
          "binary",
          doctorBinaryDetail(metadata, metadataCommandExists, currentCommand),
        ),
        doctorCheck(
          doctorAutoUpdateStatus(metadata, autoUpdateManagerExists),
          "auto-update",
          doctorAutoUpdateDetail(metadata, autoUpdateManager, autoUpdateManagerExists),
        ),
        doctorCheck(
          lockStatus.locked && !lockStatus.stale ? "warn" : "ok",
          "lock",
          formatServiceLockStatus(lockStatus),
        ),
        doctorCheck(
          state?.lastSuccessAt === undefined ? "info" : "ok",
          "last success",
          state?.lastSuccessAt ?? "never",
        ),
        doctorCheck(
          state?.lastError === undefined ? "ok" : "warn",
          "last error",
          state?.lastError ?? "none",
        ),
        doctorCheck(
          state?.lastRepairStatus === "failure" ? "warn" : "info",
          "last repair",
          state?.lastRepairStatus === undefined
            ? "none"
            : `${state.lastRepairStatus}${
                state.lastRepairReason === undefined ? "" : ` (${state.lastRepairReason})`
              }${state.lastRepairError === undefined ? "" : `; ${state.lastRepairError}`}`,
        ),
      ];

      if (options.json) {
        yield* writeJson({
          checks,
          recentLog: logTail,
          reloadRequired,
          scheduler: nativeStatus,
          state: state === null ? null : serviceStateJson(state),
          status: "ok",
        });
        return;
      }

      yield* Effect.sync(() => {
        console.log("Service doctor");
        for (const check of checks) {
          console.log(doctorLine(check));
        }

        if (logTail.length > 0) {
          console.log("");
          console.log("Recent log:");
          for (const line of logTail) {
            console.log(`  ${line}`);
          }
        }
      });
    }),
  );
}

function runServiceSyncOnce(paths: ServicePaths, options: ServiceRunOptions) {
  return Effect.gen(function* () {
    const clock = yield* Effect.service(ClockService);
    const config = yield* Effect.service(ConfigService);
    const console = yield* Effect.service(ConsoleService);
    const state = yield* readServiceState(paths.statePath);
    const currentState = state ?? { version: 1 as const };
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    const startedAtMs = startedAt.getTime();
    const cliVersion = packageJson.version;
    const cliArch = arch();
    const scheduledSince = serviceScheduledSyncSince(currentState, startedAt, options.scheduled);
    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const nativeStatus = yield* readNativeSchedulerStatus(paths);
    const reloadRequired = serviceReloadRequired(metadata, currentState);
    const baseCheckIn = {
      backend: paths.backend,
      reloadRequired,
      ...serviceRunnerCheckIn(metadata),
      schedulerActive: nativeStatus.active,
    };

    if (options.scheduled) {
      const stored = yield* config.readConfig();
      const jitterMs =
        stored.deviceId === undefined ? 0 : deterministicServiceJitterMs(stored.deviceId);
      if (jitterMs > 0) {
        yield* clock.sleep(jitterMs).pipe(Effect.catch(() => Effect.void));
      }
    }

    const authResult = yield* resolveServiceSyncAuth();
    if (authResult._tag === "failure") {
      const failedState = serviceRunFailureState(currentState, {
        arch: cliArch,
        attemptAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        error: String(authResult.cause),
        reloadRequired,
        schedulerActive: nativeStatus.active,
        since: scheduledSince,
        version: cliVersion,
      });
      const repairReport = yield* maybeScheduleDeferredServiceRepair({
        commandPath: metadata?.commandPath,
        reason: serviceRepairReason({ serviceFailed: true }),
        scheduled: options.scheduled,
      });
      const finalFailedState =
        repairReport === undefined ? failedState : serviceRepairState(failedState, repairReport);
      yield* writeServiceState(paths.statePath, finalFailedState).pipe(Effect.ignore);
      yield* writeScheduledServiceLog(
        console,
        options,
        serviceRunLogLine(finalFailedState, "failure"),
      );
      return yield* Effect.fail(new ServiceRunError({ cause: authResult.cause }));
    }

    const auth = authResult.value;
    const existingRepairReason = serviceRepairReason({
      reloadRequired,
      schedulerActive: nativeStatus.active,
    });
    yield* writeServiceCheckIn(auth, {
      ...baseCheckIn,
      ...(existingRepairReason === undefined ? {} : serviceRepairCheckInFromState(currentState)),
      status: "started",
    }).pipe(Effect.ignore);

    const autoUpdate = yield* runServiceAutoUpdate(metadata, {
      currentVersion: cliVersion,
      json: options.json,
      paths,
    });
    const autoUpdated = autoUpdate.status === "success" && autoUpdate.manager !== "registry";

    yield* writeServiceState(paths.statePath, {
      ...currentState,
      lastArch: cliArch,
      lastAttemptAt: startedAtIso,
      lastCliVersion: cliVersion,
      lastError: undefined,
      lastSchedulerActive: nativeStatus.active,
      lastSince: scheduledSince,
      reloadRequired,
      version: 1,
    }).pipe(Effect.mapError((cause) => new ServiceRunError({ cause })));

    const result = yield* syncProgram({
      auth,
      dryRun: false,
      json: true,
      silent: true,
      ...(scheduledSince === undefined ? {} : { since: scheduledSince }),
      ...(options.scheduled ? { uploadPolicy: SERVICE_UPLOAD_RETRY_POLICY } : {}),
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
    );

    if (result._tag === "failure") {
      const failedState = serviceRunFailureState(currentState, {
        arch: cliArch,
        attemptAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        error: String(result.cause),
        reloadRequired,
        schedulerActive: nativeStatus.active,
        since: scheduledSince,
        version: cliVersion,
      });
      const repairReport = yield* maybeScheduleDeferredServiceRepair({
        commandPath: metadata?.commandPath,
        reason: serviceRepairReason({ serviceFailed: true }),
        scheduled: options.scheduled,
      });
      const finalFailedState =
        repairReport === undefined ? failedState : serviceRepairState(failedState, repairReport);
      yield* writeServiceState(paths.statePath, finalFailedState).pipe(Effect.ignore);
      yield* writeScheduledServiceLog(
        console,
        options,
        serviceRunLogLine(finalFailedState, "failure"),
      );
      yield* writeServiceCheckIn(auth, {
        ...baseCheckIn,
        autoUpdate,
        ...serviceRunnerCheckIn(metadata, autoUpdate),
        ...serviceRepairCheckIn(repairReport),
        error: finalFailedState.lastError,
        status: "failure",
      }).pipe(Effect.ignore);
      return yield* Effect.fail(new ServiceRunError({ cause: result.cause }));
    }

    const successAt = new Date().toISOString();
    const successState = serviceRunSuccessState(currentState, {
      arch: cliArch,
      attemptAt: startedAtIso,
      autoUpdate,
      durationMs: Date.now() - startedAtMs,
      reloadRequired,
      result: result.value,
      schedulerActive: nativeStatus.active,
      since: scheduledSince,
      successAt,
      version: cliVersion,
    });
    const repairReport = yield* maybeScheduleDeferredServiceRepair({
      commandPath: metadata?.commandPath,
      reason: serviceRepairReason({
        autoUpdated,
        reloadRequired,
        schedulerActive: nativeStatus.active,
      }),
      scheduled: options.scheduled,
    });
    const finalSuccessState =
      repairReport === undefined ? successState : serviceRepairState(successState, repairReport);
    const syncFailed = result.value.status === "error";
    yield* writeServiceState(paths.statePath, finalSuccessState).pipe(
      Effect.mapError((cause) => new ServiceRunError({ cause })),
    );
    yield* writeScheduledServiceLog(
      console,
      options,
      serviceRunLogLine(finalSuccessState, syncFailed ? "failure" : "success"),
    );
    yield* writeServiceCheckIn(auth, {
      ...baseCheckIn,
      autoUpdate,
      ...serviceRunnerCheckIn(metadata, autoUpdate),
      ...serviceRepairCheckIn(repairReport),
      ...(syncFailed ? { error: finalSuccessState.lastError } : {}),
      status: syncFailed ? "failure" : "success",
    }).pipe(Effect.ignore);

    if (autoUpdated && metadata !== null && !options.scheduled) {
      yield* refreshServiceAfterUpdate({
        commandPath: metadata.commandPath,
      }).pipe(
        Effect.catch(() =>
          options.json
            ? Effect.void
            : Effect.sync(() => {
                console.log("Service refresh failed after auto-update");
              }),
        ),
      );
    }

    if (!options.json && !options.scheduled) {
      yield* Effect.sync(() => {
        console.log(
          syncFailed ? "Service run completed with source failures" : "Service run complete",
        );
        console.log(`Log: ${paths.logPath}`);
      });
    }

    return {
      autoUpdated,
      logPath: paths.logPath,
      rows: result.value.rows,
      sources: result.value.sourceResults,
      status: result.value.status,
      upserted: result.value.upserted ?? 0,
    };
  });
}

function writeServiceCheckIn(auth: SyncAuth, checkIn: ServiceCheckIn) {
  return auth.client.usage
    .checkIn({
      payload: {
        device: {
          arch: arch(),
          name: hostname(),
          platform: process.platform,
          version: packageJson.version,
        },
        service: {
          autoUpdate: checkIn.autoUpdate,
          backend: checkIn.backend,
          error: checkIn.error,
          reloadRequired: checkIn.reloadRequired,
          repairAttemptedAt: checkIn.repairAttemptedAt,
          repairCompletedAt: checkIn.repairCompletedAt,
          repairError: checkIn.repairError,
          repairReason: checkIn.repairReason,
          repairStatus: checkIn.repairStatus,
          runnerTarget: checkIn.runnerTarget,
          runnerVersion: checkIn.runnerVersion,
          schedulerActive: checkIn.schedulerActive,
          status: checkIn.status,
          templateVersion: SERVICE_TEMPLATE_VERSION,
        },
      },
    })
    .pipe(Effect.timeout(`${SERVICE_API_TIMEOUT_MS} millis`));
}

function serviceRunnerCheckIn(
  metadata: ServiceMetadata | null,
  autoUpdate?: ServiceAutoUpdateReport,
): Pick<ServiceCheckIn, "runnerTarget" | "runnerVersion"> {
  const runnerTarget = metadata?.runnerTarget;
  const runnerVersion =
    autoUpdate?.manager === "registry" && autoUpdate.installedVersion !== null
      ? autoUpdate.installedVersion
      : metadata?.runnerVersion;

  return {
    ...(runnerTarget === undefined ? {} : { runnerTarget }),
    ...(runnerVersion === undefined || runnerVersion === null ? {} : { runnerVersion }),
  };
}

function resolveServiceSyncAuth() {
  return resolveSyncAuth({ json: true }).pipe(
    Effect.timeout(`${SERVICE_API_TIMEOUT_MS} millis`),
    Effect.match({
      onFailure: (cause) => ({ _tag: "failure" as const, cause }),
      onSuccess: (value) => ({ _tag: "success" as const, value }),
    }),
  );
}

function writeServiceLockedCheckIn(paths: ServicePaths, lockStatus: ServiceLockStatus) {
  return Effect.gen(function* () {
    const authResult = yield* resolveServiceSyncAuth();
    if (authResult._tag === "failure") {
      return;
    }

    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const state = yield* readServiceState(paths.statePath);
    const nativeStatus = yield* readNativeSchedulerStatus(paths);

    yield* writeServiceCheckIn(authResult.value, {
      backend: paths.backend,
      error: formatServiceLockSkip(lockStatus),
      reloadRequired: serviceReloadRequired(metadata, state),
      ...serviceRunnerCheckIn(metadata),
      schedulerActive: nativeStatus.active,
      status: "started",
    }).pipe(Effect.ignore);
  }).pipe(Effect.catch(() => Effect.void));
}

function serviceReloadRequired(metadata: ServiceMetadata | null, _state?: ServiceState | null) {
  return (
    metadata !== null &&
    (metadata.templateVersion !== SERVICE_TEMPLATE_VERSION ||
      metadata.autoUpdateManager !== "registry" ||
      metadata.runnerTarget === undefined ||
      metadata.runnerVersion === undefined)
  );
}

function serviceRepairReason(input: {
  autoUpdated?: boolean | undefined;
  reloadRequired?: boolean | undefined;
  schedulerActive?: boolean | undefined;
  serviceFailed?: boolean | undefined;
}): ServiceRepairReasonValue | undefined {
  if (input.serviceFailed === true) {
    return "service-failure";
  }
  if (input.schedulerActive === false) {
    return "scheduler-inactive";
  }
  if (input.reloadRequired === true) {
    return "reload-required";
  }
  if (input.autoUpdated === true) {
    return "auto-updated";
  }

  return undefined;
}

function serviceRepairNeedsSchedulerInstall(input: {
  reason: ServiceRepairReasonValue;
  reloadRequired?: boolean | undefined;
  schedulerActive: boolean;
}): boolean {
  return input.reloadRequired === true || input.reason !== "auto-updated" || !input.schedulerActive;
}

function serviceRepairCanInstallScheduler(input: {
  backend: ServiceBackend;
  deferred?: boolean | undefined;
}): boolean {
  return !(input.backend === "launchd" && input.deferred === true);
}

function parseServiceRepairReason(value: string | undefined): ServiceRepairReasonValue | undefined {
  if (
    value === "auto-updated" ||
    value === "reload-required" ||
    value === "scheduler-inactive" ||
    value === "service-failure"
  ) {
    return value;
  }

  return undefined;
}

function serviceRepairState(currentState: ServiceState, report: ServiceRepairReport): ServiceState {
  return {
    ...currentState,
    lastRepairAttemptAt: report.attemptedAt,
    lastRepairCompletedAt: report.completedAt,
    lastRepairError: report.error,
    lastRepairReason: report.reason,
    lastRepairStatus: report.status,
    version: 1,
  };
}

function serviceRepairCheckIn(
  report: ServiceRepairReport | undefined,
): Pick<
  ServiceCheckIn,
  "repairAttemptedAt" | "repairCompletedAt" | "repairError" | "repairReason" | "repairStatus"
> {
  if (report === undefined) {
    return {};
  }

  return {
    repairAttemptedAt: report.attemptedAt,
    repairCompletedAt: report.completedAt,
    repairError: report.error,
    repairReason: report.reason,
    repairStatus: report.status,
  };
}

function serviceRepairCheckInFromState(
  state: ServiceState,
): ReturnType<typeof serviceRepairCheckIn> {
  if (state.lastRepairReason === undefined || state.lastRepairStatus === undefined) {
    return {};
  }
  if (state.lastRepairStatus === "success") {
    return {};
  }

  return {
    repairAttemptedAt: state.lastRepairAttemptAt,
    repairCompletedAt: state.lastRepairCompletedAt,
    repairError: state.lastRepairError,
    repairReason: state.lastRepairReason,
    repairStatus: state.lastRepairStatus,
  };
}

function serviceRepairCommand(): string {
  return "tokenmaxxing service repair";
}

function scheduleDeferredServiceRepair(
  commandPath: string,
  reason: ServiceRepairReasonValue,
): Effect.Effect<ServiceRepairReport, never> {
  const attemptedAt = new Date().toISOString();

  return Effect.sync(() => {
    const child = spawnDeferredServiceRepair(commandPath, reason);
    child.on("error", () => {
      // The next scheduled run will surface repair-needed again if the helper
      // process cannot be started.
    });
    child.unref();

    return {
      attemptedAt,
      reason,
      status: "scheduled" as const,
    };
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        attemptedAt,
        error: String(cause),
        reason,
        status: "failure" as const,
      }),
    ),
  );
}

function spawnDeferredServiceRepair(
  commandPath: string,
  reason: ServiceRepairReasonValue,
  platform = process.platform,
) {
  const invocation = deferredServiceRepairInvocation(commandPath, reason, platform, process.env);

  return spawn(invocation.command, invocation.args, invocation.options);
}

function deferredServiceRepairInvocation(
  commandPath: string,
  reason: ServiceRepairReasonValue,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): {
  args: string[];
  command: string;
  options: Parameters<typeof spawn>[2];
} {
  if (platform === "win32") {
    return {
      args: [
        "/d",
        "/s",
        "/c",
        `timeout /t 2 /nobreak >nul & ${cmdQuote(
          commandPath,
        )} service repair --deferred --json --reason ${cmdQuote(reason)}`,
      ],
      command: "cmd",
      options: { detached: true, stdio: "ignore", windowsHide: true },
    };
  }

  if (platform === "linux") {
    return {
      args: [
        "--user",
        "--quiet",
        "--collect",
        "--on-active=2s",
        `--unit=${systemdRepairUnitName(reason)}`,
        ...systemdRunEnvArgs(capturedServiceEnv(env)),
        commandPath,
        "service",
        "repair",
        "--deferred",
        "--json",
        "--reason",
        reason,
      ],
      command: "systemd-run",
      options: {
        detached: true,
        stdio: "ignore",
      },
    };
  }

  return {
    args: [
      "-c",
      `sleep 2; exec ${shellQuote(
        commandPath,
      )} service repair --deferred --json --reason ${shellQuote(reason)}`,
    ],
    command: "sh",
    options: {
      detached: true,
      stdio: "ignore",
    },
  };
}

function systemdRepairUnitName(reason: ServiceRepairReasonValue): string {
  return `${SYSTEMD_NAME}-repair-${reason}`;
}

function systemdRunEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`);
}

function maybeScheduleDeferredServiceRepair(input: {
  commandPath: string | undefined;
  reason: ServiceRepairReasonValue | undefined;
  scheduled: boolean;
}): Effect.Effect<ServiceRepairReport | undefined, never> {
  if (!input.scheduled || input.commandPath === undefined || input.reason === undefined) {
    return Effect.succeed(undefined);
  }

  return scheduleDeferredServiceRepair(input.commandPath, input.reason);
}

function writeServiceRepairCheckIn(paths: ServicePaths, report: ServiceRepairReport) {
  return Effect.gen(function* () {
    const authResult = yield* resolveServiceSyncAuth().pipe(
      Effect.map((result) => (result._tag === "failure" ? null : result.value)),
    );
    if (authResult === null) {
      return;
    }

    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const state = yield* readServiceState(paths.statePath);
    const nativeStatus = yield* readNativeSchedulerStatus(paths);

    yield* writeServiceCheckIn(authResult, {
      backend: paths.backend,
      error: report.status === "failure" ? report.error : undefined,
      reloadRequired: serviceReloadRequired(metadata, state),
      ...serviceRunnerCheckIn(metadata),
      schedulerActive: nativeStatus.active,
      status: report.status === "failure" ? "failure" : "success",
      ...serviceRepairCheckIn(report),
    }).pipe(Effect.ignore);
  }).pipe(Effect.catch(() => Effect.void));
}

function serviceRepairLogFields(state: ServiceState) {
  return {
    repairAttemptedAt: state.lastRepairAttemptAt,
    repairCompletedAt: state.lastRepairCompletedAt,
    repairError: state.lastRepairError,
    repairReason: state.lastRepairReason,
    repairStatus: state.lastRepairStatus,
  };
}

function readNativeSchedulerStatus(
  paths: ServicePaths,
): Effect.Effect<ServiceNativeSchedulerStatus, never> {
  const invocation = nativeSchedulerStatusInvocation(paths);

  return Effect.tryPromise({
    try: async () => {
      await execFilePromise(invocation.command, invocation.args, { windowsHide: true });

      return {
        active: true,
        command: invocation.description,
        detail: "active",
      };
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        active: false,
        command: invocation.description,
        detail: formatNativeSchedulerError(cause),
      }),
    ),
  );
}

function nativeSchedulerStatusInvocation(paths: ServicePaths): {
  args: string[];
  command: string;
  description: string;
} {
  if (paths.backend === "launchd") {
    const target = `${launchdDomain()}/${SERVICE_LABEL}`;

    return {
      args: ["print", target],
      command: "launchctl",
      description: `launchctl print ${target}`,
    };
  }

  if (paths.backend === "systemd") {
    return {
      args: ["--user", "is-active", `${SYSTEMD_NAME}.timer`],
      command: "systemctl",
      description: `systemctl --user is-active ${SYSTEMD_NAME}.timer`,
    };
  }

  return {
    args: ["/Query", "/TN", windowsTaskName()],
    command: "schtasks",
    description: `schtasks /Query /TN ${windowsTaskName()}`,
  };
}

function formatNativeSchedulerError(cause: unknown): string {
  const error = cause as { code?: unknown; stderr?: unknown; stdout?: unknown };
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const output = stderr || stdout;
  if (output !== "") {
    return output.split(/\r?\n/)[0]!;
  }

  return `inactive${formatNativeSchedulerExitCode(error.code)}`;
}

function formatNativeSchedulerExitCode(code: unknown): string {
  return typeof code === "number" || typeof code === "string" ? ` (exit ${code})` : "";
}

function serviceRunSuccessState(
  currentState: ServiceState,
  input: {
    arch: string;
    attemptAt: string;
    autoUpdate: ServiceAutoUpdateReport;
    durationMs: number;
    reloadRequired?: boolean | undefined;
    result: SyncResult;
    schedulerActive?: boolean | undefined;
    since?: string | undefined;
    successAt: string;
    version: string;
  },
): ServiceState {
  return {
    ...currentState,
    lastArch: input.arch,
    lastAttemptAt: input.attemptAt,
    lastAutoUpdate: input.autoUpdate,
    lastAutoUpdated: input.autoUpdate.status === "success",
    lastCliVersion: input.version,
    lastDurationMs: input.durationMs,
    lastError: input.result.status === "error" ? "ccusage source collection failed" : undefined,
    lastRows: input.result.rows,
    lastSchedulerActive: input.schedulerActive,
    lastSince: input.since,
    lastSources: serviceSourcesForState(input.result),
    lastSuccessAt: input.result.status === "error" ? currentState.lastSuccessAt : input.successAt,
    lastSyncStatus: input.result.status,
    lastUpserted: input.result.upserted ?? 0,
    reloadRequired: input.reloadRequired,
    version: 1,
  };
}

function serviceRunFailureState(
  currentState: ServiceState,
  input: {
    arch: string;
    attemptAt: string;
    durationMs: number;
    error: string;
    reloadRequired?: boolean | undefined;
    schedulerActive?: boolean | undefined;
    since?: string | undefined;
    version: string;
  },
): ServiceState {
  return {
    ...currentState,
    lastArch: input.arch,
    lastAttemptAt: input.attemptAt,
    lastCliVersion: input.version,
    lastDurationMs: input.durationMs,
    lastError: input.error,
    lastSchedulerActive: input.schedulerActive,
    lastSince: input.since,
    reloadRequired: input.reloadRequired,
    version: 1,
  };
}

function serviceSourcesForState(result: SyncResult): ServiceSourceState[] {
  return result.sourceResults.map((sourceResult) => {
    if (sourceResult.status === "failed") {
      return {
        issue: sourceResult.issue,
        source: sourceResult.source,
        status: sourceResult.status,
      };
    }

    if (sourceResult.status === "skipped") {
      return {
        source: sourceResult.source,
        status: sourceResult.status,
      };
    }

    const summary = sourceResult.summary;
    return {
      days: summary.days,
      ...(sourceResult.status === "partial" ? { issue: sourceResult.issue } : {}),
      models: summary.models,
      rows: summary.rows,
      sessions: summary.sessions,
      source: sourceResult.source,
      spendUsd: summary.spendUsd,
      status: sourceResult.status,
    };
  });
}

function serviceRunLogLine(state: ServiceState, status: "failure" | "success") {
  return {
    arch: state.lastArch,
    autoUpdate: state.lastAutoUpdate,
    autoUpdated: state.lastAutoUpdated,
    durationMs: state.lastDurationMs,
    error: status === "failure" ? state.lastError : undefined,
    event: "service_run",
    reloadRequired: state.reloadRequired,
    ...serviceRepairLogFields(state),
    rows: state.lastRows,
    schedulerActive: state.lastSchedulerActive,
    since: state.lastSince,
    sources: state.lastSources,
    syncStatus: state.lastSyncStatus,
    status,
    timestamp: new Date().toISOString(),
    upserted: state.lastUpserted,
    version: state.lastCliVersion,
  };
}

function writeScheduledServiceLog(
  console: ServiceLogWriter,
  options: ServiceRunOptions,
  line: ReturnType<typeof serviceRunLogLine>,
): Effect.Effect<void> {
  if (!options.scheduled) {
    return Effect.void;
  }

  return Effect.sync(() => {
    console.log(JSON.stringify(removeUndefined(line)));
  });
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  ) as Partial<T>;
}

function serviceLastSuccessDate(state: ServiceState | null): string | undefined {
  if (state?.lastSuccessDate !== undefined) {
    return state.lastSuccessDate;
  }

  if (state?.lastSuccessAt === undefined) {
    return undefined;
  }

  const lastSuccessAt = new Date(state.lastSuccessAt);

  return Number.isNaN(lastSuccessAt.getTime()) ? undefined : localDateKey(lastSuccessAt);
}

function serviceScheduledSyncSince(
  state: ServiceState,
  now: Date,
  scheduled: boolean,
): string | undefined {
  if (!scheduled) {
    return undefined;
  }

  if (state.lastSuccessAt !== undefined) {
    const lastSuccessAt = new Date(state.lastSuccessAt);
    if (!Number.isNaN(lastSuccessAt.getTime()) && lastSuccessAt.getTime() <= now.getTime()) {
      return localDateKey(lastSuccessAt);
    }
  }

  const today = localDateKey(now);
  if (
    state.lastSuccessDate !== undefined &&
    isLocalDateKey(state.lastSuccessDate) &&
    state.lastSuccessDate <= today
  ) {
    return state.lastSuccessDate;
  }

  return previousLocalDateKey(now);
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function previousLocalDateKey(date: Date): string {
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
}

function isLocalDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function deterministicServiceJitterMs(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0) % (SERVICE_JITTER_MAX_MS + 1);
}

function acquireServiceRunLock(path: string, now: Date): Effect.Effect<ServiceRunLock, unknown> {
  return Effect.tryPromise({
    try: () => acquireServiceRunLockFile(path, now),
    catch: (cause) => cause,
  });
}

async function acquireServiceRunLockFile(path: string, now: Date): Promise<ServiceRunLock> {
  return acquireServiceLockFile(path, now, { pidAwareStaleTakeover: true });
}

function acquireServiceUpdateLock(path: string, now: Date): Effect.Effect<ServiceRunLock, unknown> {
  return Effect.tryPromise({
    try: () => acquireServiceLockFile(path, now, { pidAwareStaleTakeover: true }),
    catch: (cause) => cause,
  });
}

async function acquireServiceLockFile(
  path: string,
  now: Date,
  options: { pidAwareStaleTakeover: boolean },
): Promise<ServiceRunLock> {
  await mkdir(dirname(path), { recursive: true });
  const lock = serviceLockJson(now);
  const acquired = await tryWriteServiceLock(path, lock);
  if (acquired) {
    return { _tag: "acquired", lock };
  }

  const status = await readServiceLockStatusFile(path, now);
  if (status.locked && (await serviceLockCanBeReplaced(status, options))) {
    await rm(path, { force: true });
    const staleReplacementLock = serviceLockJson(now);
    if (await tryWriteServiceLock(path, staleReplacementLock)) {
      return { _tag: "acquired", lock: staleReplacementLock };
    }
  }

  return { _tag: "locked", status: await readServiceLockStatusFile(path, now) };
}

async function serviceLockCanBeReplaced(
  status: ServiceLockStatus,
  options: { pidAwareStaleTakeover: boolean },
): Promise<boolean> {
  if (!status.locked || !status.stale) {
    return false;
  }
  if (!options.pidAwareStaleTakeover || status.pid === undefined || status.pid <= 0) {
    return true;
  }

  return !(await processIsAlive(status.pid));
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function tryWriteServiceLock(path: string, lock: ServiceLock): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw cause;
  }
}

function releaseServiceRunLock(path: string, ownerId: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const status = await readServiceLockFile(path);
      if (status?.ownerId === ownerId) {
        await rm(path, { force: true });
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void));
}

function readServiceLockStatus(path: string, now: Date): Effect.Effect<ServiceLockStatus, never> {
  return Effect.tryPromise({
    try: () => readServiceLockStatusFile(path, now),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(noServiceLockStatus())));
}

async function readServiceLockStatusFile(path: string, now: Date): Promise<ServiceLockStatus> {
  const lock = await readServiceLockFile(path);
  if (lock === null) {
    return noServiceLockStatus();
  }

  return serviceLockStatus(lock, now);
}

async function readServiceLockFile(path: string): Promise<ServiceLock | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ServiceLock;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return {
      acquiredAt: "",
      ownerId: "",
      pid: 0,
      version: 1,
    };
  }
}

function serviceLockJson(now: Date): ServiceLock {
  return {
    acquiredAt: now.toISOString(),
    ownerId: `${process.pid}:${now.toISOString()}:${randomUUID()}`,
    pid: process.pid,
    version: 1,
  };
}

function noServiceLockStatus(): ServiceLockStatus {
  return { locked: false, stale: false };
}

function serviceLockStatus(lock: ServiceLock, now: Date): ServiceLockStatus {
  const acquiredAt = Date.parse(lock.acquiredAt);
  if (Number.isNaN(acquiredAt)) {
    return {
      acquiredAt: lock.acquiredAt || undefined,
      locked: true,
      pid: lock.pid || undefined,
      stale: true,
    };
  }

  const ageMs = Math.max(0, now.getTime() - acquiredAt);

  return {
    acquiredAt: lock.acquiredAt,
    ageMs,
    locked: true,
    pid: lock.pid,
    stale: ageMs >= SERVICE_LOCK_STALE_MS,
  };
}

function formatServiceLockSkip(status: ServiceLockStatus): string {
  if (!status.locked) {
    return "Sync skipped; service run is already in progress";
  }

  return `Sync skipped; service run is already in progress${formatServiceLockSince(status)}`;
}

function formatServiceLockStatus(status: ServiceLockStatus): string {
  if (!status.locked) {
    return "none";
  }

  return `held${formatServiceLockSince(status)}${status.stale ? " (stale)" : ""}`;
}

function formatServiceLockSince(status: Extract<ServiceLockStatus, { locked: true }>): string {
  const parts: string[] = [];
  if (status.acquiredAt !== undefined && status.acquiredAt !== "") {
    parts.push(`since ${status.acquiredAt}`);
  }
  if (status.pid !== undefined && status.pid !== 0) {
    parts.push(`pid ${status.pid}`);
  }

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function readServiceState(path: string): Effect.Effect<ServiceState | null, never> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as ServiceState,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function writeServiceState(path: string, state: ServiceState): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, `${JSON.stringify(serviceStateJson(state), null, 2)}\n`);
    },
    catch: (cause) => cause,
  });
}

function serviceStateJson(state: ServiceState): Partial<ServiceState> {
  return {
    ...(state.lastArch === undefined ? {} : { lastArch: state.lastArch }),
    ...(state.lastAttemptAt === undefined ? {} : { lastAttemptAt: state.lastAttemptAt }),
    ...(state.lastAutoUpdate === undefined ? {} : { lastAutoUpdate: state.lastAutoUpdate }),
    ...(state.lastAutoUpdated === undefined ? {} : { lastAutoUpdated: state.lastAutoUpdated }),
    ...(state.lastCliVersion === undefined ? {} : { lastCliVersion: state.lastCliVersion }),
    ...(state.lastDurationMs === undefined ? {} : { lastDurationMs: state.lastDurationMs }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.lastRepairAttemptAt === undefined
      ? {}
      : { lastRepairAttemptAt: state.lastRepairAttemptAt }),
    ...(state.lastRepairCompletedAt === undefined
      ? {}
      : { lastRepairCompletedAt: state.lastRepairCompletedAt }),
    ...(state.lastRepairError === undefined ? {} : { lastRepairError: state.lastRepairError }),
    ...(state.lastRepairReason === undefined ? {} : { lastRepairReason: state.lastRepairReason }),
    ...(state.lastRepairStatus === undefined ? {} : { lastRepairStatus: state.lastRepairStatus }),
    ...(state.lastRows === undefined ? {} : { lastRows: state.lastRows }),
    ...(state.lastSchedulerActive === undefined
      ? {}
      : { lastSchedulerActive: state.lastSchedulerActive }),
    ...(state.lastSince === undefined ? {} : { lastSince: state.lastSince }),
    ...(state.lastSources === undefined ? {} : { lastSources: state.lastSources }),
    ...(state.lastSyncStatus === undefined ? {} : { lastSyncStatus: state.lastSyncStatus }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastUpserted === undefined ? {} : { lastUpserted: state.lastUpserted }),
    ...(state.reloadRequired === undefined ? {} : { reloadRequired: state.reloadRequired }),
    version: state.version,
  };
}

function commandExists(command: string): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => (await findCommandOnPath(command, process.env, process.platform)) !== null,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function runServiceAutoUpdate(
  metadata: ServiceMetadata | null,
  options: {
    currentVersion: string;
    json?: boolean | undefined;
    paths?: ServicePaths | undefined;
  },
  runtime: ServiceAutoUpdateRuntime = {},
): Effect.Effect<ServiceAutoUpdateReport, never, ConsoleService> {
  return Effect.gen(function* () {
    const now = runtime.now ?? (() => new Date());
    const attemptedAt = now().toISOString();

    if (metadata === null) {
      const latestVersion = yield* (runtime.fetchLatestVersion ?? fetchLatestCliVersion)();
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: false,
        latestVersion,
        manager: null,
        reason: "metadata-missing",
        status: "skipped",
      });
    }

    if (metadata.autoUpdateManager === "registry" || metadata.runnerTarget !== undefined) {
      return yield* runServiceRunnerAutoUpdate(metadata, options, runtime, now, attemptedAt);
    }

    return yield* runLegacyPackageManagerAutoUpdate(metadata, options, runtime, now, attemptedAt);
  });
}

function runLegacyPackageManagerAutoUpdate(
  metadata: ServiceMetadata,
  options: {
    currentVersion: string;
    json?: boolean | undefined;
  },
  runtime: ServiceAutoUpdateRuntime,
  now: () => Date,
  attemptedAt: string,
): Effect.Effect<ServiceAutoUpdateReport, never, ConsoleService> {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const fetchLatestVersion = runtime.fetchLatestVersion ?? fetchLatestCliVersion;
    const commandExists_ = runtime.commandExists ?? commandExists;
    const runUpdate = runtime.runPackageManagerUpdate ?? runPackageManagerUpdate;
    const readInstalledVersion = runtime.readInstalledVersion ?? readInstalledCliVersion;
    const latestVersion = yield* fetchLatestVersion();

    if (latestVersion === null) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion,
        manager: metadata.autoUpdateManager ?? null,
        reason: "latest-unknown",
        status: "skipped",
      });
    }

    if (normalizeVersion(options.currentVersion) === normalizeVersion(latestVersion)) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        installedVersion: options.currentVersion,
        latestVersion,
        manager: metadata.autoUpdateManager ?? null,
        reason: null,
        status: "not-needed",
      });
    }

    const manager = metadata.autoUpdateManager;
    if (manager === undefined || manager === null) {
      if (!options.json) {
        yield* Effect.sync(() => {
          console.log("Auto-update skipped; package manager was not detected");
        });
      }
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion,
        manager: null,
        reason: "manager-missing",
        status: "skipped",
      });
    }
    if (manager === "registry") {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion,
        manager,
        reason: "platform-package-missing",
        status: "failure",
      });
    }

    const managerExists = yield* commandExists_(manager);
    if (!managerExists) {
      if (!options.json) {
        yield* Effect.sync(() => {
          console.log(`Auto-update skipped; ${manager} not found`);
        });
      }
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion,
        manager,
        reason: "manager-not-found",
        status: "skipped",
      });
    }

    const updateResult = yield* runUpdate(manager).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: () => ({ _tag: "success" as const }),
      }),
    );
    if (updateResult._tag === "failure") {
      if (!options.json) {
        yield* Effect.sync(() => {
          console.log(`Auto-update failed; continuing with sync`);
        });
      }

      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        error: formatAutoUpdateError(updateResult.cause),
        latestVersion,
        manager,
        reason: "package-manager-failed",
        status: "failure",
      });
    }

    const installedVersion = yield* readInstalledVersion(metadata.commandPath);
    if (
      installedVersion === null ||
      normalizeVersion(installedVersion) !== normalizeVersion(latestVersion)
    ) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        installedVersion,
        latestVersion,
        manager,
        reason: "version-unchanged",
        status: "failure",
      });
    }

    return serviceAutoUpdateReport({
      attemptedAt,
      completedAt: now().toISOString(),
      currentVersion: options.currentVersion,
      enabled: true,
      installedVersion,
      latestVersion,
      manager,
      reason: null,
      status: "success",
    });
  });
}

function runServiceRunnerAutoUpdate(
  metadata: ServiceMetadata,
  options: {
    currentVersion: string;
    json?: boolean | undefined;
    paths?: ServicePaths | undefined;
  },
  runtime: ServiceAutoUpdateRuntime,
  now: () => Date,
  attemptedAt: string,
): Effect.Effect<ServiceAutoUpdateReport, never, ConsoleService> {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const detectedTargets = runtime.runnerTargetCandidates?.() ?? serviceRunnerTargetCandidates();
    const metadataTarget = parseServiceRunnerTarget(metadata.runnerTarget);
    const targets =
      detectedTargets.length > 0
        ? detectedTargets
        : metadataTarget === null
          ? []
          : [metadataTarget];
    if (targets.length === 0 || options.paths === undefined) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion: null,
        manager: "registry",
        reason: "platform-package-missing",
        status: "failure",
      });
    }
    const paths = options.paths;

    const runnerChannel = serviceRunnerReleaseChannel(options.currentVersion);
    const fetchRunnerRelease = runtime.fetchRunnerRelease ?? fetchServiceRunnerRelease;
    let release: ServiceRunnerRelease | null = null;
    for (const target of targets) {
      const fetchResult = yield* fetchRunnerRelease(target, runnerChannel).pipe(
        Effect.match({
          onFailure: (cause) => ({ _tag: "failure" as const, cause }),
          onSuccess: (value) => ({ _tag: "success" as const, value }),
        }),
      );
      if (fetchResult._tag === "failure") {
        return serviceAutoUpdateReport({
          attemptedAt,
          completedAt: now().toISOString(),
          currentVersion: options.currentVersion,
          enabled: true,
          error: formatAutoUpdateError(fetchResult.cause.cause),
          latestVersion: null,
          manager: "registry",
          reason: fetchResult.cause.reason,
          status: "failure",
        });
      }

      const candidate = fetchResult.value;
      if (candidate !== null) {
        release = candidate;
        break;
      }
    }

    if (release === null) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion: null,
        manager: "registry",
        reason: "platform-package-missing",
        status: "skipped",
      });
    }

    if (!serviceRunnerReleaseIsUpdateCandidate(options.currentVersion, release.version)) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        installedVersion: options.currentVersion,
        latestVersion: release.version,
        manager: "registry",
        reason: null,
        status: "not-needed",
      });
    }

    const updateLock = yield* acquireServiceUpdateLock(paths.updateLockPath, now()).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: (lock) => ({ _tag: "success" as const, lock }),
      }),
    );
    if (updateLock._tag === "failure") {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        error: formatAutoUpdateError(updateLock.cause),
        latestVersion: release.version,
        manager: "registry",
        reason: "install-failed",
        status: "failure",
      });
    }
    if (updateLock.lock._tag === "locked") {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        error: new ServiceUpdateLockedError({ status: updateLock.lock.status }).message,
        latestVersion: release.version,
        manager: "registry",
        reason: "install-failed",
        status: "failure",
      });
    }

    return yield* Effect.gen(function* () {
      const installed = yield* (runtime.installRunnerRelease ?? stageServiceRunnerFromRegistry)(
        release,
        paths,
      ).pipe(
        Effect.match({
          onFailure: (cause) => ({ _tag: "failure" as const, cause }),
          onSuccess: (value) => ({ _tag: "success" as const, value }),
        }),
      );

      if (installed._tag === "failure") {
        if (!options.json) {
          yield* Effect.sync(() => {
            console.log("Auto-update failed; continuing with sync");
          });
        }
        const serviceError = serviceRunnerUpdateError(installed.cause);

        return serviceAutoUpdateReport({
          attemptedAt,
          completedAt: now().toISOString(),
          currentVersion: options.currentVersion,
          enabled: true,
          error: formatAutoUpdateError(serviceError?.cause ?? installed.cause),
          latestVersion: release.version,
          manager: "registry",
          reason: serviceError?.reason ?? "install-failed",
          status: "failure",
        });
      }

      const metadataWrite = yield* writeServiceMetadataRunner(
        paths.metadataPath,
        metadata,
        installed.value,
      ).pipe(
        Effect.match({
          onFailure: (cause) => ({ _tag: "failure" as const, cause }),
          onSuccess: () => ({ _tag: "success" as const }),
        }),
      );
      if (metadataWrite._tag === "failure") {
        return serviceAutoUpdateReport({
          attemptedAt,
          completedAt: now().toISOString(),
          currentVersion: options.currentVersion,
          enabled: true,
          error: formatAutoUpdateError(metadataWrite.cause),
          latestVersion: release.version,
          manager: "registry",
          reason: "install-failed",
          status: "failure",
        });
      }

      const pointerWrite = yield* writeServiceRunnerPointer(paths, installed.value.path).pipe(
        Effect.match({
          onFailure: (cause) => ({ _tag: "failure" as const, cause }),
          onSuccess: () => ({ _tag: "success" as const }),
        }),
      );
      if (pointerWrite._tag === "failure") {
        return serviceAutoUpdateReport({
          attemptedAt,
          completedAt: now().toISOString(),
          currentVersion: options.currentVersion,
          enabled: true,
          error: formatAutoUpdateError(pointerWrite.cause),
          latestVersion: release.version,
          manager: "registry",
          reason: "install-failed",
          status: "failure",
        });
      }

      yield* cleanupServiceRunnerVersions(paths, [
        installed.value.version,
        metadata.runnerVersion,
      ]).pipe(Effect.ignore);

      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        installedVersion: installed.value.version,
        latestVersion: release.version,
        manager: "registry",
        reason: null,
        status: "success",
      });
    }).pipe(
      Effect.ensuring(releaseServiceRunLock(paths.updateLockPath, updateLock.lock.lock.ownerId)),
    );
  });
}

function serviceAutoUpdateReport(input: ServiceAutoUpdateReport): ServiceAutoUpdateReport {
  return {
    attemptedAt: input.attemptedAt ?? null,
    completedAt: input.completedAt ?? null,
    currentVersion: input.currentVersion ?? null,
    enabled: input.enabled,
    error: input.error ?? null,
    installedVersion: input.installedVersion ?? null,
    latestVersion: input.latestVersion ?? null,
    manager: input.manager,
    reason: input.reason,
    status: input.status,
  };
}

function fetchLatestCliVersion(): Effect.Effect<string | null, never> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(NPM_LATEST_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SERVICE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }

      return versionFromPackageJson(await response.json());
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function fetchServiceRunnerRelease(
  target: ServiceRunnerTarget,
  versionSpecifier: string,
): Effect.Effect<ServiceRunnerRelease | null, ServiceRunnerUpdateError> {
  return Effect.tryPromise({
    try: async () => {
      const packageName = serviceRunnerPackageName(target);
      const response = await fetch(
        `${npmRegistryPackageUrl(packageName)}/${encodeURIComponent(versionSpecifier)}`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(SERVICE_FETCH_TIMEOUT_MS),
        },
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new ServiceRunnerUpdateError({
          cause: `registry returned ${response.status}`,
          reason: "download-failed",
        });
      }

      const release = serviceRunnerReleaseFromPackageJson(
        await response.json(),
        target,
        packageName,
      );
      if (release === null) {
        throw new ServiceRunnerUpdateError({
          cause: "registry response missing service runner release metadata",
          reason: "download-failed",
        });
      }

      return release;
    },
    catch: (cause) =>
      cause instanceof ServiceRunnerUpdateError
        ? cause
        : new ServiceRunnerUpdateError({ cause, reason: "download-failed" }),
  });
}

function npmRegistryPackageUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
}

function serviceRunnerReleaseFromPackageJson(
  body: unknown,
  target: ServiceRunnerTarget,
  packageName: string,
): ServiceRunnerRelease | null {
  if (body === null || typeof body !== "object") {
    return null;
  }

  const version = (body as { version?: unknown }).version;
  const dist = (body as { dist?: unknown }).dist;
  if (
    typeof version !== "string" ||
    parseServiceVersion(version) === null ||
    dist === null ||
    typeof dist !== "object"
  ) {
    return null;
  }

  const tarballUrl = (dist as { tarball?: unknown }).tarball;
  const integrity = (dist as { integrity?: unknown }).integrity;
  if (typeof tarballUrl !== "string" || typeof integrity !== "string") {
    return null;
  }

  return {
    integrity,
    packageName,
    tarballUrl,
    target,
    version,
  };
}

function installServiceRunnerFromRegistry(
  release: ServiceRunnerRelease,
  paths: ServicePaths,
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return stageServiceRunnerFromRegistry(release, paths).pipe(
    Effect.tap((install) => writeServiceRunnerPointer(paths, install.path)),
  );
}

function stageServiceRunnerFromRegistry(
  release: ServiceRunnerRelease,
  paths: ServicePaths,
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const tarballBytes = await downloadServiceRunnerTarball(release);
      if (!verifyNpmIntegrity(tarballBytes, release.integrity)) {
        throw new ServiceRunnerUpdateError({
          cause: "npm integrity verification failed",
          reason: "integrity-mismatch",
        });
      }

      const platform = platformForServiceRunnerTarget(release.target);
      const runnerBytes = await extractServiceRunnerFromTarball(
        tarballBytes,
        serviceRunnerBinaryName(platform),
      );
      const destinationPath = serviceRunnerPath(paths, release.version, release.target, platform);
      await installServiceRunnerBinary({
        destinationPath,
        packageName: release.packageName,
        paths,
        platform,
        sourceBytes: runnerBytes,
        target: release.target,
        updatePointer: false,
        version: release.version,
      });

      return {
        packageName: release.packageName,
        path: destinationPath,
        target: release.target,
        version: release.version,
      };
    },
    catch: (cause) =>
      cause instanceof ServiceRunnerUpdateError
        ? cause
        : new ServiceRunnerUpdateError({ cause, reason: "install-failed" }),
  });
}

async function downloadServiceRunnerTarball(release: ServiceRunnerRelease): Promise<Uint8Array> {
  try {
    const response = await fetch(release.tarballUrl, {
      headers: { accept: "application/octet-stream" },
      signal: AbortSignal.timeout(SERVICE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`registry returned ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw new ServiceRunnerUpdateError({ cause, reason: "download-failed" });
  }
}

function verifyNpmIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const candidates = integrity
    .trim()
    .split(/\s+/)
    .map((part) => {
      const separator = part.indexOf("-");
      return separator === -1
        ? null
        : { algorithm: part.slice(0, separator), expected: part.slice(separator + 1) };
    })
    .filter(
      (part): part is { algorithm: string; expected: string } =>
        part !== null && ["sha512", "sha384", "sha256", "sha1"].includes(part.algorithm),
    );

  return candidates.some((candidate) => {
    const actual = createHash(candidate.algorithm).update(bytes).digest("base64");
    return actual === candidate.expected;
  });
}

async function extractServiceRunnerFromTarball(
  tarballBytes: Uint8Array,
  binaryName: string,
): Promise<Uint8Array> {
  const tarBytes = await gunzipPromise(Buffer.from(tarballBytes));
  const expectedPath = `package/bin/${binaryName}`;

  for (let offset = 0; offset + 512 <= tarBytes.length; offset += 512) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const entryPath = tarHeaderPath(header);
    const size = tarHeaderSize(header);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;
    if (entryPath === null || nextOffset > tarBytes.length) {
      throw new ServiceRunnerUpdateError({
        cause: "invalid tar entry",
        reason: "install-failed",
      });
    }
    if (entryPath === expectedPath) {
      return new Uint8Array(tarBytes.subarray(dataOffset, dataOffset + size));
    }
    offset = nextOffset - 512;
  }

  throw new ServiceRunnerUpdateError({
    cause: `tarball missing ${expectedPath}`,
    reason: "install-failed",
  });
}

function tarHeaderPath(header: Buffer): string | null {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || parts.some((part) => part === "..")) {
    throw new ServiceRunnerUpdateError({
      cause: `unsafe tar entry path ${path}`,
      reason: "install-failed",
    });
  }

  return normalized;
}

function tarHeaderSize(header: Buffer): number {
  const rawSize = tarString(header.subarray(124, 136)).trim();
  const size = Number.parseInt(rawSize || "0", 8);
  if (!Number.isFinite(size) || size < 0) {
    throw new ServiceRunnerUpdateError({
      cause: `invalid tar entry size ${rawSize}`,
      reason: "install-failed",
    });
  }

  return size;
}

function tarString(bytes: Buffer): string {
  const zero = bytes.indexOf(0);
  const end = zero === -1 ? bytes.length : zero;
  return bytes.subarray(0, end).toString("utf8");
}

function serviceRunnerUpdateError(cause: unknown): ServiceRunnerUpdateError | null {
  return cause instanceof ServiceRunnerUpdateError ? cause : null;
}

function writeServiceMetadataRunner(
  path: string,
  metadata: ServiceMetadata,
  runner: ServiceRunnerInstall,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () =>
      writeFileAtomic(
        path,
        `${JSON.stringify(
          {
            ...metadata,
            autoUpdateManager: "registry",
            commandPath: runner.path,
            resolvedCommandPath: undefined,
            runnerPackage: runner.packageName,
            runnerPath: runner.path,
            runnerTarget: runner.target,
            runnerVersion: runner.version,
            templateVersion: SERVICE_TEMPLATE_VERSION,
            version: 1,
          } satisfies ServiceMetadata,
          null,
          2,
        )}\n`,
      ),
    catch: (cause) => cause,
  });
}

function cleanupServiceRunnerVersions(
  paths: ServicePaths,
  versions: readonly (string | undefined)[],
): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const keep = new Set(versions.filter((version): version is string => version !== undefined));
      if (keep.size === 0) {
        return;
      }

      const entries = await readdir(paths.runnersDir, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
          .map((entry) => rm(join(paths.runnersDir, entry.name), { force: true, recursive: true })),
      );
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void));
}

function readInstalledCliVersion(commandPath: string): Effect.Effect<string | null, never> {
  return Effect.tryPromise({
    try: async () => {
      const { stderr, stdout } = await execFilePromise(commandPath, ["--version"], {
        timeout: SERVICE_VERSION_TIMEOUT_MS,
        windowsHide: true,
      });

      return parseCliVersion(`${stdout}\n${stderr}`);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function versionFromPackageJson(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }

  const version = (body as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function parseCliVersion(output: string): string | null {
  const match = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1] ?? null;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").replace(/\+.*/, "");
}

interface ParsedServiceVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

function serviceRunnerReleaseChannel(version: string): string {
  const parsed = parseServiceVersion(version);
  return parsed === null || parsed.prerelease.length === 0 ? "latest" : parsed.prerelease[0]!;
}

function serviceRunnerReleaseIsNewer(currentVersion: string, candidateVersion: string): boolean {
  const comparison = compareServiceVersions(currentVersion, candidateVersion);
  return comparison !== null && comparison < 0;
}

function serviceRunnerReleaseIsUpdateCandidate(
  currentVersion: string,
  candidateVersion: string,
): boolean {
  return (
    serviceRunnerReleaseChannel(currentVersion) === serviceRunnerReleaseChannel(candidateVersion) &&
    serviceRunnerReleaseIsNewer(currentVersion, candidateVersion)
  );
}

function compareServiceVersions(left: string, right: string): number | null {
  const leftVersion = parseServiceVersion(left);
  const rightVersion = parseServiceVersion(right);
  if (leftVersion === null || rightVersion === null) {
    return null;
  }

  const coreDifference =
    leftVersion.major - rightVersion.major ||
    leftVersion.minor - rightVersion.minor ||
    leftVersion.patch - rightVersion.patch;
  if (coreDifference !== 0) {
    return coreDifference;
  }

  return comparePrereleaseVersions(leftVersion.prerelease, rightVersion.prerelease);
}

function parseServiceVersion(version: string): ParsedServiceVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+.+)?$/.exec(
    version.trim(),
  );
  if (match === null) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrereleaseVersions(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const difference = comparePrereleasePart(leftPart, rightPart);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = numericPrereleasePart(left);
  const rightNumber = numericPrereleasePart(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }

  return left.localeCompare(right);
}

function numericPrereleasePart(part: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(part)) {
    return null;
  }

  const value = Number(part);
  return Number.isSafeInteger(value) ? value : null;
}

function formatAutoUpdateError(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return String(cause);
}

function runPackageManagerUpdate(manager: AutoUpdateManager): Effect.Effect<void, unknown> {
  const command = autoUpdateCommand(manager);

  return runExecutable(command.command, command.args, {
    timeoutMs: SERVICE_PACKAGE_UPDATE_TIMEOUT_MS,
  });
}

function refreshServiceAfterUpdate(options: { commandPath: string }): Effect.Effect<void, unknown> {
  return runExecutable(options.commandPath, ["service", "install", "--refresh"]);
}

function readLogTail(path: string, maxLines: number): Effect.Effect<string[], never> {
  return Effect.tryPromise({
    try: async () => {
      const lines = (await readFile(path, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      return lines.slice(-maxLines);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed([])));
}

function doctorCheck(status: DoctorStatus, label: string, detail: string): DoctorCheck {
  return { detail, label, status };
}

function doctorLine(check: DoctorCheck): string {
  return `${check.status.toUpperCase().padEnd(4)} ${check.label.padEnd(12)} ${check.detail}`;
}

function formatServiceStatusAutoUpdate(metadata: ServiceMetadata | null): string {
  if (metadata === null) {
    return "unknown (service not installed)";
  }

  if (metadata.autoUpdateManager === "registry") {
    return "enabled via registry";
  }

  if (metadata.autoUpdateManager !== undefined && metadata.autoUpdateManager !== null) {
    return `enabled via ${metadata.autoUpdateManager}`;
  }

  return "enabled (package manager not detected)";
}

function formatInstallAutoUpdate(manager: ServiceMetadataAutoUpdateManager | null): string {
  if (manager === "registry") {
    return "enabled via registry runner packages";
  }

  return manager === null
    ? "enabled, but package manager was not detected"
    : `enabled via ${manager} (${autoUpdateCommandDescription(manager)})`;
}

function doctorAuthDetail(envToken: boolean, authConfig: DoctorAuthConfig): string {
  if (envToken) {
    return "TOKENMAXXING_API_TOKEN is set; service install needs stored login instead";
  }

  if (authConfig._tag === "error") {
    return `could not read config (${String(authConfig.cause)})`;
  }

  if (!authConfig.value.token) {
    return "stored token missing; run tokenmaxxing login";
  }

  return authConfig.value.deviceId === undefined
    ? "stored token present; device id will be created on next sync"
    : "stored token and device id present";
}

function doctorBinaryDetail(
  metadata: ServiceMetadata | null,
  metadataCommandExists: boolean,
  currentCommand: CommandInstall | null,
): string {
  if (metadata?.commandPath !== undefined) {
    return metadataCommandExists
      ? `${metadata.commandPath}${metadata.resolvedCommandPath === undefined ? "" : ` -> ${metadata.resolvedCommandPath}`}`
      : `missing at installed path: ${metadata.commandPath}`;
  }

  if (currentCommand !== null) {
    return `${currentCommand.commandPath} -> ${currentCommand.resolvedCommandPath}`;
  }

  return "tokenmaxxing not found on PATH";
}

function doctorAutoUpdateDetail(
  metadata: ServiceMetadata | null,
  autoUpdateManager: ServiceMetadataAutoUpdateManager | null | undefined,
  managerExists: boolean,
): string {
  if (metadata === null) {
    return "checked when service is installed";
  }

  if (autoUpdateManager === "registry") {
    return "enabled via registry runner packages";
  }

  if (autoUpdateManager === null || autoUpdateManager === undefined) {
    return "enabled but package manager was not detected";
  }

  return managerExists
    ? `enabled via ${autoUpdateManager} (${autoUpdateCommandDescription(autoUpdateManager)})`
    : `enabled via ${autoUpdateManager}, but ${autoUpdateManager} is not on PATH`;
}

function doctorAutoUpdateStatus(
  metadata: ServiceMetadata | null,
  managerExists: boolean,
): DoctorStatus {
  if (metadata === null) {
    return "info";
  }

  if (metadata.autoUpdateManager === "registry") {
    return "ok";
  }

  return managerExists ? "ok" : "warn";
}

function serviceRunCommandArgs(): string {
  return "service run --scheduled";
}

function windowsTaskName(): string {
  return WINDOWS_TASK_NAME;
}

function legacyWindowsTaskName(time: ScheduleTime): string {
  return `${WINDOWS_TASK_NAME}-${formatScheduleTime(time).replace(":", "")}`;
}

function windowsTaskNames(): string[] {
  return [windowsTaskName(), ...LEGACY_SCHEDULE_TIMES.map((time) => legacyWindowsTaskName(time))];
}

function renderLaunchdStartInterval(): string {
  return String(SERVICE_INTERVAL_SECONDS);
}

function renderSystemdTimerSchedule(): string {
  return [
    `OnBootSec=${SERVICE_INTERVAL_MINUTES}min`,
    `OnUnitActiveSec=${SERVICE_INTERVAL_MINUTES}min`,
  ].join("\n");
}

function formatScheduleTime(time: ScheduleTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function scheduleDescription(): string {
  return `syncs every ${SERVICE_INTERVAL_MINUTES} minutes`;
}

function servicePathsEffect(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  platform = process.platform,
): Effect.Effect<ServicePaths, ServiceUnsupportedPlatformError> {
  const paths = servicePaths({ env, home, platform });

  return paths === null
    ? Effect.fail(new ServiceUnsupportedPlatformError({ platform }))
    : Effect.succeed(paths);
}

function servicePaths({
  env = process.env,
  home = homedir(),
  platform = process.platform,
}: {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
} = {}): ServicePaths | null {
  const backend = backendForPlatform(platform);
  if (backend === null) {
    return null;
  }

  const configDir = dirname(getConfigPath(env));
  const wrapperPath = join(
    configDir,
    platform === "win32" ? WINDOWS_WRAPPER_NAME : POSIX_WRAPPER_NAME,
  );
  const logPath = join(configDir, "service.log");
  const lockPath = join(configDir, "service.lock");
  const metadataPath = join(configDir, "service.json");
  const runnerPointerPath = join(configDir, SERVICE_RUNNER_POINTER_NAME);
  const runnersDir = join(configDir, SERVICE_RUNNER_DIR_NAME);
  const statePath = join(configDir, "service-state.json");
  const updateLockPath = join(configDir, "service-update.lock");

  if (backend === "launchd") {
    return {
      backend,
      configDir,
      definitionPath: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      lockPath,
      logPath,
      metadataPath,
      runnerPointerPath,
      runnersDir,
      statePath,
      updateLockPath,
      wrapperPath,
    };
  }

  if (backend === "systemd") {
    const systemdDir = join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "systemd", "user");
    return {
      backend,
      configDir,
      definitionPath: join(systemdDir, `${SYSTEMD_NAME}.service`),
      lockPath,
      logPath,
      metadataPath,
      runnerPointerPath,
      runnersDir,
      statePath,
      updateLockPath,
      wrapperPath,
    };
  }

  return {
    backend,
    configDir,
    definitionPath: null,
    lockPath,
    logPath,
    metadataPath,
    runnerPointerPath,
    runnersDir,
    statePath,
    updateLockPath,
    wrapperPath,
  };
}

function backendForPlatform(platform: NodeJS.Platform): ServiceBackend | null {
  if (platform === "darwin") {
    return "launchd";
  }

  if (platform === "linux") {
    return "systemd";
  }

  if (platform === "win32") {
    return "windows-task-scheduler";
  }

  return null;
}

function serviceRunnerPath(
  paths: ServicePaths,
  version: string,
  target: ServiceRunnerTarget,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(paths.runnersDir, version, target, serviceRunnerBinaryName(platform));
}

function installServiceRunnerFromOptionalPackage(
  paths: ServicePaths,
  options: ServiceRunnerHostOptions & {
    resolvePackageJson?: ((packageName: string) => string | null) | undefined;
    updatePointer?: boolean | undefined;
  } = {},
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const platform = options.platform ?? process.platform;
      const targets = serviceRunnerTargetCandidates({
        avx2: options.avx2,
        cpuArch: options.cpuArch ?? arch(),
        libc: options.libc,
        platform,
      });
      if (targets.length === 0) {
        throw new ServiceRunnerUnsupportedTargetError({
          arch: options.cpuArch ?? arch(),
          platform,
        });
      }

      const missingPackageNames: string[] = [];
      for (const target of targets) {
        const packageName = serviceRunnerPackageName(target);
        const packageJsonPath = (options.resolvePackageJson ?? resolveServiceRunnerPackageJson)(
          packageName,
        );
        if (packageJsonPath === null) {
          missingPackageNames.push(packageName);
          continue;
        }

        const targetPlatform = platformForServiceRunnerTarget(target);
        const packageDirectory = dirname(packageJsonPath);
        const packageMetadata = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
          version?: unknown;
        };
        const version =
          typeof packageMetadata.version === "string" && packageMetadata.version.length > 0
            ? packageMetadata.version
            : packageJson.version;
        const sourcePath = join(packageDirectory, "bin", serviceRunnerBinaryName(targetPlatform));
        await access(sourcePath, constants.F_OK);

        const destinationPath = serviceRunnerPath(paths, version, target, targetPlatform);
        await installServiceRunnerBinary({
          destinationPath,
          packageName,
          paths,
          platform: targetPlatform,
          sourcePath,
          target,
          updatePointer: options.updatePointer,
          version,
        });

        return {
          packageName,
          path: destinationPath,
          target,
          version,
        };
      }

      throw new ServiceRunnerPackageMissingError({ packageNames: missingPackageNames });
    },
    catch: (cause) => cause,
  });
}

function installServiceRunnerFromRegistryCandidates(
  paths: ServicePaths,
  options: ServiceRunnerHostOptions & {
    fetchRunnerRelease?:
      | ((
          target: ServiceRunnerTarget,
          versionSpecifier: string,
        ) => Effect.Effect<ServiceRunnerRelease | null, ServiceRunnerUpdateError>)
      | undefined;
    installRunnerRelease?:
      | ((
          release: ServiceRunnerRelease,
          paths: ServicePaths,
        ) => Effect.Effect<ServiceRunnerInstall, unknown>)
      | undefined;
    runnerVersion?: string | undefined;
    updatePointer?: boolean | undefined;
  } = {},
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return Effect.gen(function* () {
    const platform = options.platform ?? process.platform;
    const targets = serviceRunnerTargetCandidates({
      avx2: options.avx2,
      cpuArch: options.cpuArch ?? arch(),
      libc: options.libc,
      platform,
    });
    if (targets.length === 0) {
      return yield* Effect.fail(
        new ServiceRunnerUnsupportedTargetError({
          arch: options.cpuArch ?? arch(),
          platform,
        }),
      );
    }

    const runnerVersion = options.runnerVersion ?? packageJson.version;
    const fetchRunnerRelease = options.fetchRunnerRelease ?? fetchServiceRunnerRelease;
    const installRunnerRelease =
      options.installRunnerRelease ??
      (options.updatePointer === false
        ? stageServiceRunnerFromRegistry
        : installServiceRunnerFromRegistry);
    const missingPackageNames: string[] = [];
    for (const target of targets) {
      const release = yield* fetchRunnerRelease(target, runnerVersion);
      if (release === null) {
        missingPackageNames.push(serviceRunnerPackageName(target));
        continue;
      }

      return yield* installRunnerRelease(release, paths);
    }

    return yield* Effect.fail(
      new ServiceRunnerPackageMissingError({ packageNames: missingPackageNames }),
    );
  });
}

function installServiceRunner(
  paths: ServicePaths,
  options: Parameters<typeof installServiceRunnerFromOptionalPackage>[1] &
    Parameters<typeof installServiceRunnerFromRegistryCandidates>[1] = {},
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return installServiceRunnerFromOptionalPackage(paths, options).pipe(
    Effect.catch((cause) =>
      cause instanceof ServiceRunnerPackageMissingError
        ? installServiceRunnerFromRegistryCandidates(paths, options)
        : Effect.fail(cause),
    ),
  );
}

function installServiceRunnerForRepair(
  paths: ServicePaths,
  options: Parameters<typeof installServiceRunner>[1] = {},
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return installServiceRunnerFromOptionalPackage(paths, options).pipe(
    Effect.catch((optionalCause) =>
      readCurrentServiceRunnerInstall(paths).pipe(
        Effect.catch(() =>
          optionalCause instanceof ServiceRunnerPackageMissingError
            ? installServiceRunnerFromRegistryCandidates(paths, options)
            : Effect.fail(optionalCause),
        ),
      ),
    ),
  );
}

function readCurrentServiceRunnerInstall(
  paths: ServicePaths,
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const pointerPath = (await readFile(paths.runnerPointerPath, "utf8")).trim();
      if (pointerPath.length === 0) {
        throw new ServiceRunnerPackageMissingError({ packageName: SERVICE_RUNNER_POINTER_NAME });
      }
      await access(pointerPath, constants.F_OK);

      const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as ServiceMetadata;
      const target = parseServiceRunnerTarget(metadata.runnerTarget) ?? serviceRunnerTarget();
      if (target === null) {
        throw new ServiceRunnerUnsupportedTargetError({
          arch: arch(),
          platform: process.platform,
        });
      }

      return {
        packageName: metadata.runnerPackage ?? serviceRunnerPackageName(target),
        path: pointerPath,
        target,
        version: metadata.runnerVersion ?? packageJson.version,
      };
    },
    catch: (cause) => cause,
  });
}

function resolveServiceRunnerPackageJson(packageName: string): string | null {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return resolveExecutableSiblingPackageJson(packageName);
  }
}

function resolveExecutableSiblingPackageJson(
  packageName: string,
  binaryPaths: readonly (string | undefined)[] = [process.execPath, process.argv[1]],
): string | null {
  for (const binaryPath of binaryPaths) {
    if (binaryPath === undefined) {
      continue;
    }

    const packageDir = packageDirFromBinPath(binaryPath);
    if (packageDir === null) {
      continue;
    }

    const nestedCandidate = nestedPackageJsonPath(packageDir, packageName);
    if (nestedCandidate !== null && existsSync(nestedCandidate)) {
      return nestedCandidate;
    }

    const candidate = siblingPackageJsonPath(packageDir, packageName);
    if (candidate !== null && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function packageDirFromBinPath(binaryPath: string): string | null {
  const resolvedPath = realpathSyncOrOriginal(binaryPath);
  const binDir = dirname(resolvedPath);
  return basename(binDir) === "bin" ? dirname(binDir) : null;
}

function nestedPackageJsonPath(packageDir: string, packageName: string): string | null {
  const parts = packageName.split("/");
  if (parts.length === 1) {
    return join(packageDir, "node_modules", packageName, "package.json");
  }

  if (parts.length === 2 && parts[0]?.startsWith("@")) {
    return join(packageDir, "node_modules", parts[0], parts[1]!, "package.json");
  }

  return null;
}

function realpathSyncOrOriginal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function siblingPackageJsonPath(packageDir: string, packageName: string): string | null {
  const parts = packageName.split("/");
  if (parts.length === 1) {
    return join(dirname(packageDir), packageName, "package.json");
  }

  if (parts.length === 2 && parts[0]?.startsWith("@")) {
    const scopeDir = basename(dirname(packageDir)) === parts[0] ? dirname(packageDir) : null;
    return scopeDir === null ? null : join(scopeDir, parts[1]!, "package.json");
  }

  return null;
}

async function installServiceRunnerBinary(input: {
  destinationPath: string;
  packageName: string;
  paths: ServicePaths;
  platform: NodeJS.Platform;
  sourceBytes?: Uint8Array | undefined;
  sourcePath?: string | undefined;
  target: ServiceRunnerTarget;
  updatePointer?: boolean | undefined;
  version: string;
}): Promise<void> {
  await mkdir(dirname(input.destinationPath), { recursive: true });
  if (input.sourceBytes !== undefined) {
    await writeFileAtomic(input.destinationPath, input.sourceBytes, executableMode(input.platform));
  } else if (input.sourcePath !== undefined) {
    await copyFileAtomic(input.sourcePath, input.destinationPath, executableMode(input.platform));
  } else {
    throw new Error("missing service runner source");
  }
  if (input.updatePointer !== false) {
    await writeFileAtomic(input.paths.runnerPointerPath, `${input.destinationPath}\n`);
  }
}

function writeServiceRunnerPointer(
  paths: ServicePaths,
  runnerPath: string,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => writeFileAtomic(paths.runnerPointerPath, `${runnerPath}\n`),
    catch: (cause) => cause,
  });
}

function executableMode(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" ? undefined : 0o755;
}

function renderServiceWrapper({
  env,
  logPath,
  platform,
  runnerPointerPath,
}: {
  env: Record<string, string>;
  logPath: string;
  platform: NodeJS.Platform;
  runnerPointerPath: string;
}): string {
  return platform === "win32"
    ? renderWindowsWrapper({ env, logPath, runnerPointerPath })
    : renderPosixWrapper({ env, logPath, runnerPointerPath });
}

function renderPosixWrapper({
  env,
  logPath,
  runnerPointerPath,
}: {
  env: Record<string, string>;
  logPath: string;
  runnerPointerPath: string;
}): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");

  return `#!/bin/sh
set -eu
${exports}

${renderPosixLogRotation(logPath)}

{
  printf '\\n[%s] tokenmaxxing service sync\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ ! -r ${shellQuote(runnerPointerPath)} ]; then
    printf 'tokenmaxxing service runner pointer missing: %s\\n' ${shellQuote(runnerPointerPath)} >&2
    exit 127
  fi
  runner=$(tr -d '\\r\\n' < ${shellQuote(runnerPointerPath)})
  if [ -z "$runner" ] || [ ! -x "$runner" ]; then
    printf 'tokenmaxxing service runner missing or not executable: %s\\n' "$runner" >&2
    exit 127
  fi
  "$runner" ${serviceRunCommandArgs()}
} >> ${shellQuote(logPath)} 2>&1
`;
}

function renderPosixLogRotation(logPath: string): string {
  const quotedLogPath = shellQuote(logPath);

  return `rotate_tokenmaxxing_log() {
  log=$1
  [ -f "$log" ] || return 0
  size=$(wc -c < "$log" 2>/dev/null | tr -d ' ' || printf '0')
  case "$size" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$size" -lt ${SERVICE_LOG_MAX_BYTES} ] && return 0

  rm -f "$log.${SERVICE_LOG_ROTATIONS}" 2>/dev/null || true
  i=${SERVICE_LOG_ROTATIONS}
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    if [ -f "$log.$prev" ]; then
      mv "$log.$prev" "$log.$i" 2>/dev/null || true
    fi
    i=$prev
  done
  mv "$log" "$log.1" 2>/dev/null || true
}

rotate_tokenmaxxing_log ${quotedLogPath} || true`;
}

function renderWindowsWrapper({
  env,
  logPath,
  runnerPointerPath,
}: {
  env: Record<string, string>;
  logPath: string;
  runnerPointerPath: string;
}): string {
  const sets = Object.entries(env)
    .map(([key, value]) => `set "${key}=${escapeCmdSetValue(value)}"`)
    .join("\r\n");

  return `@echo off\r
setlocal\r
${sets}\r
${renderWindowsLogRotation(logPath)}\r
>> ${cmdQuote(logPath)} echo [%DATE% %TIME%] tokenmaxxing service sync\r
set /p TOKENMAXXING_SERVICE_RUNNER=<${cmdQuote(runnerPointerPath)}\r
if "%TOKENMAXXING_SERVICE_RUNNER%"=="" (\r
  >> ${cmdQuote(logPath)} echo tokenmaxxing service runner pointer is empty\r
  exit /b 127\r
)\r
if not exist "%TOKENMAXXING_SERVICE_RUNNER%" (\r
  >> ${cmdQuote(logPath)} echo tokenmaxxing service runner missing: %TOKENMAXXING_SERVICE_RUNNER%\r
  exit /b 127\r
)\r
"%TOKENMAXXING_SERVICE_RUNNER%" ${serviceRunCommandArgs()} >> ${cmdQuote(logPath)} 2>&1\r
exit /b %ERRORLEVEL%\r
`;
}

function renderWindowsLogRotation(logPath: string): string {
  const quotedLogPath = cmdQuote(logPath);
  const moves = Array.from({ length: SERVICE_LOG_ROTATIONS - 1 }, (_, index) => {
    const rotation = SERVICE_LOG_ROTATIONS - index;
    const previousRotation = rotation - 1;

    return `  if exist "%TOKENMAXXING_LOG%.${previousRotation}" move /y "%TOKENMAXXING_LOG%.${previousRotation}" "%TOKENMAXXING_LOG%.${rotation}" >nul 2>nul`;
  }).join("\r\n");

  return `set "TOKENMAXXING_LOG=${escapeCmdSetValue(logPath)}"\r
if exist ${quotedLogPath} for %%A in (${quotedLogPath}) do if %%~zA GEQ ${SERVICE_LOG_MAX_BYTES} (\r
  if exist "%TOKENMAXXING_LOG%.${SERVICE_LOG_ROTATIONS}" del /f /q "%TOKENMAXXING_LOG%.${SERVICE_LOG_ROTATIONS}" >nul 2>nul\r
${moves}\r
  move /y "%TOKENMAXXING_LOG%" "%TOKENMAXXING_LOG%.1" >nul 2>nul\r
)`;
}

function renderLaunchdPlist(paths: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(paths.wrapperPath)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${renderLaunchdStartInterval()}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.logPath)}</string>
</dict>
</plist>
`;
}

function renderSystemdService(paths: ServicePaths): string {
  return `[Unit]
Description=tokenmaxxing automatic usage sync

[Service]
Type=oneshot
ExecStart=${systemdQuote(paths.wrapperPath)}
`;
}

function renderSystemdTimer(): string {
  return `[Unit]
Description=Run tokenmaxxing automatic usage sync

[Timer]
${renderSystemdTimerSchedule()}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function writeServiceFiles(
  paths: ServicePaths,
  wrapper: string,
  metadata: ServiceMetadata,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(paths.configDir, { recursive: true });
      if (paths.definitionPath !== null) {
        await mkdir(dirname(paths.definitionPath), { recursive: true });
      }

      for (const legacyWrapperPath of legacyServiceWrapperPaths(paths)) {
        await rm(legacyWrapperPath, { force: true });
      }
      await writeFileAtomic(paths.wrapperPath, wrapper);
      if (paths.backend !== "windows-task-scheduler") {
        await chmod(paths.wrapperPath, 0o755);
      }
      await writeFileAtomic(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      if (paths.backend === "launchd" && paths.definitionPath !== null) {
        await writeFileAtomic(paths.definitionPath, renderLaunchdPlist(paths));
      }
      if (paths.backend === "systemd" && paths.definitionPath !== null) {
        await writeFileAtomic(paths.definitionPath, renderSystemdService(paths));
        await writeFileAtomic(systemdTimerPath(paths.definitionPath), renderSystemdTimer());
      }
    },
    catch: (cause) => cause,
  });
}

function removeServiceFiles(paths: ServicePaths): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await rm(paths.wrapperPath, { force: true });
      for (const legacyWrapperPath of legacyServiceWrapperPaths(paths)) {
        await rm(legacyWrapperPath, { force: true });
      }
      await rm(paths.metadataPath, { force: true });
      await rm(paths.runnerPointerPath, { force: true });
      await rm(paths.runnersDir, { force: true, recursive: true });
      await rm(paths.statePath, { force: true });
      await rm(paths.lockPath, { force: true });
      await rm(paths.updateLockPath, { force: true });
      if (paths.definitionPath !== null) {
        await rm(paths.definitionPath, { force: true });
      }
      if (paths.backend === "systemd" && paths.definitionPath !== null) {
        await rm(systemdTimerPath(paths.definitionPath), { force: true });
      }
    },
    catch: (cause) => cause,
  });
}

function legacyServiceWrapperPaths(paths: ServicePaths): string[] {
  if (paths.backend === "windows-task-scheduler") {
    return [];
  }

  const legacyWrapperPath = join(paths.configDir, LEGACY_POSIX_WRAPPER_NAME);

  return legacyWrapperPath === paths.wrapperPath ? [] : [legacyWrapperPath];
}

function installNativeScheduler(paths: ServicePaths): Effect.Effect<void, unknown> {
  if (paths.backend === "launchd") {
    const domain = launchdDomain();
    return Effect.gen(function* () {
      yield* runExecutable("launchctl", ["bootout", domain, paths.definitionPath!]).pipe(
        Effect.ignore,
      );
      yield* runExecutable("launchctl", ["bootstrap", domain, paths.definitionPath!]);
      yield* runExecutable("launchctl", ["enable", `${domain}/${SERVICE_LABEL}`]);
    });
  }

  if (paths.backend === "systemd") {
    return Effect.gen(function* () {
      yield* runExecutable("systemctl", ["--user", "daemon-reload"]);
      yield* runExecutable("systemctl", ["--user", "enable", "--now", `${SYSTEMD_NAME}.timer`]);
    });
  }

  return Effect.gen(function* () {
    for (const taskName of windowsTaskNames()) {
      yield* runExecutable("schtasks", ["/Delete", "/TN", taskName, "/F"]).pipe(Effect.ignore);
    }
    yield* runExecutable("schtasks", windowsTaskCreateArgs(paths));
  });
}

function windowsTaskCreateArgs(paths: ServicePaths): string[] {
  return [
    "/Create",
    "/TN",
    windowsTaskName(),
    "/SC",
    "MINUTE",
    "/MO",
    String(SERVICE_INTERVAL_MINUTES),
    "/TR",
    cmdQuote(paths.wrapperPath),
    "/F",
  ];
}

function uninstallNativeScheduler(paths: ServicePaths): Effect.Effect<void, unknown> {
  if (paths.backend === "launchd") {
    return runExecutable("launchctl", ["bootout", launchdDomain(), paths.definitionPath!]).pipe(
      Effect.ignore,
    );
  }

  if (paths.backend === "systemd") {
    return Effect.gen(function* () {
      yield* runExecutable("systemctl", [
        "--user",
        "disable",
        "--now",
        `${SYSTEMD_NAME}.timer`,
      ]).pipe(Effect.ignore);
      yield* runExecutable("systemctl", ["--user", "daemon-reload"]).pipe(Effect.ignore);
    });
  }

  return Effect.gen(function* () {
    for (const taskName of windowsTaskNames()) {
      yield* runExecutable("schtasks", ["/Delete", "/TN", taskName, "/F"]).pipe(Effect.ignore);
    }
  });
}

function runExecutable(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number | undefined } = {},
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await execFilePromise(command, [...args], {
        timeout: options.timeoutMs ?? SERVICE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
    },
    catch: (cause) => cause,
  });
}

function findTokenmaxxingCommandInstall(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<CommandInstall | null, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const commandPath = await findCommandOnPath("tokenmaxxing", env, platform);
      if (commandPath === null) {
        return null;
      }

      const resolvedCommandPath = await resolveCommandPath(commandPath);
      const durableCommandPath = durableTokenmaxxingCommandPath(commandPath, resolvedCommandPath);

      return {
        autoUpdateManager: detectAutoUpdateManager({
          commandPath,
          env,
          platform,
          resolvedCommandPath,
        }),
        commandPath: durableCommandPath,
        resolvedCommandPath,
      };
    },
    catch: (cause) => cause,
  });
}

async function resolveCommandPath(commandPath: string): Promise<string> {
  try {
    return await realpath(commandPath);
  } catch {
    return commandPath;
  }
}

async function findCommandOnPath(
  command: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const pathValue = env["PATH"];
  if (!pathValue) {
    return null;
  }

  const extensions =
    platform === "win32" ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") {
      continue;
    }

    for (const extension of extensions) {
      const candidate = join(entry, platform === "win32" ? `${command}${extension}` : command);
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }

  return null;
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function capturedServiceEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const captured: Record<string, string> = {
    PATH: env["PATH"] ?? defaultPath(),
  };

  for (const key of [
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "TOKENMAXXING_CONFIG_DIR",
    "TOKENMAXXING_ENV",
    "TOKENMAXXING_API_URL",
    "TOKENMAXXING_WWW_URL",
  ]) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      captured[key] = value;
    }
  }

  return captured;
}

function defaultPath(): string {
  return process.platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows"
    : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function isEphemeralCommandPath(path: string): boolean {
  const normalized = normalizePathForDetection(path);

  return (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/.bun/install/cache/") ||
    isTransientCommandShimPath(normalized) ||
    normalized.includes("/node_modules/.bin/")
  );
}

function durableTokenmaxxingCommandPath(commandPath: string, resolvedCommandPath: string): string {
  return isTransientCommandShimPath(commandPath) &&
    isDurableTokenmaxxingPackagePath(resolvedCommandPath)
    ? resolvedCommandPath
    : commandPath;
}

function isTransientCommandShimPath(path: string): boolean {
  const normalized = normalizePathForDetection(path);

  // fnm multishell bins live under a shell-session directory. Stable shims from nvm,
  // Volta, asdf, Homebrew, npm, pnpm, yarn, and Bun should stay untouched.
  return normalized.includes("/.local/state/fnm_multishells/");
}

function isDurableTokenmaxxingPackagePath(path: string): boolean {
  const normalized = normalizePathForDetection(path);

  return (
    normalized.includes("/node_modules/@851-labs/tokenmaxxing/") && !isEphemeralCommandPath(path)
  );
}

function detectAutoUpdateManager({
  commandPath,
  env = process.env,
  resolvedCommandPath,
}: {
  commandPath: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  resolvedCommandPath: string;
}): AutoUpdateManager | null {
  const paths = [commandPath, resolvedCommandPath].map(normalizePathForDetection);
  const bunInstall = env["BUN_INSTALL"];
  const bunInstallBin =
    bunInstall === undefined ? undefined : normalizePathForDetection(join(bunInstall, "bin"));

  if (
    paths.some(
      (path) =>
        path.includes("/.pnpm/") ||
        path.includes("/pnpm/") ||
        path.includes("/pnpm-global/") ||
        path.includes("/library/pnpm/") ||
        path.includes("/.local/share/pnpm/"),
    )
  ) {
    return "pnpm";
  }

  if (
    paths.some(
      (path) =>
        path.includes("/.bun/bin/") ||
        path.includes("/.bun/install/") ||
        path.includes("/.bun/pm/") ||
        (bunInstallBin !== undefined && isSameOrChildPath(path, bunInstallBin)),
    )
  ) {
    return "bun";
  }

  if (
    paths.some(
      (path) =>
        path.includes("/.yarn/") ||
        path.includes("/yarn/global/") ||
        path.includes("/.config/yarn/") ||
        path.includes("/local/yarn/"),
    )
  ) {
    return "yarn";
  }

  if (
    paths.some(
      (path) =>
        path.includes("/lib/node_modules/") ||
        path.includes("/node_modules/@851-labs/tokenmaxxing/") ||
        path.includes("/node_modules/.bin/tokenmaxxing"),
    )
  ) {
    return "npm";
  }

  return null;
}

function normalizePathForDetection(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function isSameOrChildPath(path: string, parent: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;

  return path === parent || path.startsWith(normalizedParent);
}

function autoUpdateCommand(manager: AutoUpdateManager): {
  args: string[];
  command: AutoUpdateManager;
} {
  switch (manager) {
    case "bun":
      return {
        args: ["update", "-g", PACKAGE_NAME, "--latest", "--silent"],
        command: "bun",
      };
    case "npm":
      return {
        args: ["install", "-g", `${PACKAGE_NAME}@latest`, "--silent"],
        command: "npm",
      };
    case "pnpm":
      return {
        args: ["add", "-g", `${PACKAGE_NAME}@latest`, "--silent"],
        command: "pnpm",
      };
    case "yarn":
      return {
        args: ["global", "add", `${PACKAGE_NAME}@latest`, "--silent"],
        command: "yarn",
      };
  }
}

function autoUpdateCommandDescription(manager: AutoUpdateManager): string {
  const { command, args } = autoUpdateCommand(manager);

  return [command, ...args].join(" ");
}

function readServiceMetadata(path: string): Effect.Effect<ServiceMetadata | null, never> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as ServiceMetadata,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function isServiceInstalled(paths: ServicePaths): Effect.Effect<boolean, never> {
  if (paths.backend === "windows-task-scheduler") {
    return fileExists(paths.metadataPath);
  }

  return paths.definitionPath === null ? Effect.succeed(false) : fileExists(paths.definitionPath);
}

function fileExists(path: string): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => {
      await access(path, constants.F_OK);
      return true;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data);
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    }
    await rename(temporaryPath, path);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function copyFileAtomic(
  sourcePath: string,
  destinationPath: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporaryPath);
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    }
    await rename(temporaryPath, destinationPath);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function systemdTimerPath(servicePath: string): string {
  return servicePath.replace(/\.service$/, ".timer");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function escapeCmdSetValue(value: string): string {
  return value.replaceAll('"', '\\"');
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export {
  autoUpdateCommandDescription,
  backendForPlatform,
  capturedServiceEnv,
  deferredServiceRepairInvocation,
  durableTokenmaxxingCommandPath,
  detectAutoUpdateManager,
  findCommandOnPath,
  findTokenmaxxingCommandInstall,
  formatServiceLockStatus,
  formatServiceStatusAutoUpdate,
  isEphemeralCommandPath,
  isTransientCommandShimPath,
  isServiceInstalled,
  legacyServiceWrapperPaths,
  deterministicServiceJitterMs,
  readServiceMetadata,
  readCurrentServiceRunnerInstall,
  resolveExecutableSiblingPackageJson,
  resolveServiceRunnerPackageJson,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdTimer,
  refreshServiceAfterUpdate,
  installServiceRunner,
  installServiceRunnerForRepair,
  installServiceRunnerFromOptionalPackage,
  installServiceRunnerFromRegistryCandidates,
  runServiceAutoUpdate,
  scheduleDeferredServiceRepair,
  scheduleDescription,
  serviceRepairCanInstallScheduler,
  serviceLockCanBeReplaced,
  serviceRepairNeedsSchedulerInstall,
  serviceRepairReason,
  serviceRepairState,
  serviceRunnerPackageName,
  serviceRunnerReleaseChannel,
  serviceRunnerReleaseIsNewer,
  serviceRunnerTarget,
  serviceRunnerTargetCandidates,
  serviceScheduledSyncSince,
  serviceCommand,
  serviceInstallProgram,
  serviceLockStatus,
  serviceStateJson,
  extractServiceRunnerFromTarball,
  servicePathsEffect,
  servicePaths,
  serviceRunFailureState,
  serviceRunLogLine,
  serviceRunSuccessState,
  runPackageManagerUpdate,
  verifyNpmIntegrity,
  windowsTaskNames,
  windowsTaskCreateArgs,
  ServiceCommandNotFoundError,
  ServiceEnvTokenError,
  ServiceEphemeralCommandError,
  ServiceInstallError,
  ServiceRepairError,
  ServiceRunnerPackageMissingError,
  ServiceRunnerUpdateError,
  ServiceRunError,
  ServiceUninstallError,
  ServiceUnsupportedPlatformError,
};

export type {
  AutoUpdateManager,
  CommandInstall,
  ServiceBackend,
  ServiceInstallOptions,
  ServiceMetadata,
  ServiceAutoUpdateReport,
  ServicePaths,
  ServiceRepairReport,
  ServiceRunnerTarget,
  ServiceState,
};
