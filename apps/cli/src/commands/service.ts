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
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, homedir, hostname } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type {
  ServiceAutoUpdateManager,
  ServiceAutoUpdateReason,
  ServiceAutoUpdateStatus,
  ServiceCheckInStatus,
  ServiceRepairReason,
  ServiceRepairStatus,
  UsageSource,
} from "@tokenmaxxing/api-contract";

import {
  type DistTags,
  fetchDistTags,
  followedDistTags,
  isNewerVersion,
  NPM_REGISTRY_ENV,
  npmRegistryPackageUrl,
  parseSemVer,
  resolveUpdate,
} from "../cli-version";
import {
  type ApiRetryPolicy,
  describeApiFailure,
  formatApiFailureDetail,
  isTransientApiFailure,
  SCHEDULED_ME_RETRY_POLICY,
  USAGE_UPLOAD_TIMEOUT_MS,
} from "../api-failure";
import { booleanFlag } from "../flags";
import { ClockService, ConfigService, ConsoleService } from "../services";
import { getConfigPath } from "../services/config";
import { humanFrame, humanLog, humanSpinner, writeJson } from "../output";
import packageJson from "../../package.json";
import { prepareSourceCadence, SOURCE_CADENCE_FILE_NAME } from "../ccusage/cadence";
import { DEFAULT_SOURCE_NAMES } from "../ccusage/sources";
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
  type LoginCheckFailure,
  resolveSyncAuth,
  SyncAuthValidationError,
  syncProgram,
  sourcesWithoutLogs,
  SyncSourcesFailedError,
  type SyncAuth,
  type SyncResult,
  type SyncSkipReason,
  type SyncSourceIssue,
  type SyncStatus,
  type UploadRetryPolicy,
} from "./sync";
import { defaultServicePath, stableServicePath } from "./service-path";

const execFilePromise = promisify(execFile);
const gunzipPromise = promisify(gunzip);
const require = createRequire(import.meta.url);

const SERVICE_LABEL = "sh.tokenmaxxing.sync";
// 7: TimeoutStartSec on the systemd unit, and a wrapper PATH re-captured with
// #113's filter (alpha.0/.1 wrappers baked in a per-shell fnm directory that
// is gone after a reboot). The bump makes each runner's deferred reload
// repair rewrite them once.
const SERVICE_TEMPLATE_VERSION = 7;
// A scheduled run's worst case is the jitter, an auto-update, sources up to
// SERVICE_SOURCE_DEADLINE_MS plus the one still running (its daily and session
// timeouts), and three upload attempts: about 20 minutes. systemd stops one
// that is still going after this, so a wedged run cannot keep the oneshot
// unit "activating" and the timer from firing.
const SYSTEMD_RUN_TIMEOUT = "30min";
// No source starts this long after a service run began, and none after a
// ccusage timeout: a ccusage that hangs hangs for every source, and waiting
// out each one's 180 s timeout kept a full run going for 54 minutes (systemd
// killed it at 30, before it could record anything).
const SERVICE_SOURCE_DEADLINE_MS = 10 * 60 * 1000;
const SYSTEMD_NAME = "tokenmaxxing-sync";
const WINDOWS_TASK_NAME = "tokenmaxxing-sync";
const POSIX_WRAPPER_NAME = "tokenmaxxing.sh";
const LEGACY_POSIX_WRAPPER_NAME = "service-sync.sh";
const WINDOWS_WRAPPER_NAME = "service-sync.cmd";
const WINDOWS_LAUNCHER_NAME = "service-sync.vbs";
const WINDOWS_TASK_XML_NAME = "service-task.xml";
const WINDOWS_REPAIR_COMMAND_ENV = "TOKENMAXXING_SERVICE_REPAIR_COMMAND";
const PACKAGE_NAME = "@851-labs/tokenmaxxing";
const PACKAGE_MANAGER_OUTPUT_MAX_LINES = 20;
const PACKAGE_MANAGER_OUTPUT_MAX_CHARS = 2_000;
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const SERVICE_RUNNER_DIR_NAME = "service-runners";
const SERVICE_RUNNER_POINTER_NAME = "service-runner-current";
const SERVICE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const SERVICE_INTERVAL_MINUTES = 5;
const SERVICE_INTERVAL_SECONDS = SERVICE_INTERVAL_MINUTES * 60;
const SERVICE_JITTER_MAX_MS = 60 * 1000;
const SERVICE_API_TIMEOUT_MS = 60 * 1000;
// Resolving a scheduled run's login: SCHEDULED_ME_RETRY_POLICY's worst case
// (about 51 s) plus reading the config.
const SERVICE_AUTH_TIMEOUT_MS = 90 * 1000;
const SERVICE_FETCH_TIMEOUT_MS = 15 * 1000;
const SERVICE_COMMAND_TIMEOUT_MS = 60 * 1000;
const SERVICE_REPAIR_RUN_WAIT_MS = 15 * 60 * 1000;
const SERVICE_REPAIR_RUN_POLL_MS = 500;
const SERVICE_REPAIR_RUN_EXIT_GRACE_MS = 2 * 1000;
const SERVICE_PACKAGE_UPDATE_TIMEOUT_MS = 4 * 60 * 1000;
const SERVICE_VERSION_TIMEOUT_MS = 30 * 1000;
const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const SERVICE_LOG_ROTATIONS = 3;
const USAGE_REPLACEMENT_BACKFILL_VERSION = 1;
// Scheduled runs normally only re-send days since the last success, so usage
// that changes for an already-synced day (a ccusage upgrade that starts
// counting a new model, a source that failed while others succeeded, logs
// copied in later) would never reach the server. Every few hours a scheduled
// run re-sends a trailing window instead. Keep the default inside Claude
// Code's 30-day transcript retention: re-sending a day whose logs were
// partially pruned would lower it on the server.
const SERVICE_RECONCILE_WINDOW_DAYS = 21;
const SERVICE_RECONCILE_WINDOW_MAX_DAYS = 90;
const SERVICE_RECONCILE_WINDOW_ENV = "TOKENMAXXING_SYNC_WINDOW_DAYS";
const SERVICE_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SERVICE_UPLOAD_RETRY_POLICY: UploadRetryPolicy = {
  attempts: 3,
  backoffMs: [1_000, 4_000, 16_000],
  jitterRatio: 0.2,
  timeoutMs: USAGE_UPLOAD_TIMEOUT_MS,
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

// What writeServiceFiles actually rewrote: the scheduler definition (plist or systemd units) and
// the wrapper it runs.
interface ServiceFilesChange {
  definition: boolean;
  wrapper: boolean;
}

interface ServiceLock {
  acquiredAt: string;
  /** The machine whose `pid` this is; locks written before 0.7.0 have none. */
  hostname?: string | undefined;
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
      hostname?: string | undefined;
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
  manager: ServiceAutoUpdateManager | null;
  reason: ServiceAutoUpdateReason | null;
  status: ServiceAutoUpdateStatus;
}

interface ServiceAutoUpdateRuntime {
  commandExists?: ((command: string) => Effect.Effect<boolean, never>) | undefined;
  fetchDistTags?: (() => Effect.Effect<DistTags | null, never>) | undefined;
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
    | ((manager: AutoUpdateManager, version: string) => Effect.Effect<void, unknown>)
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
  lastRepairReason?: ServiceRepairReason;
  lastRepairStatus?: ServiceRepairStatus;
  lastRows?: number;
  lastSchedulerActive?: boolean;
  lastSince?: string;
  lastSources?: ServiceSourceState[];
  lastSyncStatus?: SyncStatus;
  lastSuccessAt?: string;
  lastSuccessDate?: string;
  lastReconcileAt?: string;
  lastUpserted?: number;
  reloadRequired?: boolean;
  usageReplacementBackfillVersion?: number;
  version: 1;
}

interface ServiceSourceState {
  dailyMs?: number;
  days?: number;
  issue?: SyncSourceIssue;
  models?: number;
  reason?: SyncSkipReason;
  rows?: number;
  sessionMs?: number;
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
  repairReason?: ServiceRepairReason | undefined;
  repairStatus?: ServiceRepairStatus | undefined;
  runnerTarget?: string | undefined;
  runnerVersion?: string | undefined;
  schedulerActive: boolean;
  status: ServiceCheckInStatus;
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
  reason: ServiceRepairReason;
  status: ServiceRepairStatus;
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

/**
 * FAIL: scheduled syncs cannot happen. WARN: they can, but something is off.
 * Either makes `service doctor` exit 1. INFO is a fine state worth showing
 * (never synced yet, a sync running right now), so it never does.
 */
type DoctorStatus = "fail" | "info" | "ok" | "warn";

type DoctorHealth = "fail" | "ok" | "warn";

type WindowsLauncherStatus = "current" | "missing" | "outdated";

interface DoctorCheck {
  /** What is good (OK), what is fine to know (INFO), or what is wrong followed by `fix`. */
  detail: string;
  /** The command that fixes a WARN or FAIL check. OK and INFO checks never carry one. */
  fix?: string | undefined;
  label: string;
  status: DoctorStatus;
}

/** Everything `service doctor` looks at, read before any check is judged. */
interface ServiceDoctorFacts {
  authConfig: DoctorAuthConfig;
  autoUpdate: DoctorCheck;
  definitionExists: boolean;
  env: Record<string, string | undefined>;
  envToken: boolean;
  installed: boolean;
  launcher: { path: string; status: WindowsLauncherStatus } | null;
  lock: DoctorCheck;
  metadata: ServiceMetadata | null;
  metadataCommandExists: boolean;
  nativeStatus: ServiceNativeSchedulerStatus;
  owner: ServiceDefinitionOwner;
  paths: ServicePaths;
  reloadRequired: boolean;
  runner: ServiceRunnerInspection;
  state: ServiceState | null;
  wrapper: string | null;
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
    ServiceAutoUpdateReason,
    "download-failed" | "integrity-mismatch" | "install-failed" | "platform-package-missing"
  >;
}> {}

/** A package-manager install of the CLI failed; `output` is what it printed. */
class PackageManagerUpdateError extends Data.TaggedError("PackageManagerUpdateError")<{
  readonly cause: unknown;
  readonly command: string;
  readonly output: string;
  readonly timedOut: boolean;
}> {
  override get message() {
    const summary = this.timedOut
      ? `${this.command} did not finish within ${SERVICE_PACKAGE_UPDATE_TIMEOUT_MS / 60_000} minutes`
      : `${this.command} failed`;
    return this.output.length > 0 ? `${summary}:\n${this.output}` : summary;
  }
}

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
  override get message() {
    return `error: failed to install tokenmaxxing service${causeLine(this.cause)}\nhint: rerun with --verbose or install manually from the generated files`;
  }
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
  // The cause goes in the message: a scheduled run's only output is the
  // service log, and "service run failed" alone (say, for a read-only config
  // dir) left nothing to act on.
  override get message() {
    return `error: tokenmaxxing service run failed${causeLine(this.cause)}\nhint: inspect the service log for details`;
  }
}

class ServiceRepairError extends Data.TaggedError("ServiceRepairError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `error: failed to repair tokenmaxxing service${causeLine(this.cause)}\nhint: rerun tokenmaxxing service doctor --verbose`;
  }
}

/**
 * `service install`/`repair` from an elevated ("Run as administrator") shell:
 * the task it registers then belongs to the elevated token, and every later
 * refresh or repair from a normal terminal fails with "Access is denied".
 */
class ServiceElevatedError extends Data.TaggedError("ServiceElevatedError")<{
  readonly command: "install" | "repair";
}> {
  override get message() {
    return `error: tokenmaxxing service ${this.command} is running as administrator\nhint: run it from a normal (non-elevated) terminal; a scheduled task registered as administrator can only be changed as administrator`;
  }
}

/** A schtasks change refused because an elevated shell registered the task. */
class WindowsTaskAccessDeniedError extends Data.TaggedError("WindowsTaskAccessDeniedError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `the ${windowsTaskName()} task was registered from an administrator terminal; delete it there (schtasks /Delete /TN ${windowsTaskName()} /F), then run tokenmaxxing service install from a normal terminal`;
  }
}

/**
 * Whether this process is elevated while the user's everyday token is a
 * UAC-filtered one: then the task it registers can later be changed only
 * from an elevated terminal, and every normal refresh or repair (and the
 * hidden deferred repair) fails with "Access is denied". That is an
 * elevated (High or System integrity) token, with UAC on, for any account
 * but the built-in Administrator, whose token UAC leaves unfiltered unless
 * FilterAdministratorToken is set. Measured (see e2e/windows/elevation-probe.ps1):
 * "Run as administrator" and an administrator's SSH session are refused;
 * GitHub's Windows runners (runneradmin is RID 500, UAC on, not filtered)
 * are not. `whoami` and `reg` start hidden and fast; no PowerShell.
 */
function isElevatedWindowsProcess(): Effect.Effect<boolean, never> {
  return Effect.all([
    readExecutableOutput("whoami", ["/groups"]),
    readExecutableOutput("whoami", ["/user", "/fo", "csv", "/nh"]),
    readExecutableOutput("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
    ]),
  ]).pipe(
    Effect.map(([groups, user, policies]) =>
      windowsElevatedOverFilteredToken({ groups, policies, user }),
    ),
  );
}

function windowsElevatedOverFilteredToken(input: {
  groups: string | null;
  policies: string | null;
  user: string | null;
}): boolean {
  const elevated = input.groups !== null && /S-1-16-(?:12288|16384)\b/.test(input.groups);
  const policy = (name: string) =>
    new RegExp(`${name}\\s+REG_DWORD\\s+(0x[0-9a-f]+)`, "i").exec(input.policies ?? "")?.[1];
  // UAC is on unless EnableLUA is 0; FilterAdministratorToken defaults to off.
  const uacOn = policy("EnableLUA") === undefined || Number(policy("EnableLUA")) !== 0;
  const builtinAdministrator = /S-1-5-21-[\d-]+-500"?\s*$/.test(input.user?.trim() ?? "");
  const builtinAdministratorFiltered = Number(policy("FilterAdministratorToken") ?? 0) === 1;

  return elevated && uacOn && !(builtinAdministrator && !builtinAdministratorFiltered);
}

class ServiceNotInstalledError extends Data.TaggedError("ServiceNotInstalledError")<{
  readonly configDir: string;
}> {
  override get message() {
    return `error: no tokenmaxxing service is installed for ${this.configDir}\nhint: run tokenmaxxing service install, or set TOKENMAXXING_CONFIG_DIR to the config dir the service was installed with`;
  }
}

/**
 * A newer runner (an auto-update) already moved the service to a newer
 * template; this CLI would move it back, and the runner would then repair it
 * forward again on its next run.
 */
class ServiceNewerThanCliError extends Data.TaggedError("ServiceNewerThanCliError")<{
  readonly command: "install --refresh" | "repair";
  readonly newer: ServiceNewerThanCli;
}> {
  override get message() {
    return `error: ${formatServiceNewerThanCli(this.newer)}\nhint: upgrade the CLI with tokenmaxxing upgrade, then run tokenmaxxing service ${this.command} again if it is still needed`;
  }
}

/** Repairing would re-point another config dir's scheduler definition at this one. */
class ServiceOwnedElsewhereError extends Data.TaggedError("ServiceOwnedElsewhereError")<{
  readonly configDir: string;
  readonly definition: string;
}> {
  override get message() {
    return `error: the installed service runs another config dir, not ${this.configDir}\ndefinition: ${this.definition}\nhint: set TOKENMAXXING_CONFIG_DIR to that service's config dir, or run tokenmaxxing service install to move the service here`;
  }
}

/**
 * "every source failed" for a scheduled run: exit non-zero so systemd,
 * launchd and Task Scheduler record a failure instead of a successful run.
 */
class ServiceSourcesFailedError extends Data.TaggedError("ServiceSourcesFailedError")<{
  readonly deferred?: number | undefined;
  readonly failures: readonly { issue: SyncSourceIssue; source: UsageSource }[];
  readonly withoutLogs?: readonly UsageSource[] | undefined;
}> {
  override get message() {
    return new SyncSourcesFailedError({
      deferred: this.deferred,
      failures: this.failures,
      withoutLogs: this.withoutLogs,
    }).message;
  }
}

/**
 * `service doctor` found a WARN or FAIL check: exit 1 so scripts and CI can
 * gate on it. The checks were already printed; this is the summary line.
 */
class ServiceDoctorProblemsError extends Data.TaggedError("ServiceDoctorProblemsError")<{
  readonly checks: readonly DoctorCheck[];
}> {
  override get message() {
    const failures = this.checks.filter((check) => check.status === "fail");
    const warnings = this.checks.filter((check) => check.status === "warn");
    const found = [
      ...(failures.length > 0 ? [doctorProblemCount(failures, "failure")] : []),
      ...(warnings.length > 0 ? [doctorProblemCount(warnings, "warning")] : []),
    ].join(" and ");
    const fixes = new Set([...failures, ...warnings].map((check) => check.fix));
    const hint =
      fixes.size === 1 && !fixes.has(undefined)
        ? [...fixes][0]
        : "each FAIL and WARN check says how to fix it";

    return `error: service doctor found ${found}\nhint: ${hint}`;
  }

  get jsonFields() {
    return { health: serviceDoctorHealth(this.checks) };
  }
}

function doctorProblemCount(checks: readonly DoctorCheck[], noun: string): string {
  return `${checks.length} ${noun}${checks.length === 1 ? "" : "s"} (${checks.map((check) => check.label).join(", ")})`;
}

function causeLine(cause: unknown): string {
  const text =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  const first = text
    ?.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  return first === undefined ? "" : `\ncause: ${first.replace(/^error: /, "")}`;
}

const installCommand = Command.make(
  "install",
  {
    force: booleanFlag("force").pipe(
      Flag.withDescription("Deprecated; service install uses a managed runner"),
    ),
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    refresh: booleanFlag("refresh").pipe(Flag.withHidden),
  },
  ({ force, json, refresh }) => serviceInstallEffect({ force, json, refresh }),
).pipe(Command.withDescription("Install automatic sync"));

const uninstallCommand = Command.make(
  "uninstall",
  {
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceUninstallEffect({ json }),
).pipe(Command.withDescription("Uninstall automatic sync"));

const statusCommand = Command.make(
  "status",
  {
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceStatusEffect({ json }),
).pipe(Command.withDescription("Show automatic sync service status"));

const doctorCommand = Command.make(
  "doctor",
  {
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => serviceDoctorEffect({ json }),
).pipe(Command.withDescription("Check automatic sync service health"));

const repairCommand = Command.make(
  "repair",
  {
    deferred: booleanFlag("deferred").pipe(Flag.withHidden),
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    reason: Flag.String("reason").pipe(Flag.optional, Flag.withHidden),
  },
  ({ deferred, json, reason }) =>
    serviceRepairEffect({ deferred, json, reason: Option.getOrUndefined(reason) }),
).pipe(Command.withDescription("Repair automatic sync scheduling"));

const runCommand = Command.make(
  "run",
  {
    force: booleanFlag("force").pipe(
      Flag.withDescription("Run every source, even ones whose logs are unchanged"),
    ),
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    scheduled: booleanFlag("scheduled").pipe(Flag.withHidden),
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
    installScheduler?: (
      paths: ServicePaths,
      change: ServiceFilesChange,
    ) => Effect.Effect<void, unknown>;
    installServiceRunner?: (paths: ServicePaths) => Effect.Effect<ServiceRunnerInstall, unknown>;
    isElevated?: () => Effect.Effect<boolean, never>;
    now?: Date;
    platform?: NodeJS.Platform;
    readInstalledSpelling?: (paths: ServicePaths) => Effect.Effect<InstalledWindowsSpelling, never>;
    readMetadata?: (path: string) => Effect.Effect<ServiceMetadata | null, never>;
    writeFiles?: (
      paths: ServicePaths,
      wrapper: string,
      metadata: ServiceMetadata,
    ) => Effect.Effect<ServiceFilesChange, unknown>;
    writeRunnerPointer?: (paths: ServicePaths, runnerPath: string) => Effect.Effect<void, unknown>;
  } = {},
) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);

    if (
      (runtime.platform ?? process.platform) === "win32" &&
      (yield* (runtime.isElevated ?? isElevatedWindowsProcess)())
    ) {
      return yield* Effect.fail(new ServiceElevatedError({ command: "install" }));
    }
    if (!options.refresh && (yield* config.hasEnvToken())) {
      return yield* Effect.fail(new ServiceEnvTokenError());
    }

    if (!options.refresh) {
      yield* resolveSyncAuth({ json: options.json === true });
    }

    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const shellPaths = yield* servicePathsEffect(env, runtime.home, platform);
    const { env: serviceEnv, paths } = withInstalledWindowsSpelling(
      shellPaths,
      capturedServiceEnv(env, platform),
      platform === "win32"
        ? yield* (runtime.readInstalledSpelling ?? readInstalledWindowsSpelling)(shellPaths)
        : null,
    );
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
    if (options.refresh) {
      const newer = serviceNewerThanCli(
        yield* (runtime.readMetadata ?? readServiceMetadata)(paths.metadataPath),
      );
      if (newer?.template !== undefined) {
        return yield* Effect.fail(
          new ServiceNewerThanCliError({ command: "install --refresh", newer }),
        );
      }
    }

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
        ((servicePaths) =>
          keepNewerCurrentRunner(
            servicePaths,
            packageJson.version,
            readCurrentServiceRunnerInstall,
          ).pipe(
            Effect.flatMap((current) =>
              current !== null
                ? Effect.succeed(current)
                : installServiceRunner(servicePaths, { updatePointer: false }),
            ),
          ))
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
      const wrapper = renderServiceWrapper({
        env: serviceEnv,
        logPath: paths.logPath,
        platform,
        runnerPointerPath: paths.runnerPointerPath,
      });
      // A refresh keeps the original install time, so an unchanged service.json
      // is not rewritten on every upgrade.
      const existingMetadata = yield* (runtime.readMetadata ?? readServiceMetadata)(
        paths.metadataPath,
      );
      const metadata: ServiceMetadata = {
        autoUpdateManager: "registry",
        backend: paths.backend,
        commandPath: installedRunner.path,
        installedAt: existingMetadata?.installedAt ?? (runtime.now ?? new Date()).toISOString(),
        runnerPackage: installedRunner.packageName,
        runnerPath: installedRunner.path,
        runnerTarget: installedRunner.target,
        runnerVersion: installedRunner.version,
        schedule: scheduleDescription(),
        templateVersion: SERVICE_TEMPLATE_VERSION,
        version: 1,
      };

      const filesSpinner = yield* humanSpinner("Writing service files", options);
      const filesChange = yield* (runtime.writeFiles ?? writeServiceFiles)(
        paths,
        wrapper,
        metadata,
      ).pipe(
        Effect.tap(() =>
          (runtime.writeRunnerPointer ?? writeServiceRunnerPointer)(paths, installedRunner.path),
        ),
        Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files written"))),
        Effect.tapError(() =>
          Effect.sync(() => filesSpinner.error("Failed writing service files")),
        ),
        Effect.mapError((cause) => new ServiceInstallError({ cause })),
      );
      const schedulerSpinner = yield* humanSpinner("Installing scheduler", options);
      yield* (runtime.installScheduler ?? installNativeScheduler)(paths, filesChange).pipe(
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
    if (platform === "win32" && options.deferred !== true && (yield* isElevatedWindowsProcess())) {
      return yield* Effect.fail(new ServiceElevatedError({ command: "repair" }));
    }
    const shellPaths = yield* servicePathsEffect(env, undefined, platform);
    const { env: serviceEnv, paths } = withInstalledWindowsSpelling(
      shellPaths,
      capturedServiceEnv(env, platform),
      platform === "win32" ? yield* readInstalledWindowsSpelling(shellPaths) : null,
    );
    const currentState = (yield* readServiceState(paths.statePath)) ?? { version: 1 as const };
    const existingMetadata = yield* readServiceMetadata(paths.metadataPath);
    const initialNativeStatus = yield* readNativeSchedulerStatus(paths);
    const reloadRequired = serviceReloadRequired(existingMetadata, currentState);
    const detectedReason =
      parseServiceRepairReason(options.reason) ??
      serviceRepairReason({
        reloadRequired,
        schedulerActive: initialNativeStatus.active,
      });
    const { reason: repairReason, reported: reportedReason } = serviceRepairReasons({
      deferred: options.deferred === true,
      detected: detectedReason,
      last: currentState.lastRepairReason,
    });
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
      if (paths.backend === "windows-task-scheduler") {
        yield* waitForServiceRunExit(paths);
      }
    }

    const repairResult = yield* Effect.gen(function* () {
      // A repair from a shell (or a deferred repair) whose config dir is not
      // the installed service's must not take the scheduler over, and one
      // with nothing installed here must not install a service.
      const owner = yield* serviceDefinitionOwner(paths);
      if (owner === "other") {
        return yield* Effect.fail(
          new ServiceOwnedElsewhereError({
            configDir: paths.configDir,
            definition: paths.definitionPath ?? `Task Scheduler task ${windowsTaskName()}`,
          }),
        );
      }
      if (
        owner === "none" &&
        existingMetadata === null &&
        !(yield* fileExists(paths.wrapperPath))
      ) {
        return yield* Effect.fail(new ServiceNotInstalledError({ configDir: paths.configDir }));
      }
      const newer = serviceNewerThanCli(existingMetadata);
      if (newer?.template !== undefined) {
        return yield* Effect.fail(new ServiceNewerThanCliError({ command: "repair", newer }));
      }

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
          env: serviceEnv,
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
        const filesChange = yield* writeServiceFiles(paths, wrapper, metadata).pipe(
          Effect.tap(() => writeServiceRunnerPointer(paths, runner.path)),
          Effect.tap(() => Effect.sync(() => filesSpinner.stop("Service files written"))),
          Effect.tapError(() =>
            Effect.sync(() => filesSpinner.error("Failed writing service files")),
          ),
          Effect.mapError((cause) => new ServiceRepairError({ cause })),
        );

        const nativeStatus = yield* readNativeSchedulerStatus(paths);
        const needsSchedulerInstall = serviceRepairNeedsSchedulerInstall({
          deferred: options.deferred,
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
        yield* installNativeScheduler(paths, filesChange).pipe(
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
        repair: { ...successReport, reason: reportedReason },
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
      const newerThanCli = serviceNewerThanCli(metadata);
      const runner = metadata === null ? null : yield* inspectServiceRunner(paths);
      const launcherPath = windowsLauncherPath(paths);
      const launcherStatus =
        launcherPath === null ? null : yield* readWindowsLauncherStatus(launcherPath);
      // Worded as `service doctor` words them.
      const autoUpdate = yield* readServiceAutoUpdateCheck(
        metadata,
        installed,
        yield* findTokenmaxxingCommandInstall().pipe(Effect.catch(() => Effect.succeed(null))),
      );
      const lock = yield* serviceLockCheck(paths, lockStatus);
      const status = {
        arch: state?.lastArch ?? null,
        autoUpdate: autoUpdate.detail,
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
        lastReconcileAt: state?.lastReconcileAt ?? null,
        lastRows: state?.lastRows ?? null,
        lastSchedulerActive: state?.lastSchedulerActive ?? null,
        lastSince: state?.lastSince ?? null,
        lastSources: state?.lastSources ?? [],
        lastSyncStatus: state?.lastSyncStatus ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastSuccessDate: serviceLastSuccessDate(state) ?? null,
        lastUpserted: state?.lastUpserted ?? null,
        lastVersion: state?.lastCliVersion ?? null,
        launcherPath,
        launcherStatus,
        lock: formatServiceLockStatus(lockStatus),
        logPath: paths.logPath,
        newerThanCli,
        reloadRequired,
        runnerIssue: runner?._tag === "broken" ? runner.detail : null,
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
        for (const line of serviceStatusRunnerLines(status)) {
          console.log(line);
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
        console.log(`Last reconcile: ${status.lastReconcileAt ?? "never"}`);
        if (status.lastUpserted !== null) {
          console.log(`Last upserted: ${status.lastUpserted}`);
        }
        if (status.lastVersion !== null) {
          console.log(
            `Last CLI: ${status.lastVersion}${status.arch === null ? "" : ` (${status.arch})`}`,
          );
        }
        if (status.lastError !== undefined) {
          console.log(`Last error: ${formatServiceLastError(status.lastError)}`);
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
        console.log(`Lock: ${lock.detail}`);
        console.log(`Wrapper: ${status.wrapperPath}`);
        if (status.launcherPath !== null) {
          console.log(
            `Launcher: ${status.launcherPath}${
              status.launcherStatus === "current" ? "" : ` (${status.launcherStatus})`
            }`,
          );
        }
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
    if (result.status === "error") {
      const failures = result.sources.flatMap((source) =>
        source.status === "failed" ? [{ issue: source.issue, source: source.source }] : [],
      );
      return yield* Effect.fail(
        new ServiceSourcesFailedError({
          deferred: result.sources.filter(
            (source) =>
              source.status === "skipped" &&
              (source.reason === "runner_timed_out" || source.reason === "run_deadline"),
          ).length,
          failures,
          withoutLogs: yield* sourcesWithoutLogs(failures.map((failure) => failure.source)),
        }),
      );
    }
  });
}

function serviceDoctorEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame(
    "Service doctor",
    options,
    Effect.gen(function* () {
      const paths = yield* servicePathsEffect();
      const facts = yield* readServiceDoctorFacts(paths);
      const recentLog = yield* readLogTail(paths.logPath, 8);

      yield* reportServiceDoctor(
        {
          checks: serviceDoctorChecks(facts),
          recentLog,
          reloadRequired: facts.reloadRequired,
          scheduler: facts.nativeStatus,
          state: facts.state,
        },
        options,
      );
    }),
  );
}

function readServiceDoctorFacts(paths: ServicePaths) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const envToken = yield* config.hasEnvToken();
    const authConfig: DoctorAuthConfig = yield* config.readConfig().pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "error" as const, cause }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
    );
    const metadata = yield* readServiceMetadata(paths.metadataPath);
    const state = yield* readServiceState(paths.statePath);
    const installed = yield* isServiceInstalled(paths);
    const launcherPath = windowsLauncherPath(paths);
    const wrapper = yield* Effect.tryPromise(() => readFile(paths.wrapperPath, "utf8")).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const currentCommand = yield* findTokenmaxxingCommandInstall().pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    return {
      authConfig,
      autoUpdate: yield* readServiceAutoUpdateCheck(metadata, installed, currentCommand),
      definitionExists:
        paths.definitionPath === null ? installed : yield* fileExists(paths.definitionPath),
      env: process.env,
      envToken,
      installed,
      launcher:
        launcherPath === null
          ? null
          : { path: launcherPath, status: yield* readWindowsLauncherStatus(launcherPath) },
      lock: yield* serviceLockCheck(
        paths,
        yield* readServiceLockStatus(paths.lockPath, new Date()),
      ),
      metadata,
      metadataCommandExists:
        metadata?.commandPath === undefined ? false : yield* fileExists(metadata.commandPath),
      nativeStatus: yield* readNativeSchedulerStatus(paths),
      owner: yield* serviceDefinitionOwner(paths),
      paths,
      reloadRequired: serviceReloadRequired(metadata, state),
      runner: yield* inspectServiceRunner(paths),
      state,
      wrapper,
    } satisfies ServiceDoctorFacts;
  });
}

/**
 * Judges what `readServiceDoctorFacts` read. With nothing installed for this
 * config dir, the checks of the service's own files are left out: each would
 * fail, and `service repair` cannot fix any of them.
 */
function serviceDoctorChecks(facts: ServiceDoctorFacts): DoctorCheck[] {
  const { metadata, paths, state } = facts;
  const repair = `repair with ${serviceRepairCommand()}`;
  const notInstalled =
    facts.owner === "other" ||
    (facts.owner === "none" && metadata === null && facts.wrapper === null);

  const serviceChecks = notInstalled
    ? [
        facts.owner === "other"
          ? doctorProblem(
              "fail",
              "scheduler",
              `the installed ${paths.backend} service runs another config dir, not ${paths.configDir}`,
              "set TOKENMAXXING_CONFIG_DIR to that service's config dir",
            )
          : doctorProblem(
              "fail",
              "scheduler",
              `not installed (${paths.backend})`,
              "install with tokenmaxxing service install",
            ),
      ]
    : [
        facts.installed
          ? doctorCheck("ok", "scheduler", `installed (${paths.backend})`)
          : doctorProblem("fail", "scheduler", `not installed (${paths.backend})`, repair),
        facts.nativeStatus.active
          ? doctorCheck("ok", "active", facts.nativeStatus.detail)
          : doctorProblem("fail", "active", facts.nativeStatus.detail, repair),
        doctorTemplateCheck(metadata, facts.reloadRequired),
        doctorDefinitionCheck(paths, facts.definitionExists),
        facts.wrapper === null
          ? doctorProblem("fail", "wrapper", `missing: ${paths.wrapperPath}`, repair)
          : doctorCheck("ok", "wrapper", paths.wrapperPath),
        ...(facts.launcher === null
          ? []
          : [windowsLauncherDoctorCheck(facts.launcher.path, facts.launcher.status)]),
        doctorServiceEnvCheck(facts.wrapper, facts.env),
        doctorRunnerCheck(facts.runner, metadata),
        metadata === null
          ? doctorProblem(
              "warn",
              "metadata",
              `${paths.metadataPath} missing or unreadable; auto-update is off`,
              repair,
            )
          : doctorCheck("ok", "metadata", paths.metadataPath),
        doctorBinaryCheck(metadata, facts.metadataCommandExists),
        facts.autoUpdate,
      ];

  return [
    ...serviceChecks,
    doctorAuthCheck(facts.envToken, facts.authConfig),
    facts.lock,
    state?.lastSuccessAt === undefined
      ? doctorCheck("info", "last success", "never")
      : doctorCheck("ok", "last success", state.lastSuccessAt),
    state?.lastError === undefined
      ? doctorCheck("ok", "last error", "none")
      : doctorProblem(
          "warn",
          "last error",
          formatServiceLastError(state.lastError),
          "retry with tokenmaxxing service run to see why",
        ),
    doctorLastRepairCheck(state),
  ];
}

function serviceDoctorHealth(checks: readonly DoctorCheck[]): DoctorHealth {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  return checks.some((check) => check.status === "warn") ? "warn" : "ok";
}

/**
 * Prints the checks (or the --json report) and fails with
 * `ServiceDoctorProblemsError`, so the CLI exits 1, when any check is WARN or
 * FAIL. `status` in the JSON says the doctor ran; `health` is its verdict.
 */
function reportServiceDoctor(
  report: {
    checks: readonly DoctorCheck[];
    recentLog: readonly string[];
    reloadRequired: boolean;
    scheduler: ServiceNativeSchedulerStatus;
    state: ServiceState | null;
  },
  options: { json?: boolean | undefined },
) {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const health = serviceDoctorHealth(report.checks);

    if (options.json) {
      yield* writeJson({
        checks: report.checks,
        health,
        recentLog: report.recentLog,
        reloadRequired: report.reloadRequired,
        scheduler: report.scheduler,
        state: report.state === null ? null : serviceStateJson(report.state),
        status: "ok",
      });
    } else {
      yield* Effect.sync(() => {
        console.log("Service doctor");
        for (const check of report.checks) {
          console.log(doctorLine(check));
        }

        if (report.recentLog.length > 0) {
          console.log("");
          console.log("Recent log:");
          for (const line of report.recentLog) {
            console.log(`  ${line}`);
          }
        }
      });
    }

    if (health !== "ok") {
      return yield* Effect.fail(new ServiceDoctorProblemsError({ checks: report.checks }));
    }
  });
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
    const usageReplacementBackfill = serviceNeedsUsageReplacementBackfill(
      currentState,
      options.scheduled,
    );
    const reconcile =
      !usageReplacementBackfill && serviceReconcileDue(currentState, startedAt, options.scheduled);
    const incrementalSince = serviceScheduledSyncSince(currentState, startedAt, options.scheduled);
    const scheduledSince = usageReplacementBackfill
      ? undefined
      : reconcile
        ? earliestDateKey(incrementalSince, serviceReconcileSince(startedAt))
        : incrementalSince;
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

    const authResult = yield* resolveServiceSyncAuth(
      options.scheduled ? SCHEDULED_ME_RETRY_POLICY : undefined,
    );
    if (authResult._tag === "failure") {
      const failedState = serviceRunFailureState(currentState, {
        arch: cliArch,
        attemptAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        error: serviceAuthFailureError(authResult.cause),
        reloadRequired,
        schedulerActive: nativeStatus.active,
        since: scheduledSince,
        version: cliVersion,
      });
      const repairReport = yield* maybeScheduleDeferredServiceRepair({
        commandPath: metadata?.commandPath,
        reason: serviceRepairReason({
          serviceFailed: !isTransientServiceFailure(authResult.cause),
        }),
        scheduled: options.scheduled,
      });
      const finalFailedState =
        repairReport === undefined ? failedState : serviceRepairState(failedState, repairReport);
      yield* writeServiceState(paths.statePath, finalFailedState).pipe(Effect.ignore);
      yield* writeScheduledServiceLog(
        console,
        options,
        serviceRunLogLine(finalFailedState, "failure", {
          hasResults: false,
          loginCheck:
            authResult.cause instanceof SyncAuthValidationError
              ? authResult.cause.loginCheck
              : undefined,
        }),
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

    // Scheduled ticks skip sources whose logs are unchanged since their last
    // upload and never re-run the session report (#69); anything else is a
    // full run that also refreshes the uploaded session counts.
    const cadence = yield* prepareSourceCadence({
      cliVersion,
      full: !options.scheduled || options.force || reconcile || usageReplacementBackfill,
      path: serviceSourceCadencePath(paths),
      since: scheduledSince,
      sources: usageReplacementBackfill ? ["codex"] : DEFAULT_SOURCE_NAMES,
    });
    const result = yield* syncProgram({
      auth,
      dryRun: false,
      json: true,
      silent: true,
      ...(scheduledSince === undefined ? {} : { since: scheduledSince }),
      ...(usageReplacementBackfill ? { sources: "codex" } : {}),
      sourcePlans: cadence.plans,
      sourceLimits: {
        deadlineAt: startedAtMs + SERVICE_SOURCE_DEADLINE_MS,
        stopAfterTimeout: true,
      },
      ...(options.scheduled ? { uploadPolicy: SERVICE_UPLOAD_RETRY_POLICY } : {}),
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failure" as const, cause }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
      Effect.tap((outcome) =>
        outcome._tag === "success" ? cadence.commit(outcome.value) : Effect.void,
      ),
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
        reason: serviceRepairReason({ serviceFailed: !isTransientServiceFailure(result.cause) }),
        scheduled: options.scheduled,
      });
      const finalFailedState =
        repairReport === undefined ? failedState : serviceRepairState(failedState, repairReport);
      yield* writeServiceState(paths.statePath, finalFailedState).pipe(Effect.ignore);
      yield* writeScheduledServiceLog(
        console,
        options,
        serviceRunLogLine(finalFailedState, "failure", { hasResults: false }),
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
      reconciledAt: reconcile ? startedAtIso : undefined,
      schedulerActive: nativeStatus.active,
      since: scheduledSince,
      successAt,
      usageReplacementBackfillVersion:
        usageReplacementBackfill && serviceCompletedUsageReplacementBackfill(result.value)
          ? USAGE_REPLACEMENT_BACKFILL_VERSION
          : undefined,
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

function resolveServiceSyncAuth(loginCheckRetry?: ApiRetryPolicy) {
  return resolveSyncAuth({ json: true, loginCheckRetry }).pipe(
    Effect.timeout(`${SERVICE_AUTH_TIMEOUT_MS} millis`),
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
    // A newer template is not this CLI's to reload (serviceNewerThanCli).
    (metadata.templateVersion === undefined ||
      metadata.templateVersion < SERVICE_TEMPLATE_VERSION ||
      metadata.autoUpdateManager !== "registry" ||
      metadata.runnerTarget === undefined ||
      metadata.runnerVersion === undefined)
  );
}

/** The parts of the installed service a newer release wrote, or null. */
interface ServiceNewerThanCli {
  runner?: { cli: string; installed: string } | undefined;
  template?: { cli: number; installed: number } | undefined;
}

function serviceNewerThanCli(
  metadata: ServiceMetadata | null,
  cliVersion: string = packageJson.version,
): ServiceNewerThanCli | null {
  const template =
    metadata?.templateVersion !== undefined && metadata.templateVersion > SERVICE_TEMPLATE_VERSION
      ? { cli: SERVICE_TEMPLATE_VERSION, installed: metadata.templateVersion }
      : undefined;
  const runner =
    metadata?.runnerVersion !== undefined && isNewerVersion(cliVersion, metadata.runnerVersion)
      ? { cli: cliVersion, installed: metadata.runnerVersion }
      : undefined;

  return template === undefined && runner === undefined ? null : { runner, template };
}

function formatServiceNewerThanCli(newer: ServiceNewerThanCli): string {
  const parts = [
    ...(newer.template === undefined
      ? []
      : [`template ${newer.template.installed} vs ${newer.template.cli}`]),
    ...(newer.runner === undefined
      ? []
      : [`runner ${newer.runner.installed} vs ${newer.runner.cli}`]),
  ];
  return `the service is newer than this CLI (${parts.join(", ")})`;
}

function serviceRepairReason(input: {
  autoUpdated?: boolean | undefined;
  reloadRequired?: boolean | undefined;
  schedulerActive?: boolean | undefined;
  serviceFailed?: boolean | undefined;
}): ServiceRepairReason | undefined {
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

/**
 * Whether a repair re-registers the scheduler. Not for an active scheduler on
 * the current template after an auto-update, nor for the deferred repair after
 * a failed run: that failure was not the scheduler's, and re-registering it
 * (on Windows, a new task file and a schedule restarted from now) every few
 * minutes while offline only did harm.
 */
function serviceRepairNeedsSchedulerInstall(input: {
  deferred?: boolean | undefined;
  reason: ServiceRepairReason;
  reloadRequired?: boolean | undefined;
  schedulerActive: boolean;
}): boolean {
  if (input.reloadRequired === true || !input.schedulerActive) {
    return true;
  }

  return !(
    input.reason === "auto-updated" ||
    (input.reason === "service-failure" && input.deferred === true)
  );
}

/**
 * A failure the next scheduled run may well not hit: no network, a timeout,
 * a 5xx or a 429. A repair cannot fix any of these, so none is scheduled.
 */
function isTransientServiceFailure(cause: unknown): boolean {
  let current = cause;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    // The first API failure down the chain decides (a wrapper such as
    // SyncPushError classifies as unknown and defers to its cause).
    if (describeApiFailure(current).kind !== "unknown") {
      return isTransientApiFailure(current);
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * `lastError` for a run whose login check failed. A `/me` that failed for
 * any reason but a bad token says what it ran into, and when the next run
 * can succeed where this one did not (no network while a Mac wakes from
 * sleep, a server error), says so: nothing needs fixing.
 */
function serviceAuthFailureError(cause: unknown): string {
  if (!(cause instanceof SyncAuthValidationError)) {
    return String(cause);
  }

  const detail = formatApiFailureDetail(describeApiFailure(cause.cause));
  return `${cause.summary}; ${detail}${
    isTransientApiFailure(cause.cause) ? "; will retry next run" : ""
  }`;
}

function serviceRepairCanInstallScheduler(input: {
  backend: ServiceBackend;
  deferred?: boolean | undefined;
}): boolean {
  return !(input.backend === "launchd" && input.deferred === true);
}

/**
 * The reason a repair acts on, and the one it reports. A deferred repair
 * without a detected reason carries on the one it was scheduled with; a
 * manual one with nothing wrong is a full repair that reports itself as
 * `manual`, not with whatever reason the last deferred repair had.
 */
function serviceRepairReasons(input: {
  deferred: boolean;
  detected: ServiceRepairReason | undefined;
  last: ServiceRepairReason | undefined;
}): { reason: ServiceRepairReason; reported: ServiceRepairReason | "manual" } {
  if (input.detected !== undefined) {
    return { reason: input.detected, reported: input.detected };
  }
  if (input.deferred) {
    const reason = input.last ?? "reload-required";
    return { reason, reported: reason };
  }

  return { reason: "reload-required", reported: "manual" };
}

function parseServiceRepairReason(value: string | undefined): ServiceRepairReason | undefined {
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

// cmd.exe re-opens a running batch file after every command and continues at its saved byte
// offset, so rewriting service-sync.cmd while the scheduled sync that spawned this repair is still
// inside it would resume that cmd.exe in the middle of the new file. Wait until the sync releases
// the run lock, then give its wrapper a moment to exit, before touching any service files.
function waitForServiceRunExit(paths: ServicePaths) {
  return Effect.gen(function* () {
    const clock = yield* Effect.service(ClockService);
    const deadline = Date.now() + SERVICE_REPAIR_RUN_WAIT_MS;
    while (Date.now() < deadline) {
      const lockStatus = yield* readServiceLockStatus(paths.lockPath, new Date());
      if (!lockStatus.locked || lockStatus.stale) {
        break;
      }
      yield* clock.sleep(SERVICE_REPAIR_RUN_POLL_MS);
    }
    yield* clock.sleep(SERVICE_REPAIR_RUN_EXIT_GRACE_MS);
  }).pipe(Effect.catch(() => Effect.void));
}

function serviceRepairCommand(): string {
  return "tokenmaxxing service repair";
}

function scheduleDeferredServiceRepair(
  commandPath: string,
  reason: ServiceRepairReason,
): Effect.Effect<ServiceRepairReport, never> {
  const attemptedAt = new Date().toISOString();

  return Effect.gen(function* () {
    if (process.platform === "win32") {
      // Installs from older templates have no launcher yet; the repair is what migrates them.
      yield* writeWindowsLauncher(windowsLauncherPathForEnv(process.env));
    }
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
  reason: ServiceRepairReason,
  platform = process.platform,
) {
  const invocation = deferredServiceRepairInvocation(commandPath, reason, platform, process.env);

  return spawn(invocation.command, invocation.args, invocation.options);
}

function deferredServiceRepairInvocation(
  commandPath: string,
  reason: ServiceRepairReason,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): {
  args: string[];
  command: string;
  options: Parameters<typeof spawn>[2];
} {
  // A detached child has no console, so a console program started from it opens a visible
  // window. wscript.exe is a GUI program; the launcher's repair mode then runs the command with a
  // hidden console that its children inherit. The command path travels through the environment so
  // it is never re-encoded or re-quoted on the way.
  if (platform === "win32") {
    return {
      args: ["//B", "//NoLogo", "//E:VBScript", windowsLauncherPathForEnv(env), "repair", reason],
      command: windowsScriptHostPath(env),
      options: {
        detached: true,
        env: { ...env, [WINDOWS_REPAIR_COMMAND_ENV]: commandPath },
        stdio: "ignore",
        windowsHide: true,
      },
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
        ...systemdRunEnvArgs(capturedServiceEnv(env, platform)),
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

function systemdRepairUnitName(reason: ServiceRepairReason): string {
  return `${SYSTEMD_NAME}-repair-${reason}`;
}

function systemdRunEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`);
}

function maybeScheduleDeferredServiceRepair(input: {
  commandPath: string | undefined;
  reason: ServiceRepairReason | undefined;
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
        detail: nativeSchedulerActiveDetail(paths),
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

/** What an active scheduler has, as `service status` and `service doctor` say it. */
function nativeSchedulerActiveDetail(paths: Pick<ServicePaths, "backend">): string {
  if (paths.backend === "launchd") {
    return `loaded in launchd (${launchdDomain()}/${SERVICE_LABEL})`;
  }

  return paths.backend === "systemd"
    ? `${SYSTEMD_NAME}.timer is active`
    : `task ${windowsTaskName()} is registered`;
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
    reconciledAt?: string | undefined;
    reloadRequired?: boolean | undefined;
    result: SyncResult;
    schedulerActive?: boolean | undefined;
    since?: string | undefined;
    successAt: string;
    usageReplacementBackfillVersion?: number | undefined;
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
    lastError: serviceSyncError(input.result),
    lastRows: input.result.rows,
    lastSchedulerActive: input.schedulerActive,
    lastSince: input.since,
    lastSources: serviceSourcesForState(input.result),
    lastReconcileAt:
      input.result.status === "error" || input.reconciledAt === undefined
        ? currentState.lastReconcileAt
        : input.reconciledAt,
    lastSuccessAt: input.result.status === "error" ? currentState.lastSuccessAt : input.successAt,
    lastSyncStatus: input.result.status,
    lastUpserted: input.result.upserted ?? 0,
    reloadRequired: input.reloadRequired,
    ...(input.usageReplacementBackfillVersion === undefined
      ? {}
      : { usageReplacementBackfillVersion: input.usageReplacementBackfillVersion }),
    version: 1,
  };
}

/**
 * What went wrong in a sync that ran: sources left for the next run by the
 * run's limits (even when others synced, so doctor shows it), or every
 * source failing.
 */
function serviceSyncError(result: Pick<SyncResult, "sourceResults" | "status">) {
  const deferred = (reason: SyncSkipReason) =>
    result.sourceResults.filter(
      (sourceResult) => sourceResult.status === "skipped" && sourceResult.reason === reason,
    ).length;
  const count = (value: number) => `${value} source${value === 1 ? "" : "s"}`;
  const afterTimeout = deferred("runner_timed_out");
  if (afterTimeout > 0) {
    const timedOut = result.sourceResults.flatMap((sourceResult) =>
      (sourceResult.status === "failed" || sourceResult.status === "partial") &&
      sourceResult.issue.code === "command_timed_out"
        ? [sourceResult.source]
        : [],
    );
    return `ccusage timed out for ${timedOut.join(", ")}; skipped ${count(afterTimeout)} until the next run`;
  }
  const afterDeadline = deferred("run_deadline");
  if (afterDeadline > 0) {
    return `the run reached its ${SERVICE_SOURCE_DEADLINE_MS / 60_000}-minute limit; skipped ${count(afterDeadline)} until the next run`;
  }

  return result.status === "error" ? "ccusage source collection failed" : undefined;
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
    const timings = result.timings?.[sourceResult.source];
    const durations = {
      ...(timings?.dailyMs === undefined ? {} : { dailyMs: timings.dailyMs }),
      ...(timings?.sessionMs === undefined ? {} : { sessionMs: timings.sessionMs }),
    };
    if (sourceResult.status === "failed") {
      return {
        ...durations,
        issue: sourceResult.issue,
        source: sourceResult.source,
        status: sourceResult.status,
      };
    }

    if (sourceResult.status === "skipped") {
      return {
        ...durations,
        ...(sourceResult.reason === "no_data" ? {} : { reason: sourceResult.reason }),
        source: sourceResult.source,
        status: sourceResult.status,
      };
    }

    const summary = sourceResult.summary;
    return {
      ...durations,
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

/**
 * One `service_run` log line. `hasResults: false` (a run that failed before
 * syncing) leaves out rows, upserted, syncStatus and sources: the state
 * still holds the previous run's, which read as this run's results.
 */
function serviceRunLogLine(
  state: ServiceState,
  status: "failure" | "success",
  {
    hasResults = true,
    loginCheck,
  }: {
    hasResults?: boolean;
    /** What a failed login check ran into (see `SyncAuthValidationError`). */
    loginCheck?: LoginCheckFailure | undefined;
  } = {},
) {
  return {
    arch: state.lastArch,
    autoUpdate: state.lastAutoUpdate,
    autoUpdated: state.lastAutoUpdated,
    durationMs: state.lastDurationMs,
    // Set on a success too when the run left sources for the next one.
    error: state.lastError,
    event: "service_run",
    loginCheck,
    reloadRequired: state.reloadRequired,
    ...serviceRepairLogFields(state),
    rows: hasResults ? state.lastRows : undefined,
    schedulerActive: state.lastSchedulerActive,
    since: state.lastSince,
    sources: hasResults ? state.lastSources : undefined,
    syncStatus: hasResults ? state.lastSyncStatus : undefined,
    status,
    timestamp: new Date().toISOString(),
    upserted: hasResults ? state.lastUpserted : undefined,
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

function serviceReconcileDue(state: ServiceState, now: Date, scheduled: boolean): boolean {
  if (!scheduled) {
    return false;
  }

  const lastReconcileAt =
    state.lastReconcileAt === undefined ? Number.NaN : Date.parse(state.lastReconcileAt);
  if (Number.isNaN(lastReconcileAt) || lastReconcileAt > now.getTime()) {
    return true;
  }

  return now.getTime() - lastReconcileAt >= SERVICE_RECONCILE_INTERVAL_MS;
}

function serviceReconcileSince(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): string {
  const days = serviceReconcileWindowDays(env);

  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
}

function serviceReconcileWindowDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env[SERVICE_RECONCILE_WINDOW_ENV]?.trim();
  const days = raw === undefined || !/^\d+$/.test(raw) ? Number.NaN : Number(raw);

  return Number.isInteger(days) && days >= 1 && days <= SERVICE_RECONCILE_WINDOW_MAX_DAYS
    ? days
    : SERVICE_RECONCILE_WINDOW_DAYS;
}

function earliestDateKey(first: string | undefined, second: string): string {
  return first !== undefined && first < second ? first : second;
}

function serviceNeedsUsageReplacementBackfill(state: ServiceState, scheduled: boolean): boolean {
  return (
    scheduled && (state.usageReplacementBackfillVersion ?? 0) < USAGE_REPLACEMENT_BACKFILL_VERSION
  );
}

function serviceCompletedUsageReplacementBackfill(result: SyncResult): boolean {
  return result.sourceResults.some(
    (source) => source.source === "codex" && source.status !== "failed",
  );
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
  currentHostname: string = hostname(),
): Promise<boolean> {
  if (!status.locked) {
    return false;
  }
  const holderGone =
    status.pid !== undefined &&
    status.pid > 0 &&
    (status.hostname === undefined ||
      status.hostname.toLowerCase() === currentHostname.toLowerCase()) &&
    !(await processIsAlive(status.pid));
  if (!status.stale) {
    // A run killed by SIGKILL, the OOM killer or a power loss never released
    // its lock, which blocked every sync until it went stale 2 h later. Its
    // pid only means something on the machine that wrote it.
    return options.pidAwareStaleTakeover && holderGone;
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
    hostname: hostname(),
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
      hostname: lock.hostname,
      locked: true,
      pid: lock.pid || undefined,
      stale: true,
    };
  }

  const ageMs = Math.max(0, now.getTime() - acquiredAt);

  return {
    acquiredAt: lock.acquiredAt,
    ageMs,
    hostname: lock.hostname,
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

function serviceSourceCadencePath(paths: Pick<ServicePaths, "configDir">): string {
  return join(paths.configDir, SOURCE_CADENCE_FILE_NAME);
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
    ...(state.lastReconcileAt === undefined ? {} : { lastReconcileAt: state.lastReconcileAt }),
    ...(state.lastSchedulerActive === undefined
      ? {}
      : { lastSchedulerActive: state.lastSchedulerActive }),
    ...(state.lastSince === undefined ? {} : { lastSince: state.lastSince }),
    ...(state.lastSources === undefined ? {} : { lastSources: state.lastSources }),
    ...(state.lastSyncStatus === undefined ? {} : { lastSyncStatus: state.lastSyncStatus }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastUpserted === undefined ? {} : { lastUpserted: state.lastUpserted }),
    ...(state.reloadRequired === undefined ? {} : { reloadRequired: state.reloadRequired }),
    ...(state.usageReplacementBackfillVersion === undefined
      ? {}
      : { usageReplacementBackfillVersion: state.usageReplacementBackfillVersion }),
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
      const distTags = yield* (runtime.fetchDistTags ?? fetchCliDistTags)();
      const latestVersion =
        distTags === null
          ? null
          : (resolveUpdate(options.currentVersion, distTags).newest?.version ?? null);
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
    const commandExists_ = runtime.commandExists ?? commandExists;
    const runUpdate = runtime.runPackageManagerUpdate ?? runPackageManagerUpdate;
    const readInstalledVersion = runtime.readInstalledVersion ?? readInstalledCliVersion;
    const distTags = yield* (runtime.fetchDistTags ?? fetchCliDistTags)();
    const resolution = distTags === null ? null : resolveUpdate(options.currentVersion, distTags);

    if (resolution === null || resolution.newest === null) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        latestVersion: null,
        manager: metadata.autoUpdateManager ?? null,
        reason: "latest-unknown",
        status: "skipped",
      });
    }

    // Only a strictly newer version on a followed dist-tag is installed; a
    // prerelease runner ahead of `latest` must never be "updated" back to it.
    const latestVersion = resolution.newest.version;
    const target = resolution.update;
    if (target === null) {
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

    // The exact version, never a dist-tag the package manager might resolve
    // from a stale cache; the --version check below confirms it landed.
    const updateResult = yield* runUpdate(manager, target.version).pipe(
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
      normalizeVersion(installedVersion) !== normalizeVersion(target.version)
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

    const fetchRunnerRelease = runtime.fetchRunnerRelease ?? fetchServiceRunnerRelease;
    const releases = new Map<string, ServiceRunnerRelease>();
    for (const target of targets) {
      for (const distTag of followedDistTags(options.currentVersion)) {
        const fetchResult = yield* fetchRunnerRelease(target, distTag).pipe(
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
        if (fetchResult.value !== null) {
          releases.set(distTag, fetchResult.value);
        }
      }

      if (releases.size > 0) {
        break;
      }
    }

    const resolution = resolveUpdate(
      options.currentVersion,
      Object.fromEntries([...releases].map(([distTag, release]) => [distTag, release.version])),
    );
    if (resolution.newest === null) {
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

    if (resolution.update === null) {
      return serviceAutoUpdateReport({
        attemptedAt,
        completedAt: now().toISOString(),
        currentVersion: options.currentVersion,
        enabled: true,
        installedVersion: options.currentVersion,
        latestVersion: resolution.newest.version,
        manager: "registry",
        reason: null,
        status: "not-needed",
      });
    }
    const release = releases.get(resolution.update.distTag)!;

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

function fetchCliDistTags(): Effect.Effect<DistTags | null, never> {
  return fetchDistTags(SERVICE_FETCH_TIMEOUT_MS).pipe(Effect.catch(() => Effect.succeed(null)));
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
    parseSemVer(version) === null ||
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

function readInstalledCliVersion(
  commandPath: string,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<string | null, never> {
  const invocation = commandShimInvocation(commandPath, ["--version"], platform);
  return Effect.tryPromise({
    try: async () => {
      const { stderr, stdout } = await execFilePromise(invocation.command, invocation.args, {
        timeout: SERVICE_VERSION_TIMEOUT_MS,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      return parseCliVersion(`${stdout}\n${stderr}`);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function parseCliVersion(output: string): string | null {
  const match = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1] ?? null;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").replace(/\+.*/, "");
}

function formatAutoUpdateError(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return String(cause);
}

/** Installs exactly `version` with `manager`; see `autoUpdateCommand`. */
function runPackageManagerUpdate(
  manager: AutoUpdateManager,
  version: string,
  options: PackageManagerUpdateOptions = {},
): Effect.Effect<void, PackageManagerUpdateError> {
  const { args, command } = autoUpdateCommand(manager, version, options);
  const description = autoUpdateCommandDescription(manager, version, options);

  return Effect.tryPromise({
    try: async () => {
      await execFilePromise(command, args, {
        maxBuffer: 16 * 1024 * 1024,
        timeout: SERVICE_PACKAGE_UPDATE_TIMEOUT_MS,
        windowsHide: true,
      });
    },
    catch: (cause) =>
      new PackageManagerUpdateError({
        cause,
        command: description,
        output: packageManagerFailureOutput(cause),
        timedOut: (cause as { killed?: unknown })?.killed === true,
      }),
  });
}

// What the package manager printed about the failure: its stderr (or stdout
// when stderr is empty), without colors, capped to the last lines.
function packageManagerFailureOutput(cause: unknown): string {
  const { stderr, stdout } = (cause ?? {}) as { stderr?: unknown; stdout?: unknown };
  const pick = (value: unknown) =>
    typeof value === "string" ? value.replaceAll(ANSI_ESCAPE_SEQUENCE, "").trim() : "";
  const output = pick(stderr) || pick(stdout);
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-PACKAGE_MANAGER_OUTPUT_MAX_LINES)
    .join("\n");

  return lines.length > PACKAGE_MANAGER_OUTPUT_MAX_CHARS
    ? `…${lines.slice(-PACKAGE_MANAGER_OUTPUT_MAX_CHARS)}`
    : lines;
}

function refreshServiceAfterUpdate(options: { commandPath: string }): Effect.Effect<void, unknown> {
  const invocation = commandShimInvocation(options.commandPath, [
    "service",
    "install",
    "--refresh",
  ]);
  return runExecutable(invocation.command, invocation.args, {
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

/**
 * How to run the `tokenmaxxing` found on PATH with `args`. On Windows that is
 * usually npm's `tokenmaxxing.cmd` shim, which execFile cannot start without
 * a shell (EINVAL), so it goes through `cmd.exe /d /s /c "<shim> <args>"`.
 * `args` are fixed words, never user input.
 */
function commandShimInvocation(
  commandPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { args: string[]; command: string; windowsVerbatimArguments: boolean } {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(commandPath)) {
    return { args: [...args], command: commandPath, windowsVerbatimArguments: false };
  }

  return {
    args: ["/d", "/s", "/c", `""${commandPath}" ${args.join(" ")}"`],
    command: env["ComSpec"] ?? "cmd.exe",
    windowsVerbatimArguments: true,
  };
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

function doctorCheck(status: "info" | "ok", label: string, detail: string): DoctorCheck {
  return { detail, label, status };
}

/** A WARN or FAIL check: what is wrong, then the one command that fixes it. */
function doctorProblem(
  status: "fail" | "warn",
  label: string,
  problem: string,
  fix: string,
): DoctorCheck {
  return { detail: `${problem}; ${fix}`, fix, label, status };
}

function windowsLauncherDoctorCheck(path: string, status: WindowsLauncherStatus): DoctorCheck {
  if (status === "current") {
    return doctorCheck("ok", "launcher", path);
  }

  // A missing launcher fails every run; an outdated one may still start it.
  return doctorProblem(
    status === "missing" ? "fail" : "warn",
    "launcher",
    `${path} ${status}`,
    `repair with ${serviceRepairCommand()}`,
  );
}

function doctorLine(check: DoctorCheck): string {
  return `${check.status.toUpperCase().padEnd(4)} ${check.label.padEnd(12)} ${check.detail}`;
}

/**
 * Auto-update as `service status` and `service doctor` both report it. The
 * manager comes from service.json, or for installs that predate it, from how
 * the `tokenmaxxing` on PATH was installed.
 */
function readServiceAutoUpdateCheck(
  metadata: ServiceMetadata | null,
  installed: boolean,
  currentCommand: CommandInstall | null,
): Effect.Effect<DoctorCheck, never> {
  return Effect.gen(function* () {
    const manager =
      metadata === null
        ? undefined
        : (metadata.autoUpdateManager ?? currentCommand?.autoUpdateManager);
    const managerExists =
      manager === "registry"
        ? true
        : manager === undefined || manager === null
          ? false
          : yield* commandExists(manager);

    return serviceAutoUpdateCheck(metadata, { installed, manager, managerExists });
  });
}

function serviceAutoUpdateCheck(
  metadata: ServiceMetadata | null,
  input: {
    installed: boolean;
    manager: ServiceMetadataAutoUpdateManager | null | undefined;
    managerExists: boolean;
  },
): DoctorCheck {
  const repair = `repair with ${serviceRepairCommand()}`;
  if (metadata === null) {
    // Without service.json the runner cannot tell what to update.
    return input.installed
      ? doctorProblem("warn", "auto-update", "off (service.json missing or unreadable)", repair)
      : doctorCheck("info", "auto-update", "unknown (service not installed)");
  }

  const { manager } = input;
  if (manager === "registry") {
    return doctorCheck("ok", "auto-update", "enabled via registry runner packages");
  }

  // Older installs update through a package manager; a repair moves them to
  // registry runner packages.
  if (manager === null || manager === undefined) {
    return doctorProblem(
      "warn",
      "auto-update",
      "enabled, but the package manager was not detected",
      repair,
    );
  }

  return input.managerExists
    ? doctorCheck(
        "ok",
        "auto-update",
        `enabled via ${manager} (${autoUpdateCommandDescription(manager, "<version>")})`,
      )
    : doctorProblem(
        "warn",
        "auto-update",
        `enabled via ${manager}, but ${manager} is not on PATH`,
        repair,
      );
}

function formatInstallAutoUpdate(manager: ServiceMetadataAutoUpdateManager | null): string {
  if (manager === "registry") {
    return "enabled via registry runner packages";
  }

  return manager === null
    ? "enabled, but package manager was not detected"
    : `enabled via ${manager} (${autoUpdateCommandDescription(manager, "<version>")})`;
}

/**
 * The stored login the service syncs with. TOKENMAXXING_API_TOKEN wins over
 * it in this shell but never reaches the service, so it hides what the
 * service would use.
 */
function doctorAuthCheck(envToken: boolean, authConfig: DoctorAuthConfig): DoctorCheck {
  if (envToken) {
    return doctorProblem(
      "warn",
      "auth",
      "TOKENMAXXING_API_TOKEN is set, which hides the stored login the service uses",
      "unset TOKENMAXXING_API_TOKEN and rerun tokenmaxxing service doctor",
    );
  }

  if (authConfig._tag === "error") {
    const message =
      authConfig.cause instanceof Error ? authConfig.cause.message : String(authConfig.cause);
    const lines = message.split("\n");
    const hint = lines.find((line) => line.startsWith("hint: "))?.slice("hint: ".length);
    return doctorProblem(
      "fail",
      "auth",
      (lines[0] ?? message).replace(/^error: /, ""),
      hint ?? "run tokenmaxxing login",
    );
  }

  if (!authConfig.value.token) {
    return doctorProblem("fail", "auth", "stored token missing", "run tokenmaxxing login");
  }

  return doctorCheck(
    "ok",
    "auth",
    authConfig.value.deviceId === undefined
      ? "stored token present; the next sync creates the device id"
      : "stored token and device id present",
  );
}

type ServiceRunnerInspection = { _tag: "ok"; path: string } | { _tag: "broken"; detail: string };

/**
 * What the wrapper would find: the pointer file names an existing, non-empty,
 * executable runner. The wrapper exits 127 for a missing one, and `sh` runs a
 * 0-byte one as an empty script that exits 0, so a sync never happens.
 */
function inspectServiceRunner(paths: ServicePaths): Effect.Effect<ServiceRunnerInspection, never> {
  return Effect.promise(async (): Promise<ServiceRunnerInspection> => {
    let pointer: string;
    try {
      pointer = (await readFile(paths.runnerPointerPath, "utf8")).trim();
    } catch {
      return { _tag: "broken", detail: `pointer missing: ${paths.runnerPointerPath}` };
    }
    if (pointer === "" || pointer.includes("\n") || !isAbsolute(pointer)) {
      return { _tag: "broken", detail: `pointer is not a runner path: ${paths.runnerPointerPath}` };
    }

    try {
      const info = await stat(pointer);
      if (!info.isFile()) {
        return { _tag: "broken", detail: `runner is not a file: ${pointer}` };
      }
      if (info.size === 0) {
        return { _tag: "broken", detail: `runner is empty (0 bytes): ${pointer}` };
      }
      if (process.platform !== "win32") {
        await access(pointer, constants.X_OK).catch(() => {
          throw new Error("not executable");
        });
      }
    } catch (cause) {
      return {
        _tag: "broken",
        detail:
          (cause as Error).message === "not executable"
            ? `runner is not executable: ${pointer}`
            : `runner missing: ${pointer}`,
      };
    }

    return { _tag: "ok", path: pointer };
  });
}

/** `service status` lines for a service newer than this CLI and for the runner. */
function serviceStatusRunnerLines(status: {
  newerThanCli: ServiceNewerThanCli | null;
  runnerIssue: string | null;
  runnerTarget: string | null;
  runnerVersion: string | null;
}): string[] {
  const lines: string[] = [];
  // Only a newer template, like doctor: a runner newer than the global CLI is
  // what every auto-update leaves behind, and the Runner line shows it.
  const template = status.newerThanCli?.template;
  if (template !== undefined) {
    const newer = formatServiceNewerThanCli({ template });
    lines.push(
      `${newer.charAt(0).toUpperCase()}${newer.slice(1)}; upgrade the CLI with tokenmaxxing upgrade`,
    );
  }
  // A missing, empty or broken runner never syncs, whatever service.json says.
  if (status.runnerIssue !== null) {
    lines.push(`Runner: ${status.runnerIssue}; repair with ${serviceRepairCommand()}`);
  } else if (status.runnerTarget !== null || status.runnerVersion !== null) {
    lines.push(
      `Runner: ${status.runnerVersion ?? "unknown"}${status.runnerTarget === null ? "" : ` (${status.runnerTarget})`}`,
    );
  }

  return lines;
}

function doctorTemplateCheck(
  metadata: ServiceMetadata | null,
  reloadRequired: boolean,
): DoctorCheck {
  // Only the template: a runner newer than the global CLI is what every
  // auto-update leaves behind.
  const template = serviceNewerThanCli(metadata)?.template;
  if (template !== undefined) {
    return doctorProblem(
      "warn",
      "template",
      formatServiceNewerThanCli({ template }),
      "upgrade the CLI with tokenmaxxing upgrade",
    );
  }

  if (metadata === null) {
    return doctorCheck("info", "template", "unknown (service.json missing or unreadable)");
  }

  return reloadRequired
    ? doctorProblem("warn", "template", "reload required", `repair with ${serviceRepairCommand()}`)
    : doctorCheck("ok", "template", `current (${metadata.templateVersion ?? "unknown"})`);
}

function doctorDefinitionCheck(paths: ServicePaths, exists: boolean): DoctorCheck {
  // Windows keeps the task in Task Scheduler, not in a file; `active` checks it.
  const definition = paths.definitionPath ?? `Task Scheduler task ${windowsTaskName()}`;
  return exists
    ? doctorCheck("ok", "definition", definition)
    : doctorProblem(
        "fail",
        "definition",
        `missing: ${definition}`,
        `repair with ${serviceRepairCommand()}`,
      );
}

function doctorRunnerCheck(
  runner: ServiceRunnerInspection,
  metadata: ServiceMetadata | null,
): DoctorCheck {
  if (runner._tag === "broken") {
    return doctorProblem("fail", "runner", runner.detail, `repair with ${serviceRepairCommand()}`);
  }

  return doctorCheck(
    "ok",
    "runner",
    metadata?.runnerTarget === undefined
      ? runner.path
      : `${metadata.runnerVersion ?? "unknown"} (${metadata.runnerTarget})`,
  );
}

/**
 * The run lock as `service status` and `service doctor` both report it,
 * judged the way the next run will (`serviceLockCanBeReplaced`): a lock the
 * next run takes over, or one held by a sync that is running, is fine to
 * know about; one a live process has held past the stale age blocks every
 * sync.
 */
function serviceLockCheck(
  paths: ServicePaths,
  status: ServiceLockStatus,
  currentHostname: string = hostname(),
): Effect.Effect<DoctorCheck, never> {
  return Effect.promise(async () => {
    const held = formatServiceLockStatus(status);
    if (!status.locked) {
      return doctorCheck("ok", "lock", held);
    }

    if (await serviceLockCanBeReplaced(status, { pidAwareStaleTakeover: true }, currentHostname)) {
      return doctorCheck(
        "info",
        "lock",
        status.pid !== undefined && status.pid > 0
          ? `${held}; pid ${status.pid} is gone, so the next run takes it over`
          : `${held}; the next run takes it over`,
      );
    }

    // A pid only means something on the machine that wrote it (a config dir
    // on a synced or network drive).
    const foreign =
      status.hostname !== undefined &&
      status.hostname.toLowerCase() !== currentHostname.toLowerCase();
    if (status.stale) {
      return doctorProblem(
        "warn",
        "lock",
        `${held}; pid ${status.pid} on ${foreign ? status.hostname : "this machine"} has held it for over ${SERVICE_LOCK_STALE_MS / 3_600_000} hours, so every run skips`,
        `if it is not a tokenmaxxing sync, remove ${paths.lockPath}`,
      );
    }

    return doctorCheck(
      "info",
      "lock",
      foreign
        ? `${held}; held by ${status.hostname}, where a sync may be running; runs here skip until it is released`
        : status.pid !== undefined && status.pid > 0
          ? `${held}; a sync is running`
          : `${held}; runs skip until it is released`,
    );
  });
}

/**
 * The command the service runs for its deferred repairs and to refresh
 * itself after an auto-update: the runner, or the global CLI on older installs.
 */
function doctorBinaryCheck(metadata: ServiceMetadata | null, exists: boolean): DoctorCheck {
  if (metadata === null) {
    return doctorCheck("info", "binary", "unknown (service.json missing or unreadable)");
  }

  return exists
    ? doctorCheck(
        "ok",
        "binary",
        `${metadata.commandPath}${metadata.resolvedCommandPath === undefined ? "" : ` -> ${metadata.resolvedCommandPath}`}`,
      )
    : doctorProblem(
        "warn",
        "binary",
        `missing: ${metadata.commandPath}`,
        `repair with ${serviceRepairCommand()}`,
      );
}

/**
 * A failed run stores `String(cause)`, which for a CLI error is its whole
 * message ("SyncAuthValidationError: error: …\nhint: …"). Status and doctor
 * show its first line; `service run` shows the rest.
 */
function formatServiceLastError(error: string): string {
  const first = error.split(/\r?\n/).find((line) => line.trim() !== "") ?? error;
  return first
    .trim()
    .replace(/^[A-Z][A-Za-z]*Error: /, "")
    .replace(/^error: /, "");
}

function doctorLastRepairCheck(state: ServiceState | null): DoctorCheck {
  if (state?.lastRepairStatus === undefined) {
    return doctorCheck("info", "last repair", "none");
  }

  const repair = `${state.lastRepairStatus}${
    state.lastRepairReason === undefined ? "" : ` (${state.lastRepairReason})`
  }${state.lastRepairError === undefined ? "" : `; ${state.lastRepairError}`}`;
  return state.lastRepairStatus === "failure"
    ? doctorProblem("warn", "last repair", repair, `repair with ${serviceRepairCommand()}`)
    : doctorCheck("info", "last repair", repair);
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

function windowsLauncherPath(paths: ServicePaths): string | null {
  return paths.backend === "windows-task-scheduler"
    ? join(paths.configDir, WINDOWS_LAUNCHER_NAME)
    : null;
}

function windowsLauncherPathForEnv(env: Record<string, string | undefined>): string {
  return join(dirname(getConfigPath(env)), WINDOWS_LAUNCHER_NAME);
}

function windowsTaskXmlPath(paths: ServicePaths): string {
  return join(paths.configDir, WINDOWS_TASK_XML_NAME);
}

// Task Scheduler runs actions from its native (64-bit on x64/arm64) host, so %SystemRoot%\System32
// is always the native wscript.exe there, even if this CLI runs under WOW64 file-system redirection.
function windowsScriptHostPath(env: Record<string, string | undefined> = process.env): string {
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";

  return `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\wscript.exe`;
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

/**
 * The runner a repair (or install) should use. The service's own runner
 * wins when it is newer than this CLI: a global CLI that npm never updated
 * would otherwise "repair" an auto-updated runner back to its own, older
 * version (and the runner would then auto-update again).
 */
function keepNewerCurrentRunner(
  paths: ServicePaths,
  ownVersion: string,
  readCurrent: (paths: ServicePaths) => Effect.Effect<ServiceRunnerInstall, unknown>,
): Effect.Effect<ServiceRunnerInstall | null, never> {
  return readCurrent(paths).pipe(
    Effect.map((current) => (isNewerVersion(ownVersion, current.version) ? current : null)),
    Effect.catch(() => Effect.succeed(null)),
  );
}

function installServiceRunnerForRepair(
  paths: ServicePaths,
  options: Parameters<typeof installServiceRunner>[1] & {
    readCurrentRunner?: (paths: ServicePaths) => Effect.Effect<ServiceRunnerInstall, unknown>;
  } = {},
): Effect.Effect<ServiceRunnerInstall, unknown> {
  return keepNewerCurrentRunner(
    paths,
    options.runnerVersion ?? packageJson.version,
    options.readCurrentRunner ?? readCurrentServiceRunnerInstall,
  ).pipe(
    Effect.flatMap((current) =>
      current !== null ? Effect.succeed(current) : installOwnServiceRunnerForRepair(paths, options),
    ),
  );
}

function installOwnServiceRunnerForRepair(
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
  // A refresh or repair usually installs the runner that is already there.
  // Rewriting it anyway replaced a binary a running sync had open (EPERM on
  // Windows) and changed a file macOS Background Task Management watches.
  if (input.sourceBytes !== undefined) {
    if (!(await fileHasBytes(input.destinationPath, input.sourceBytes))) {
      await writeFileAtomic(
        input.destinationPath,
        input.sourceBytes,
        executableMode(input.platform),
      );
    }
  } else if (input.sourcePath !== undefined) {
    if (!(await filesHaveSameBytes(input.sourcePath, input.destinationPath))) {
      await copyFileAtomic(input.sourcePath, input.destinationPath, executableMode(input.platform));
    }
  } else {
    throw new Error("missing service runner source");
  }
  const mode = executableMode(input.platform);
  if (mode !== undefined && ((await stat(input.destinationPath)).mode & 0o777) !== mode) {
    await chmod(input.destinationPath, mode);
  }
  if (input.updatePointer !== false) {
    await writeFileIfChanged(input.paths.runnerPointerPath, `${input.destinationPath}\n`);
  }
}

function writeServiceRunnerPointer(
  paths: ServicePaths,
  runnerPath: string,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => writeFileIfChanged(paths.runnerPointerPath, `${runnerPath}\n`),
    catch: (cause) => cause,
  });
}

async function fileHasBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile() || info.size !== bytes.length) {
    return false;
  }

  return Buffer.from(bytes).equals(await readFile(path));
}

async function filesHaveSameBytes(sourcePath: string, destinationPath: string): Promise<boolean> {
  if (sourcePath === destinationPath) {
    return true;
  }
  const [source, destination] = await Promise.all([
    stat(sourcePath).catch(() => null),
    stat(destinationPath).catch(() => null),
  ]);
  if (source === null || destination === null || source.size !== destination.size) {
    return false;
  }

  return (await readFile(sourcePath)).equals(await readFile(destinationPath));
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

// The wrapper never embeds its own directory: cmd.exe decodes batch files in the console code
// page, so the log and runner pointer are addressed through %~dp0 instead. chcp 65001 makes the
// rest of the file (captured environment, runner pointer) decode as UTF-8. Paths are only ever
// expanded inside quotes and outside parenthesized blocks, where & ( ) would otherwise break the
// line.
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
"%SystemRoot%\\System32\\chcp.com" 65001 >nul\r
setlocal\r
${sets}\r
set "TOKENMAXXING_LOG=%~dp0${win32.basename(logPath)}"\r
${renderWindowsLogRotation()}\r
>> "%TOKENMAXXING_LOG%" echo [%DATE% %TIME%] tokenmaxxing service sync\r
set "TOKENMAXXING_SERVICE_RUNNER="\r
set /p TOKENMAXXING_SERVICE_RUNNER=<"%~dp0${win32.basename(runnerPointerPath)}"\r
if not defined TOKENMAXXING_SERVICE_RUNNER goto runner_pointer_empty\r
if not exist "%TOKENMAXXING_SERVICE_RUNNER%" goto runner_missing\r
"%TOKENMAXXING_SERVICE_RUNNER%" ${serviceRunCommandArgs()} >> "%TOKENMAXXING_LOG%" 2>&1\r
exit /b %ERRORLEVEL%\r
:runner_pointer_empty\r
>> "%TOKENMAXXING_LOG%" echo tokenmaxxing service runner pointer is empty\r
exit /b 127\r
:runner_missing\r
>> "%TOKENMAXXING_LOG%" echo tokenmaxxing service runner missing: "%TOKENMAXXING_SERVICE_RUNNER%"\r
exit /b 127\r
`;
}

// schtasks can only register interactive tasks, so a task that starts the .cmd wrapper directly
// opens a console window on every run. The task starts this launcher with wscript.exe (a GUI
// host) instead. It runs the wrapper with a hidden window (style 0), waits for it, and exits with
// its code so Task Scheduler still records the sync result. cmd.exe keeps its hidden console, so
// the runner and ccusage children inherit it rather than allocating visible ones.
//
// The script is pure ASCII (wscript reads .vbs files in the ANSI code page) and never embeds a
// path: it runs the wrapper by relative name from its own folder, so no profile path passes
// through cmd.exe's command-line parsing. "repair <reason>" runs the deferred repair command from
// TOKENMAXXING_SERVICE_REPAIR_COMMAND the same way.
function renderWindowsLauncher(): string {
  return `' Generated by tokenmaxxing. Runs service commands without a console window.\r
Option Explicit\r
Dim shell, cmd, command, exitCode\r
Set shell = CreateObject("WScript.Shell")\r
cmd = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\cmd.exe"""\r
command = cmd & " /d /c .\\${WINDOWS_WRAPPER_NAME}"\r
If WScript.Arguments.Count = 2 Then\r
  If WScript.Arguments(0) = "repair" Then\r
    command = cmd & " /d /s /c """"" & shell.Environment("PROCESS")("${WINDOWS_REPAIR_COMMAND_ENV}") & """ service repair --deferred --json --reason " & WScript.Arguments(1) & """"\r
  End If\r
End If\r
On Error Resume Next\r
shell.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\"))\r
If Err.Number = 0 Then exitCode = shell.Run(command, 0, True)\r
If Err.Number <> 0 Then exitCode = 127\r
On Error GoTo 0\r
WScript.Quit exitCode\r
`;
}

function renderWindowsLogRotation(): string {
  const moves = Array.from({ length: SERVICE_LOG_ROTATIONS - 1 }, (_, index) => {
    const rotation = SERVICE_LOG_ROTATIONS - index;
    const previousRotation = rotation - 1;

    return `  if exist "%TOKENMAXXING_LOG%.${previousRotation}" move /y "%TOKENMAXXING_LOG%.${previousRotation}" "%TOKENMAXXING_LOG%.${rotation}" >nul 2>nul`;
  }).join("\r\n");

  return `if exist "%TOKENMAXXING_LOG%" for %%A in ("%TOKENMAXXING_LOG%") do if %%~zA GEQ ${SERVICE_LOG_MAX_BYTES} (\r
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
ExecStart=${systemdExecStart(paths.wrapperPath)}
TimeoutStartSec=${SYSTEMD_RUN_TIMEOUT}
`;
}

// systemd rejects an executable path containing a quote or backslash ("Executable name contains
// special characters") however it is escaped, so such a wrapper (a config dir like "O'Neil") runs
// as /bin/sh's argument instead. Other paths keep the plain form existing units already have.
function systemdExecStart(wrapperPath: string): string {
  return /["'\\]/.test(wrapperPath)
    ? `/bin/sh ${systemdQuote(wrapperPath)}`
    : systemdQuote(wrapperPath);
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

// Files whose bytes already match are left alone (same inode and mtime), and the result says
// whether the scheduler definition or the wrapper changed. macOS Background Task Management
// tracks both the plist and the wrapper it runs; replacing them on every update is what made
// it show "can run in the background" again after each one.
function writeServiceFiles(
  paths: ServicePaths,
  wrapper: string,
  metadata: ServiceMetadata,
): Effect.Effect<ServiceFilesChange, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(paths.configDir, { recursive: true });
      if (paths.definitionPath !== null) {
        await mkdir(dirname(paths.definitionPath), { recursive: true });
      }

      for (const legacyWrapperPath of legacyServiceWrapperPaths(paths)) {
        await rm(legacyWrapperPath, { force: true });
      }
      const wrapperChanged = await writeFileIfChanged(
        paths.wrapperPath,
        wrapper,
        paths.backend === "windows-task-scheduler" ? undefined : 0o755,
      );
      const launcherPath = windowsLauncherPath(paths);
      if (launcherPath !== null) {
        await writeWindowsLauncherFile(launcherPath);
      }
      await writeFileIfChanged(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      let definitionChanged = false;
      if (paths.backend === "launchd" && paths.definitionPath !== null) {
        definitionChanged = await writeFileIfChanged(
          paths.definitionPath,
          renderLaunchdPlist(paths),
        );
      }
      if (paths.backend === "systemd" && paths.definitionPath !== null) {
        const serviceChanged = await writeFileIfChanged(
          paths.definitionPath,
          renderSystemdService(paths),
        );
        const timerChanged = await writeFileIfChanged(
          systemdTimerPath(paths.definitionPath),
          renderSystemdTimer(),
        );
        definitionChanged = serviceChanged || timerChanged;
      }

      return { definition: definitionChanged, wrapper: wrapperChanged };
    },
    catch: (cause) => cause,
  });
}

function removeServiceFiles(paths: ServicePaths): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await rm(paths.wrapperPath, { force: true });
      const launcherPath = windowsLauncherPath(paths);
      if (launcherPath !== null) {
        await rm(launcherPath, { force: true });
        await rm(windowsTaskXmlPath(paths), { force: true });
      }
      for (const legacyWrapperPath of legacyServiceWrapperPaths(paths)) {
        await rm(legacyWrapperPath, { force: true });
      }
      await rm(paths.metadataPath, { force: true });
      await rm(paths.runnerPointerPath, { force: true });
      await rm(paths.runnersDir, { force: true, recursive: true });
      await rm(paths.statePath, { force: true });
      await rm(serviceSourceCadencePath(paths), { force: true });
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

// Reloads the job only when its definition changed or the scheduler is not running what is on
// disk (not loaded, loaded from other settings, or systemd reporting NeedDaemonReload), so a
// refresh that changed nothing leaves launchd and systemd alone. A deferred launchd repair
// writes the plist without reloading it; the loaded-job comparison catches that on the next
// foreground refresh or repair. The Windows task is re-registered only when the registered one
// differs (windowsTaskMatches) or is disabled: its XML carries the registration time as the
// trigger's start, so re-registering restarts the schedule.
function installNativeScheduler(
  paths: ServicePaths,
  change: ServiceFilesChange = { definition: true, wrapper: true },
  runtime: {
    readOutput?: typeof readExecutableOutput;
    readTaskXml?: () => Effect.Effect<RegisteredWindowsTask, never>;
    run?: typeof runExecutable;
  } = {},
): Effect.Effect<void, unknown> {
  const run = runtime.run ?? runExecutable;
  const readOutput = runtime.readOutput ?? readExecutableOutput;

  if (paths.backend === "launchd") {
    const domain = launchdDomain();
    return Effect.gen(function* () {
      if (!change.definition) {
        const loaded = yield* readOutput("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]);
        if (loaded !== null && launchdJobMatches(loaded, paths)) {
          return;
        }
      }
      yield* run("launchctl", ["bootout", domain, paths.definitionPath!]).pipe(Effect.ignore);
      yield* run("launchctl", ["bootstrap", domain, paths.definitionPath!]);
      yield* run("launchctl", ["enable", `${domain}/${SERVICE_LABEL}`]);
    });
  }

  if (paths.backend === "systemd") {
    return Effect.gen(function* () {
      if (!change.definition) {
        const units = yield* readOutput("systemctl", [
          "--user",
          "show",
          `${SYSTEMD_NAME}.service`,
          `${SYSTEMD_NAME}.timer`,
          "--property=Id,NeedDaemonReload,ActiveState,UnitFileState",
        ]);
        if (units !== null && systemdUnitsAreCurrent(units)) {
          return;
        }
      }
      yield* run("systemctl", ["--user", "daemon-reload"]);
      yield* run("systemctl", ["--user", "enable", "--now", `${SYSTEMD_NAME}.timer`]);
    });
  }

  return Effect.gen(function* () {
    // Re-registering rewrites the task file and restarts its schedule from
    // now (StartBoundary), so an unchanged, enabled task is left alone; a
    // task registered from an elevated shell also cannot be replaced
    // without one.
    const registered = yield* (runtime.readTaskXml ?? readRegisteredWindowsTaskXml)();
    if (registered._tag === "xml" && windowsTaskMatches(registered.xml, paths, process.env)) {
      for (const taskName of windowsTaskNames().slice(1)) {
        yield* run("schtasks", ["/Delete", "/TN", taskName, "/F"]).pipe(Effect.ignore);
      }
      return;
    }
    for (const taskName of windowsTaskNames()) {
      yield* run("schtasks", ["/Delete", "/TN", taskName, "/F"]).pipe(Effect.ignore);
    }
    const xmlPath = windowsTaskXmlPath(paths);
    yield* Effect.tryPromise({
      try: () =>
        writeFileAtomic(xmlPath, encodeWindowsTaskXml(renderWindowsTaskXml(paths, process.env))),
      catch: (cause) => cause,
    });
    yield* run("schtasks", windowsTaskCreateArgs(paths)).pipe(
      Effect.mapError((cause) =>
        /access is denied/i.test(String((cause as { stderr?: unknown })?.stderr ?? cause))
          ? new WindowsTaskAccessDeniedError({ cause })
          : cause,
      ),
      Effect.ensuring(Effect.promise(() => rm(xmlPath, { force: true }).catch(() => undefined))),
    );
  });
}

// `launchctl print` shows the loaded job's settings one tab deep; these are everything
// renderLaunchdPlist sets besides the label the job was looked up by.
function launchdJobMatches(printOutput: string, paths: ServicePaths): boolean {
  const fields = new Map<string, string>();
  for (const line of printOutput.split("\n")) {
    const match = /^\t([^\t=][^=]*?) = (.*)$/.exec(line);
    if (match !== null && !fields.has(match[1]!)) {
      fields.set(match[1]!, match[2]!);
    }
  }

  return (
    fields.get("path") === paths.definitionPath &&
    fields.get("program") === paths.wrapperPath &&
    fields.get("run interval") === `${SERVICE_INTERVAL_SECONDS} seconds` &&
    fields.get("stdout path") === paths.logPath &&
    fields.get("stderr path") === paths.logPath
  );
}

// `systemctl show` prints one block of properties per unit, separated by blank lines.
function systemdUnitsAreCurrent(showOutput: string): boolean {
  const units = new Map(
    showOutput
      .trim()
      .split(/\n\s*\n/)
      .map((block) => {
        const properties = new Map(
          block
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        );
        return [properties.get("Id"), properties] as const;
      }),
  );
  const service = units.get(`${SYSTEMD_NAME}.service`);
  const timer = units.get(`${SYSTEMD_NAME}.timer`);

  return (
    service?.get("NeedDaemonReload") === "no" &&
    timer?.get("NeedDaemonReload") === "no" &&
    timer.get("ActiveState") === "active" &&
    timer.get("UnitFileState") === "enabled"
  );
}

// The task is imported from XML rather than built with /TR: schtasks rewrites every ' in the
// /TR arguments to ", which breaks any launcher path with an apostrophe. The XML keeps the
// defaults `schtasks /SC MINUTE` used to produce (interactive token, battery conditions, one
// instance at a time) and only swaps the action.
function windowsTaskCreateArgs(paths: ServicePaths): string[] {
  return ["/Create", "/TN", windowsTaskName(), "/XML", windowsTaskXmlPath(paths), "/F"];
}

// //B keeps script errors from ever raising a dialog and //E pins the VBScript engine.
function renderWindowsTaskXml(
  paths: ServicePaths,
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): string {
  const launcherPath = join(paths.configDir, WINDOWS_LAUNCHER_NAME);

  return `<?xml version="1.0" encoding="UTF-16"?>\r
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r
  <RegistrationInfo>\r
    <Description>tokenmaxxing automatic sync</Description>\r
  </RegistrationInfo>\r
  <Principals>\r
    <Principal id="Author">\r
      <LogonType>InteractiveToken</LogonType>\r
    </Principal>\r
  </Principals>\r
  <Settings>\r
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>\r
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>\r
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r
  </Settings>\r
  <Triggers>\r
    <TimeTrigger>\r
      <StartBoundary>${windowsTaskStartBoundary(now)}</StartBoundary>\r
      <Repetition>\r
        <Interval>PT${SERVICE_INTERVAL_MINUTES}M</Interval>\r
      </Repetition>\r
    </TimeTrigger>\r
  </Triggers>\r
  <Actions Context="Author">\r
    <Exec>\r
      <Command>${escapeXml(cmdQuote(windowsScriptHostPath(env)))}</Command>\r
      <Arguments>${escapeXml(`//B //NoLogo //E:VBScript ${cmdQuote(launcherPath)}`)}</Arguments>\r
      <WorkingDirectory>${escapeXml(paths.configDir)}</WorkingDirectory>\r
    </Exec>\r
  </Actions>\r
</Task>\r
`;
}

/**
 * Whether the task `schtasks /Query /XML` printed runs what renderWindowsTaskXml
 * would register (same action, interval, instance and battery policy, logon
 * type) and is enabled. The start boundary is ignored: it only records when
 * the task was registered.
 */
function windowsTaskMatches(
  registeredXml: string,
  paths: ServicePaths,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const expected = renderWindowsTaskXml(paths, env);
  // Paths compare the way Windows does: one Unicode form, ignoring case.
  const pathTags = new Set(["Arguments", "Command", "WorkingDirectory"]);
  const field = (xml: string, tag: string) =>
    [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((match) => {
      const value = unescapeXml(match[1]!).trim();
      return pathTags.has(tag) ? windowsPathKey(value) : value;
    });
  const same = (tag: string) =>
    JSON.stringify(field(registeredXml, tag)) === JSON.stringify(field(expected, tag));

  return (
    !/<Enabled>\s*false\s*<\/Enabled>/i.test(registeredXml) &&
    [
      "Command",
      "Arguments",
      "WorkingDirectory",
      "Interval",
      "LogonType",
      "MultipleInstancesPolicy",
      "DisallowStartIfOnBatteries",
      "StopIfGoingOnBatteries",
    ].every(same)
  );
}

/**
 * The registered task's XML: `missing` when there is no task, `unreadable`
 * when it exists but its XML could not be read or decoded reliably.
 */
type RegisteredWindowsTask =
  | { _tag: "missing" }
  | { _tag: "unreadable" }
  | { _tag: "xml"; xml: string };

/**
 * Reads the task's own file (%SystemRoot%\\System32\\Tasks\\<name>, UTF-16 with a
 * BOM, readable by the user who registered it) rather than `schtasks /Query
 * /XML`, which writes to a pipe in the console's OEM code page: "ë" in a
 * config dir under C:\\Users\\Zoë came back as 0x89 and never matched.
 * schtasks is the fallback, trusted only when its bytes are valid UTF-16 or
 * UTF-8.
 */
function readRegisteredWindowsTaskXml(
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<RegisteredWindowsTask, never> {
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";
  const taskFile = join(systemRoot, "System32", "Tasks", windowsTaskName());

  return Effect.tryPromise({
    try: () => readFile(taskFile),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((bytes): RegisteredWindowsTask => {
      const xml = decodeWindowsCommandOutput(bytes);
      return xml === null ? { _tag: "unreadable" } : { _tag: "xml", xml };
    }),
    Effect.catch((cause) =>
      (cause as NodeJS.ErrnoException)?.code === "ENOENT"
        ? Effect.succeed<RegisteredWindowsTask>({ _tag: "missing" })
        : readRegisteredWindowsTaskXmlFromSchtasks(),
    ),
  );
}

function readRegisteredWindowsTaskXmlFromSchtasks(): Effect.Effect<RegisteredWindowsTask, never> {
  return Effect.tryPromise({
    try: () =>
      execFilePromise("schtasks", ["/Query", "/TN", windowsTaskName(), "/XML"], {
        encoding: "buffer",
        timeout: SERVICE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.map(({ stdout }): RegisteredWindowsTask => {
      const xml = decodeWindowsCommandOutput(stdout);
      return xml === null ? { _tag: "unreadable" } : { _tag: "xml", xml };
    }),
    // schtasks exits non-zero for a task that does not exist.
    Effect.catch(() => Effect.succeed<RegisteredWindowsTask>({ _tag: "missing" })),
  );
}

/**
 * UTF-16 (a BOM, or the NUL high bytes of ASCII) or strictly valid UTF-8;
 * null for anything else, such as a legacy code page.
 */
function decodeWindowsCommandOutput(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes);
  const utf16 =
    (buffer[0] === 0xff && buffer[1] === 0xfe) ||
    (buffer.length > 1 && buffer[1] === 0 && buffer[0] !== 0);
  let text: string;
  try {
    text = utf16
      ? buffer.toString("utf16le")
      : new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }

  return text.replace(/^\uFEFF/, "");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// Local wall-clock time, truncated to the minute, like schtasks' own start boundary.
function windowsTaskStartBoundary(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
}

// schtasks reads task XML as UTF-16 LE with a byte-order mark.
function encodeWindowsTaskXml(xml: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
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
  options: { timeoutMs?: number | undefined; windowsVerbatimArguments?: boolean | undefined } = {},
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await execFilePromise(command, [...args], {
        timeout: options.timeoutMs ?? SERVICE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      });
    },
    catch: (cause) => cause,
  });
}

function readExecutableOutput(
  command: string,
  args: readonly string[],
): Effect.Effect<string | null, never> {
  return Effect.tryPromise({
    try: async () =>
      (
        await execFilePromise(command, [...args], {
          timeout: SERVICE_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        })
      ).stdout,
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
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

      const detectedManager = detectAutoUpdateManager({
        commandPath,
        env,
        platform,
        resolvedCommandPath,
      });

      return {
        autoUpdateManager:
          detectedManager ?? ((await isWindowsNpmPrefixShim(commandPath, platform)) ? "npm" : null),
        commandPath: durableCommandPath,
        resolvedCommandPath,
      };
    },
    catch: (cause) => cause,
  });
}

// npm's Windows shims (tokenmaxxing.cmd/.ps1) sit directly in the global prefix
// (%APPDATA%\npm by default, or any --prefix), next to its node_modules, and
// resolve to nothing more telling than themselves; no path pattern covers them.
async function isWindowsNpmPrefixShim(
  commandPath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (platform !== "win32") {
    return false;
  }

  try {
    await access(
      join(dirname(commandPath), "node_modules", "@851-labs", "tokenmaxxing", "package.json"),
      constants.F_OK,
    );
    return true;
  } catch {
    return false;
  }
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

// Usage-source roots ccusage reads (one per line). Values are captured
// literally at install/repair: ccusage splits several of them on commas, so the
// scheduled run sees exactly what a foreground `sync` in the same shell would.
// `service doctor` flags drift between these and the current shell.
const SERVICE_SOURCE_ROOT_ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "GROK_HOME",
  "ANTIGRAVITY_DATA_DIR",
  "ZCODE_HOME",
  "AMP_DATA_DIR",
  "QWEN_DATA_DIR",
  "KIMI_DATA_DIR",
  "KILO_DATA_DIR",
  "GOOSE_PATH_ROOT",
  "DROID_SESSIONS_DIR",
  "CODEBUFF_DATA_DIR",
  "OPENCLAW_DIR",
] as const;

// Environment the scheduled wrapper re-exports; PATH is always set (made
// stable across shells, with a default) and empty or unset values are omitted.
const SERVICE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  ...SERVICE_SOURCE_ROOT_ENV_KEYS,
  "TOKENMAXXING_CONFIG_DIR",
  "TOKENMAXXING_ENV",
  "TOKENMAXXING_API_URL",
  "TOKENMAXXING_WWW_URL",
  NPM_REGISTRY_ENV,
  SERVICE_RECONCILE_WINDOW_ENV,
] as const;

function capturedServiceEnv(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const captured: Record<string, string> = {
    PATH:
      env["PATH"] === undefined
        ? defaultServicePath(platform)
        : stableServicePath(env["PATH"], { env, platform }),
  };

  for (const key of SERVICE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      captured[key] = value;
    }
  }

  return captured;
}

interface ServiceEnvDrift {
  current: string | undefined;
  key: string;
  service: string | undefined;
}

/**
 * Compares the source roots baked into an installed wrapper with the current
 * shell. Roots are only captured at install/repair, so a changed
 * `CODEX_HOME` silently keeps the service on the old location until repair.
 */
function serviceEnvDrift(
  wrapper: string,
  env: Record<string, string | undefined> = process.env,
): ServiceEnvDrift[] {
  const serviceEnv = parseServiceWrapperEnv(wrapper);
  const current = capturedServiceEnv(env);

  return SERVICE_SOURCE_ROOT_ENV_KEYS.flatMap((key) =>
    serviceEnv[key] === current[key]
      ? []
      : [{ current: current[key], key, service: serviceEnv[key] }],
  );
}

/** Reads back the env lines `renderPosixWrapper`/`renderWindowsWrapper` emit. */
function parseServiceWrapperEnv(wrapper: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of wrapper.split(/\r?\n/)) {
    const posix = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
    if (posix?.[1] !== undefined && posix[2] !== undefined) {
      env[posix[1]] = posix[2].replaceAll("'\\''", "'");
      continue;
    }

    const windows = /^set "([A-Za-z_][A-Za-z0-9_]*)=(.*)"$/.exec(line);
    if (windows?.[1] !== undefined && windows[2] !== undefined) {
      // Undoes escapeCmdSetValue.
      env[windows[1]] = windows[2].replaceAll("%%", "%").replaceAll('\\"', '"');
    }
  }

  return env;
}

function doctorServiceEnvCheck(
  wrapper: string | null,
  env: Record<string, string | undefined> = process.env,
): DoctorCheck {
  if (wrapper === null) {
    return doctorCheck("info", "source roots", "not checked (wrapper missing)");
  }

  const drift = serviceEnvDrift(wrapper, env);
  if (drift.length === 0) {
    return doctorCheck("ok", "source roots", "match this shell");
  }

  const changes = drift
    .map(
      ({ current, key, service }) =>
        `${key} is ${service ?? "unset"} for the service but ${current ?? "unset"} here`,
    )
    .join("; ");
  return doctorProblem("warn", "source roots", changes, `repair with ${serviceRepairCommand()}`);
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

/**
 * The package-manager command that installs exactly `version` of the CLI.
 *
 * Always an exact version, never a dist-tag: a package manager resolves a tag
 * from its own cached packument, which npm keeps for the registry's max-age
 * (5 minutes), so `@latest` right after a release can install the previous
 * one and still exit 0. The same stale cache makes a just-published exact
 * version fail with ETARGET, so npm (`--prefer-online`) and bun
 * (`--no-cache`) are told to revalidate their metadata; pnpm already
 * refetches metadata that is missing the requested version, and yarn 1 keeps
 * no metadata cache. npm and pnpm log at `error` level rather than
 * `--silent`, which would hide the error itself.
 */
function autoUpdateCommand(
  manager: AutoUpdateManager,
  version: string,
  options: PackageManagerUpdateOptions = {},
): {
  args: string[];
  command: AutoUpdateManager;
} {
  const packageSpec = `${PACKAGE_NAME}@${version}`;
  // An npm install under a --prefix that is not npm's configured one: say it
  // again, or npm installs a second copy into its default prefix.
  if (manager === "npm" && options.npmPrefix !== undefined) {
    return {
      args: [
        "install",
        "-g",
        "--prefix",
        options.npmPrefix,
        packageSpec,
        "--prefer-online",
        "--loglevel=error",
      ],
      command: "npm",
    };
  }
  switch (manager) {
    case "bun":
      return { args: ["add", "-g", packageSpec, "--no-cache", "--silent"], command: "bun" };
    case "npm":
      return {
        args: ["install", "-g", packageSpec, "--prefer-online", "--loglevel=error"],
        command: "npm",
      };
    case "pnpm":
      return { args: ["add", "-g", packageSpec, "--loglevel=error"], command: "pnpm" };
    case "yarn":
      return { args: ["global", "add", packageSpec, "--silent"], command: "yarn" };
  }
}

function autoUpdateCommandDescription(
  manager: AutoUpdateManager,
  version: string,
  options: PackageManagerUpdateOptions = {},
): string {
  const { command, args } = autoUpdateCommand(manager, version, options);

  return [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
}

interface PackageManagerUpdateOptions {
  /** npm's --prefix, when the install is not under npm's configured prefix. */
  npmPrefix?: string | undefined;
}

/**
 * The npm prefix the detected install lives under: `<prefix>/lib/node_modules`
 * on POSIX, `<prefix>\node_modules` (with the shims in `<prefix>`) on Windows.
 */
function npmPrefixOfInstall(
  install: Pick<CommandInstall, "commandPath" | "resolvedCommandPath">,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const path of [install.resolvedCommandPath, install.commandPath]) {
    const index = path.replaceAll("\\", "/").toLowerCase().indexOf(`/node_modules/${PACKAGE_NAME}`);
    if (index < 0) {
      continue;
    }
    const beforeNodeModules = path.slice(0, index);
    if (platform === "win32") {
      return beforeNodeModules;
    }
    if (/[\\/]lib$/.test(beforeNodeModules)) {
      return beforeNodeModules.slice(0, -"/lib".length);
    }
  }

  // npm's Windows shims (tokenmaxxing.cmd) sit in the prefix itself.
  return platform === "win32" ? win32.dirname(install.commandPath) : null;
}

/** `--prefix` for an npm update, or undefined when npm's configured prefix already is it. */
function npmUpdatePrefix(
  install: Pick<CommandInstall, "commandPath" | "resolvedCommandPath">,
  configuredPrefix: string | null,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const installPrefix = npmPrefixOfInstall(install, platform);
  if (installPrefix === null || configuredPrefix === null) {
    return undefined;
  }
  const normalize = (path: string) => {
    const trimmed = path.trim().replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
  };

  return normalize(installPrefix) === normalize(configuredPrefix) ? undefined : installPrefix;
}

/** `npm config get prefix`: where `npm install -g` installs. */
function readNpmConfiguredPrefix(): Effect.Effect<string | null, never> {
  return readExecutableOutput("npm", ["config", "get", "prefix"]).pipe(
    Effect.map((output) => {
      const prefix = output?.trim();
      return prefix === undefined || prefix === "" ? null : prefix;
    }),
  );
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

/**
 * `unknown`: a definition exists but could not be read or decoded. Callers
 * treat it like `this`: a broken check must never block a repair (the
 * template migrations run through one); only a definition positively read as
 * another config dir's is refused.
 */
type ServiceDefinitionOwner = "none" | "other" | "this" | "unknown";

/**
 * Whose service the installed scheduler definition runs. The launchd plist,
 * the systemd units and the Windows task are one per user, while the wrapper
 * (and launcher) live in a config dir; so with TOKENMAXXING_CONFIG_DIR
 * pointing elsewhere (a second profile, a test, or a shell without the
 * variable), the definition found can belong to another config dir, and
 * writing it for this one takes that service over. Older templates ran other
 * files from the config dir, so any path inside it counts.
 */
function serviceDefinitionOwner(
  paths: ServicePaths,
  readTaskXml: () => Effect.Effect<RegisteredWindowsTask, never> = readRegisteredWindowsTaskXml,
): Effect.Effect<ServiceDefinitionOwner, never> {
  const definition: Effect.Effect<RegisteredWindowsTask, never> =
    paths.backend === "windows-task-scheduler"
      ? readTaskXml()
      : paths.definitionPath === null
        ? Effect.succeed({ _tag: "missing" })
        : Effect.tryPromise({
            try: () => readFile(paths.definitionPath!, "utf8"),
            catch: (cause) => cause,
          }).pipe(
            Effect.map((xml): RegisteredWindowsTask => ({ _tag: "xml", xml })),
            Effect.catch((cause) =>
              Effect.succeed<RegisteredWindowsTask>(
                (cause as NodeJS.ErrnoException)?.code === "ENOENT"
                  ? { _tag: "missing" }
                  : { _tag: "unreadable" },
              ),
            ),
          );

  return definition.pipe(
    Effect.map((found): ServiceDefinitionOwner => {
      switch (found._tag) {
        case "missing":
          return "none";
        case "unreadable":
          return "unknown";
        case "xml":
          return definitionMentionsConfigDir(
            paths.backend === "windows-task-scheduler" ? unescapeXml(found.xml) : found.xml,
            paths,
          )
            ? "this"
            : "other";
      }
    }),
  );
}

/**
 * How Windows compares a path: one Unicode form (a path typed on macOS may
 * arrive NFD), ignoring case.
 */
function windowsPathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/** How the installed Windows service spells its config dir and wrapper env. */
interface InstalledWindowsSpelling {
  configDir?: string | undefined;
  env: Record<string, string>;
}

/**
 * Reads the installed task's working directory and the installed wrapper's
 * env; see `withInstalledWindowsSpelling`.
 */
function readInstalledWindowsSpelling(
  paths: ServicePaths,
): Effect.Effect<InstalledWindowsSpelling, never> {
  return Effect.gen(function* () {
    const registered = yield* readRegisteredWindowsTaskXml();
    const workingDirectory =
      registered._tag === "xml"
        ? /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/i.exec(registered.xml)?.[1]
        : undefined;
    const wrapper = yield* Effect.promise(() =>
      readFile(paths.wrapperPath, "utf8").catch(() => null),
    );

    return {
      configDir: workingDirectory === undefined ? undefined : unescapeXml(workingDirectory).trim(),
      env: wrapper === null ? {} : parseServiceWrapperEnv(wrapper),
    };
  });
}

/**
 * Windows paths compare case-insensitively, so a shell whose config dir (or
 * HOME, APPDATA, PATH...) differs from the installed service's only in case
 * owns that service. Keep the installed spelling: re-spelling it rewrote the
 * wrapper, runner pointer and service.json and re-registered the task (moving
 * its start boundary), and a repair from the original spelling flipped it
 * all back.
 */
function withInstalledWindowsSpelling(
  paths: ServicePaths,
  capturedEnv: Record<string, string>,
  installed: InstalledWindowsSpelling | null,
): { env: Record<string, string>; paths: ServicePaths } {
  if (installed === null) {
    return { env: capturedEnv, paths };
  }

  const env = Object.fromEntries(
    Object.entries(capturedEnv).map(([key, value]) => {
      const installedValue = installed.env[key];
      return [
        key,
        installedValue !== undefined && windowsPathKey(installedValue) === windowsPathKey(value)
          ? installedValue
          : value,
      ];
    }),
  );
  const configDir = installed.configDir;
  if (
    configDir === undefined ||
    configDir === paths.configDir ||
    windowsPathKey(configDir) !== windowsPathKey(paths.configDir)
  ) {
    return { env, paths };
  }

  const respell = (path: string) =>
    path.startsWith(paths.configDir) ? `${configDir}${path.slice(paths.configDir.length)}` : path;
  return {
    env,
    paths: {
      ...paths,
      configDir,
      definitionPath: paths.definitionPath === null ? null : respell(paths.definitionPath),
      lockPath: respell(paths.lockPath),
      logPath: respell(paths.logPath),
      metadataPath: respell(paths.metadataPath),
      runnerPointerPath: respell(paths.runnerPointerPath),
      runnersDir: respell(paths.runnersDir),
      statePath: respell(paths.statePath),
      updateLockPath: respell(paths.updateLockPath),
      wrapperPath: respell(paths.wrapperPath),
    },
  };
}

function definitionMentionsConfigDir(text: string, paths: ServicePaths): boolean {
  const windows = paths.backend === "windows-task-scheduler";
  const normalize = (value: string) => (windows ? windowsPathKey(value) : value.normalize("NFC"));
  const separator = windows ? "\\" : "/";
  const configDir = normalize(paths.configDir);
  const dir = configDir.endsWith(separator) ? configDir : `${configDir}${separator}`;
  const forms = [
    dir,
    escapeXml(dir),
    // systemd unit quoting (systemdQuote, and the older form without %%).
    systemdQuote(dir).slice(1, -1),
    dir.replaceAll("\\", "\\\\").replaceAll('"', '\\"'),
  ];
  const haystack = normalize(text);

  return (
    forms.some((form) => haystack.includes(form)) ||
    (windows &&
      normalize(/<WorkingDirectory>([^<]*)<\/WorkingDirectory>/i.exec(text)?.[1]?.trim() ?? "") ===
        configDir)
  );
}

/** For upgrade's refresh: true unless the definition belongs to another config dir. */
function serviceDefinitionUsesConfigDir(paths: ServicePaths): Effect.Effect<boolean, never> {
  return serviceDefinitionOwner(paths).pipe(Effect.map((owner) => owner !== "other"));
}

// Leaves a current launcher untouched so a running wscript.exe never sees it replaced.
async function writeWindowsLauncherFile(path: string): Promise<void> {
  await writeFileIfChanged(path, renderWindowsLauncher());
}

function writeWindowsLauncher(path: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => writeWindowsLauncherFile(path),
    catch: (cause) => cause,
  });
}

function readWindowsLauncherStatus(path: string): Effect.Effect<WindowsLauncherStatus, never> {
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((content): WindowsLauncherStatus =>
      content === renderWindowsLauncher() ? "current" : "outdated",
    ),
    Effect.catch(() => Effect.succeed<WindowsLauncherStatus>("missing")),
  );
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

// Returns whether it wrote. A file that already has these bytes keeps its inode and mtime; only
// a differing mode is fixed, in place.
async function writeFileIfChanged(
  path: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<boolean> {
  const current = await readFile(path).catch(() => null);
  if (current !== null && current.equals(Buffer.from(data))) {
    if (mode !== undefined && ((await stat(path)).mode & 0o777) !== mode) {
      await chmod(path, mode);
    }
    return false;
  }

  await writeFileAtomic(path, data, mode);
  return true;
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

// A batch file expands %NAME% even inside quotes; %% is a literal percent sign.
function escapeCmdSetValue(value: string): string {
  return value.replaceAll('"', '\\"').replaceAll("%", "%%");
}

// systemd expands %-specifiers everywhere in a unit file, quoted or not, so a
// literal % (a config dir like "Co 100%") must be written as %%.
function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
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
  npmPrefixOfInstall,
  npmUpdatePrefix,
  readNpmConfiguredPrefix,
  backendForPlatform,
  capturedServiceEnv,
  commandShimInvocation,
  doctorServiceEnvCheck,
  parseServiceWrapperEnv,
  serviceEnvDrift,
  deferredServiceRepairInvocation,
  durableTokenmaxxingCommandPath,
  detectAutoUpdateManager,
  findCommandOnPath,
  findTokenmaxxingCommandInstall,
  formatServiceLastError,
  formatServiceLockStatus,
  readServiceAutoUpdateCheck,
  reportServiceDoctor,
  serviceAutoUpdateCheck,
  serviceDoctorChecks,
  serviceDoctorHealth,
  isEphemeralCommandPath,
  isTransientCommandShimPath,
  isWindowsNpmPrefixShim,
  launchdJobMatches,
  windowsTaskMatches,
  withInstalledWindowsSpelling,
  decodeWindowsCommandOutput,
  readRegisteredWindowsTaskXml,
  isServiceInstalled,
  PackageManagerUpdateError,
  packageManagerFailureOutput,
  legacyServiceWrapperPaths,
  deterministicServiceJitterMs,
  readInstalledCliVersion,
  readServiceMetadata,
  readCurrentServiceRunnerInstall,
  readWindowsLauncherStatus,
  removeServiceFiles,
  resolveExecutableSiblingPackageJson,
  resolveServiceRunnerPackageJson,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdService,
  renderSystemdTimer,
  renderWindowsLauncher,
  refreshServiceAfterUpdate,
  installNativeScheduler,
  installServiceRunner,
  installServiceRunnerBinary,
  installServiceRunnerForRepair,
  installServiceRunnerFromOptionalPackage,
  installServiceRunnerFromRegistryCandidates,
  runServiceAutoUpdate,
  scheduleDeferredServiceRepair,
  scheduleDescription,
  serviceRepairCanInstallScheduler,
  acquireServiceRunLock,
  inspectServiceRunner,
  serviceLockCanBeReplaced,
  serviceRepairNeedsSchedulerInstall,
  isTransientServiceFailure,
  windowsElevatedOverFilteredToken,
  WindowsTaskAccessDeniedError,
  serviceReloadRequired,
  serviceRepairReason,
  serviceRepairReasons,
  serviceRepairState,
  serviceNewerThanCli,
  serviceLockCheck,
  doctorTemplateCheck,
  serviceStatusRunnerLines,
  serviceRunnerPackageName,
  serviceRunnerTarget,
  serviceRunnerTargetCandidates,
  serviceCompletedUsageReplacementBackfill,
  serviceNeedsUsageReplacementBackfill,
  serviceReconcileDue,
  serviceReconcileSince,
  serviceReconcileWindowDays,
  serviceScheduledSyncSince,
  serviceCommand,
  serviceInstallProgram,
  serviceLockStatus,
  serviceStateJson,
  systemdUnitsAreCurrent,
  extractServiceRunnerFromTarball,
  serviceDefinitionOwner,
  serviceDefinitionUsesConfigDir,
  servicePathsEffect,
  servicePaths,
  serviceRunFailureState,
  serviceAuthFailureError,
  serviceRunLogLine,
  writeServiceCheckIn,
  serviceRunSuccessState,
  runPackageManagerUpdate,
  verifyNpmIntegrity,
  waitForServiceRunExit,
  encodeWindowsTaskXml,
  renderWindowsTaskXml,
  windowsLauncherDoctorCheck,
  windowsLauncherPath,
  windowsScriptHostPath,
  windowsTaskNames,
  windowsTaskCreateArgs,
  writeServiceFiles,
  ServiceCommandNotFoundError,
  ServiceDoctorProblemsError,
  ServiceEnvTokenError,
  ServiceEphemeralCommandError,
  ServiceInstallError,
  ServiceElevatedError,
  ServiceNewerThanCliError,
  ServiceNotInstalledError,
  ServiceOwnedElsewhereError,
  ServiceRepairError,
  ServiceRunnerPackageMissingError,
  ServiceSourcesFailedError,
  ServiceRunnerUpdateError,
  ServiceRunError,
  ServiceUninstallError,
  ServiceUnsupportedPlatformError,
};

export type {
  DoctorCheck,
  InstalledWindowsSpelling,
  AutoUpdateManager,
  PackageManagerUpdateOptions,
  CommandInstall,
  ServiceBackend,
  ServiceCheckIn,
  ServiceDoctorFacts,
  ServiceLockStatus,
  ServiceFilesChange,
  ServiceInstallOptions,
  ServiceMetadata,
  ServiceAutoUpdateReport,
  ServicePaths,
  ServiceRepairReport,
  ServiceRunnerTarget,
  ServiceState,
};
