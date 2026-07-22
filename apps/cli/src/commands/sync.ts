import { arch, hostname } from "node:os";

import { Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type {
  AuthUser,
  RawUsageReportInput,
  SourceUsageStatsInput,
  UsageDayInput,
} from "@tokenmaxxing/api-contract";

import packageJson from "../../package.json";
import { aggregateDays, summarize, type SourceSummary } from "../ccusage/aggregate";
import {
  type CcusageReportKind,
  CcusageRunError,
  type CcusageRunErrorCode,
  dailyCcusageCommand,
  runCcusageDailyReport,
  runCcusageSessionReport,
  sessionCcusageCommand,
} from "../ccusage/runner";
import { DEFAULT_SOURCE_NAMES, resolveSources } from "../ccusage/sources";
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
  formatUrl,
  humanFrame,
  humanLog,
  humanSpinner,
  shouldUseClack,
  writeJson,
} from "../output";
import { validateCurrentLogin } from "../auth-validation";
import { browserLoginEffect } from "./login";
import { NotLoggedInError } from "./whoami";

class SyncPushError extends Data.TaggedError("SyncPushError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to push usage to tokenmaxxing\nhint: check your network and run tokenmaxxing sync again";
}

class SyncAuthValidationError extends Data.TaggedError("SyncAuthValidationError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to validate stored login\nhint: check your network and run tokenmaxxing login again";
}

class UnknownSourceError extends Data.TaggedError("UnknownSourceError")<{
  readonly names: string[];
}> {
  override get message() {
    return `error: unknown source${this.names.length > 1 ? "s" : ""}: ${this.names.join(", ")}\nhint: valid sources are ${DEFAULT_SOURCE_NAMES.join(", ")}`;
  }
}

const usd0 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const usd2 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

const integer = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const ANSI_STYLE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const syncCommand = Command.make(
  "sync",
  {
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Aggregate locally but push nothing"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("Only sync days on or after this date (YYYY-MM-DD)"),
    ),
    sources: Flag.string("sources").pipe(
      Flag.optional,
      Flag.withDescription(
        `Comma-separated agents to sync (default: ${DEFAULT_SOURCE_NAMES.join(",")})`,
      ),
    ),
  },
  ({ dryRun, json, since, sources }) =>
    syncEffect({
      dryRun,
      json,
      since: Option.getOrUndefined(since),
      sources: Option.getOrUndefined(sources),
    }),
).pipe(Command.withDescription("Aggregate local agent usage via ccusage and push it"));

interface SyncOptions {
  dryRun: boolean;
  json: boolean;
  since?: string | undefined;
  sources?: string | undefined;
}

interface SyncProgramOptions extends SyncOptions {
  auth?: SyncAuth | undefined;
  silent?: boolean | undefined;
  uploadPolicy?: UploadRetryPolicy | undefined;
}

interface SyncProgramRuntime {
  runDailyReport?: typeof runCcusageDailyReport | undefined;
  runSessionReport?: typeof runCcusageSessionReport | undefined;
}

interface ResolveSyncAuthOptions {
  json: boolean;
  showStoredLoginSpinner?: boolean | undefined;
  storedLoginSuccessMessage?: ((user: AuthUser) => string) | string | undefined;
}

type AuthenticatedCliConfig = CliConfig & { token: string };

interface SyncAuth {
  authSource: "login" | "stored";
  client: TokenmaxxingApiClient;
  config: AuthenticatedCliConfig;
  user: AuthUser;
}

type SyncSourceSummary = SourceSummary & { sessions: number | null };

interface SyncSourceIssue {
  code: CcusageRunErrorCode;
  message: string;
  report: CcusageReportKind;
}

type SyncSourceResult =
  | { source: string; status: "failed"; summary: null; issue: SyncSourceIssue }
  | { source: string; status: "partial"; summary: SyncSourceSummary; issue: SyncSourceIssue }
  | { source: string; status: "skipped"; summary: null; reason: "no_data" }
  | { source: string; status: "synced"; summary: SyncSourceSummary };

type SyncStatus = "error" | "ok" | "partial";

interface SyncResult {
  dryRun: boolean;
  profileUrl?: string | undefined;
  rows: number;
  sourceResults: SyncSourceResult[];
  sources: Record<string, SyncSourceSummary | null>;
  status: SyncStatus;
  upserted?: number | undefined;
}

interface FormatOptions {
  env?: Record<string, string | undefined>;
}

type TableAlignment = "left" | "right";
type Style = (value: string) => string;

interface TableCell {
  align?: TableAlignment;
  style?: Style;
  value: string;
}

interface UploadUsageReportsOptions {
  auth: SyncAuth;
  device: {
    arch?: string | undefined;
    name: string;
    platform: NodeJS.Platform;
    version?: string | undefined;
  };
  options: Pick<SyncProgramOptions, "json" | "silent">;
  rawReports: RawUsageReportInput[];
  uploadPolicy?: UploadRetryPolicy | undefined;
}

interface UploadRetryPolicy {
  attempts: number;
  backoffMs: readonly number[];
  jitterRatio: number;
  random?: (() => number) | undefined;
  timeoutMs: number;
}

function syncEffect(options: SyncOptions) {
  return humanFrame(
    "Sync",
    options,
    Effect.gen(function* () {
      const console = yield* Effect.service(ConsoleService);
      const result = yield* syncProgram(options);

      if (options.json) {
        yield* writeJson(syncJsonPayload(result));
        return;
      }

      if (shouldRenderInlineSync(options)) {
        if (result.status === "error") {
          yield* humanLog("error", "No usage synced; source collection failed", options);
        } else if (result.rows === 0) {
          yield* humanLog("info", "Nothing to sync", options);
        } else if (result.dryRun) {
          yield* humanLog("success", "Dry run complete; nothing pushed", options);
        } else if (result.profileUrl !== undefined) {
          yield* humanLog("info", `Profile: ${formatUrl(result.profileUrl)}`, options);
        }
      } else {
        yield* Effect.sync(() => {
          console.log("");
          console.log(renderSyncTable(result.sourceResults));
          console.log("");
          if (result.status === "error") {
            console.error("No usage synced; source collection failed");
          } else if (result.rows === 0) {
            console.log("Nothing to sync");
          } else if (result.dryRun) {
            console.log("Dry run complete; nothing pushed");
          } else if (result.profileUrl !== undefined) {
            console.log(renderSyncSuccess(result.profileUrl));
          }
        });
      }

      if (!result.dryRun && result.rows > 0 && result.profileUrl !== undefined) {
        yield* openProfileIfAvailable(result.profileUrl, options);
      }
    }),
  );
}

function syncProgram(options: SyncProgramOptions, runtime: SyncProgramRuntime = {}) {
  return Effect.gen(function* () {
    const runDailyReport = runtime.runDailyReport ?? runCcusageDailyReport;
    const runSessionReport = runtime.runSessionReport ?? runCcusageSessionReport;
    const requested = options.sources?.split(",") ?? DEFAULT_SOURCE_NAMES;
    const { invalid, sources } = resolveSources(requested);
    if (invalid.length > 0) {
      return yield* Effect.fail(new UnknownSourceError({ names: invalid }));
    }

    const auth = options.dryRun
      ? undefined
      : (options.auth ?? (yield* resolveSyncAuth({ json: options.json })));

    const rows: UsageDayInput[] = [];
    const rawReports: RawUsageReportInput[] = [];
    const sourceSummaries: Record<string, SyncSourceSummary | null> = {};
    const sourceResults: SyncSourceResult[] = [];
    const renderInlineResults = shouldRenderInlineSync(options);
    for (const source of sources) {
      const spinner = yield* humanSpinner(`Syncing ${source.source}`, options);
      const dailyResult = yield* runDailyReport(source, { since: options.since }).pipe(
        Effect.match({
          onFailure: (error) => ({ error, _tag: "failure" as const }),
          onSuccess: (report) => ({ report, _tag: "success" as const }),
        }),
      );

      if (dailyResult._tag === "failure") {
        const result = {
          issue: syncSourceIssue(dailyResult.error),
          source: source.source,
          status: "failed" as const,
          summary: null,
        };
        sourceSummaries[source.source] = null;
        sourceResults.push(result);
        spinner.error(
          renderInlineResults ? renderSyncSourceResult(result) : `Failed syncing ${source.source}`,
        );
        continue;
      }

      const dailyReport = dailyResult.report;
      if (dailyReport.daily.length === 0) {
        const result = {
          reason: "no_data" as const,
          source: source.source,
          status: "skipped" as const,
          summary: null,
        };
        sourceSummaries[source.source] = result.summary;
        sourceResults.push(result);
        spinner.stop(renderInlineResults ? renderSyncSourceResult(result) : undefined);
        continue;
      }

      const sourceRows = aggregateDays(source.source, dailyReport.daily);
      rawReports.push({
        command: dailyCcusageCommand(source, { since: options.since }),
        payload: dailyReport,
        reportKind: "daily",
        source: source.source,
      });

      const sessionResult = yield* runSessionReport(source, { since: options.since }).pipe(
        Effect.match({
          onFailure: (error) => ({ error, _tag: "failure" as const }),
          onSuccess: (report) => ({ report, _tag: "success" as const }),
        }),
      );
      const sessionCount =
        sessionResult._tag === "success" ? sessionResult.report.sessions.length : null;
      if (options.since === undefined && sessionResult._tag === "success") {
        rawReports.push({
          command: sessionCcusageCommand(source),
          payload: sessionResult.report,
          reportKind: "session",
          source: source.source,
        });
      }
      const summary = { ...summarize(sourceRows), sessions: sessionCount };
      const result: SyncSourceResult =
        sessionResult._tag === "failure"
          ? {
              issue: syncSourceIssue(sessionResult.error),
              source: source.source,
              status: "partial",
              summary,
            }
          : { source: source.source, status: "synced", summary };
      sourceSummaries[source.source] = summary;
      sourceResults.push(result);
      rows.push(...sourceRows);
      if (result.status === "partial") {
        spinner.error(
          renderInlineResults
            ? renderSyncSourceResult(result)
            : `Partially synced ${source.source}`,
        );
      } else {
        spinner.stop(renderInlineResults ? renderSyncSourceResult(result) : undefined);
      }
    }

    const status = syncStatusForSources(sourceResults, rows.length);

    if (options.dryRun || rows.length === 0) {
      return {
        dryRun: options.dryRun,
        rows: rows.length,
        sourceResults,
        sources: sourceSummaries,
        status,
      };
    }

    const device = {
      arch: arch(),
      name: hostname(),
      platform: process.platform,
      version: packageJson.version,
    };
    let upserted = 0;
    if (auth === undefined) {
      return {
        dryRun: false,
        rows: rows.length,
        sourceResults,
        sources: sourceSummaries,
        status,
      };
    }

    const response = yield* uploadUsageReports({
      auth,
      device,
      options,
      rawReports,
      uploadPolicy: options.uploadPolicy,
    });
    upserted = response.upserted;

    return {
      dryRun: false,
      profileUrl: `${auth.config.wwwUrl}/${auth.user.login}`,
      rows: rows.length,
      sourceResults,
      sources: sourceSummaries,
      status,
      upserted,
    };
  });
}

function uploadUsageReports({
  auth,
  device,
  options,
  rawReports,
  uploadPolicy,
}: UploadUsageReportsOptions) {
  return Effect.gen(function* () {
    const spinner = yield* humanSpinner("Uploading usage", options);
    const upload = uploadUsageReportsOnce({ auth, device, rawReports }, uploadPolicy);

    return yield* upload.pipe(
      Effect.tap(() => Effect.sync(() => spinner.stop("Usage uploaded"))),
      Effect.tapError(() => Effect.sync(() => spinner.error("Failed uploading usage"))),
      Effect.mapError((cause) => new SyncPushError({ cause })),
    );
  });
}

function uploadUsageReportsOnce(
  input: Pick<UploadUsageReportsOptions, "auth" | "device" | "rawReports">,
  uploadPolicy: UploadRetryPolicy | undefined,
) {
  const upload = () =>
    input.auth.client.usage.ingest({
      payload: {
        device: input.device,
        reports: input.rawReports,
      },
    });

  if (uploadPolicy === undefined) {
    return upload();
  }

  return uploadWithRetry(upload, uploadPolicy);
}

function uploadWithRetry<A, E, R>(
  upload: () => Effect.Effect<A, E, R>,
  policy: UploadRetryPolicy,
): Effect.Effect<A, unknown, R | ClockService> {
  return Effect.gen(function* () {
    const clock = yield* Effect.service(ClockService);
    const attempts = Math.max(1, Math.floor(policy.attempts));
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = yield* upload().pipe(
        Effect.timeout(`${Math.max(1, policy.timeoutMs)} millis`),
        Effect.match({
          onFailure: (cause) => ({ cause, _tag: "failure" as const }),
          onSuccess: (value) => ({ value, _tag: "success" as const }),
        }),
      );

      if (result._tag === "success") {
        return result.value;
      }

      lastError = result.cause;
      if (attempt < attempts) {
        const backoffMs = retryBackoffMs(policy, attempt);
        if (backoffMs > 0) {
          yield* clock.sleep(backoffMs).pipe(Effect.catch(() => Effect.void));
        }
      }
    }

    return yield* Effect.fail(lastError);
  });
}

function retryBackoffMs(policy: UploadRetryPolicy, attempt: number): number {
  const base = policy.backoffMs[Math.max(0, attempt - 1)] ?? policy.backoffMs.at(-1) ?? 0;
  const jitterRatio = Math.max(0, policy.jitterRatio);
  const random = policy.random ?? Math.random;
  const jitter = jitterRatio === 0 ? 1 : 1 - jitterRatio + random() * jitterRatio * 2;

  return Math.max(0, Math.round(base * jitter));
}

function syncJsonPayload(result: SyncResult) {
  if (result.dryRun || result.rows === 0) {
    return {
      dryRun: result.dryRun,
      rows: result.rows,
      sourceResults: result.sourceResults,
      sources: result.sources,
      status: result.status,
    };
  }

  return {
    rows: result.rows,
    sourceResults: result.sourceResults,
    sources: result.sources,
    status: result.status,
    upserted: result.upserted ?? 0,
  };
}

function sourceStatsForSync(
  results: readonly SyncSourceResult[],
): SourceUsageStatsInput[] | undefined {
  const stats = results.flatMap((result) =>
    result.summary?.sessions === undefined || result.summary.sessions === null
      ? []
      : [{ sessionCount: result.summary.sessions, source: result.source }],
  );

  return stats.length === 0 ? undefined : stats;
}

function syncSourceIssue(error: CcusageRunError): SyncSourceIssue {
  const message =
    error.code === "command_not_found"
      ? "ccusage command not found"
      : error.code === "command_timed_out"
        ? "ccusage command timed out"
        : error.code === "command_failed"
          ? "ccusage command failed"
          : error.code === "invalid_json"
            ? "ccusage returned invalid JSON"
            : `ccusage returned an invalid ${error.report} report`;

  return { code: error.code, message, report: error.report };
}

function syncStatusForSources(results: readonly SyncSourceResult[], rows: number): SyncStatus {
  const hasIssues = results.some(
    (result) => result.status === "failed" || result.status === "partial",
  );
  if (!hasIssues) {
    return "ok";
  }

  return rows > 0 ? "partial" : "error";
}

function openProfileIfAvailable(
  profileUrl: string,
  options: Partial<Pick<SyncProgramOptions, "json" | "silent">> = {},
) {
  return Effect.gen(function* () {
    const browser = yield* Effect.service(BrowserService);
    const terminal = yield* Effect.service(TerminalService);

    if (!(yield* terminal.canOpenExternalBrowser)) {
      return;
    }

    const spinner = yield* humanSpinner("Opening profile", options);
    const opened = yield* browser.open(profileUrl).pipe(
      Effect.tap(() => Effect.sync(() => spinner.stop(`Opened ${formatUrl(profileUrl)}`))),
      Effect.tapError(() => Effect.sync(() => spinner.error("Could not open profile"))),
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );

    if (!opened) {
      yield* humanLog("info", `Open ${formatUrl(profileUrl)} in your browser`, options);
    }
  });
}

function shouldRenderInlineSync(options: { json?: boolean; silent?: boolean }): boolean {
  return options.json !== true && options.silent !== true && shouldUseClack();
}

function renderSyncSourceResult(result: SyncSourceResult): string {
  if (result.status === "failed") {
    return `${result.source} failed - ${result.issue.message}`;
  }

  if (result.status === "skipped") {
    return `${result.source} skipped (no data)`;
  }

  const sessions =
    result.summary.sessions === null
      ? "sessions unknown"
      : formatCount(result.summary.sessions, "session");

  const row = [
    `${result.source} ${result.status === "partial" ? "partially synced" : "synced"}`,
    formatCount(result.summary.days, "day"),
    sessions,
    formatCount(result.summary.models, "model"),
    formatSyncUsd(result.summary.spendUsd),
  ];
  if (result.status === "partial") {
    row.push(`sessions unavailable: ${result.issue.message}`);
  }

  return row.join(" - ");
}

function renderSyncTable(
  results: readonly SyncSourceResult[],
  options: FormatOptions = {},
): string {
  const styles = makeStyles(options);
  const header: readonly TableCell[] = [
    { value: "Agent" },
    { value: "Status" },
    { align: "right", value: "Days" },
    { align: "right", value: "Sessions" },
    { align: "right", value: "Models" },
    { align: "right", value: "Spend" },
  ];
  const rows = results.map((result): readonly TableCell[] => {
    if (result.status === "failed" || result.status === "skipped") {
      return [
        { value: result.source },
        {
          style: result.status === "failed" ? styles.failed : styles.skipped,
          value: result.status,
        },
        { align: "right", style: styles.muted, value: "-" },
        { align: "right", style: styles.muted, value: "-" },
        { align: "right", style: styles.muted, value: "-" },
        { align: "right", style: styles.muted, value: "-" },
      ];
    }

    return [
      { value: result.source },
      {
        style: result.status === "partial" ? styles.partial : styles.synced,
        value: result.status,
      },
      { align: "right", value: formatInteger(result.summary.days) },
      {
        align: "right",
        style: result.summary.sessions === null ? styles.muted : undefined,
        value: result.summary.sessions === null ? "-" : formatInteger(result.summary.sessions),
      },
      { align: "right", value: formatInteger(result.summary.models) },
      { align: "right", value: formatSyncUsd(result.summary.spendUsd) },
    ];
  });

  return renderTable(header, rows, styles);
}

function renderSyncSuccess(profileUrl: string, options: FormatOptions = {}): string {
  const styles = makeStyles(options);

  return `${styles.synced("Sync complete")}\nProfile: ${formatUrl(profileUrl, options)}`;
}

function renderTable(
  header: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  styles: ReturnType<typeof makeStyles>,
): string {
  const widths = header.map((cell, index) =>
    Math.max(
      visibleLength(cell.value),
      ...rows.map((row) => visibleLength(row[index]?.value ?? "")),
    ),
  );
  const renderRow = (row: readonly TableCell[], isHeader = false) =>
    row
      .map((cell, index) => {
        const padded = padCell(cell.value, widths[index] ?? 0, cell.align ?? "left");
        const style = isHeader ? styles.muted : cell.style;
        return style === undefined ? padded : style(padded);
      })
      .join("  ");

  return [renderRow(header, true), ...rows.map((row) => renderRow(row))].join("\n");
}

function padCell(value: string, width: number, align: TableAlignment): string {
  const padding = " ".repeat(Math.max(width - visibleLength(value), 0));
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function visibleLength(value: string): number {
  return value.replaceAll(ANSI_STYLE_SEQUENCE, "").length;
}

function makeStyles(options: FormatOptions = {}): {
  failed: Style;
  muted: Style;
  partial: Style;
  skipped: Style;
  synced: Style;
} {
  const env = options.env ?? process.env;
  const colors = !Object.prototype.hasOwnProperty.call(env, "NO_COLOR");

  return {
    failed: (value) => (colors ? `\x1b[31m${value}\x1b[0m` : value),
    muted: (value) => (colors ? `\x1b[2m${value}\x1b[0m` : value),
    partial: (value) => (colors ? `\x1b[33m${value}\x1b[0m` : value),
    skipped: (value) => (colors ? `\x1b[33m${value}\x1b[0m` : value),
    synced: (value) => (colors ? `\x1b[32m${value}\x1b[0m` : value),
  };
}

function resolveSyncAuth(options: ResolveSyncAuthOptions) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const clients = yield* Effect.service(ApiClientService);

    const stored = yield* config.readConfig();
    const envTokenActive = yield* config.hasEnvToken();
    if (stored.token === undefined) {
      if (options.json) {
        return yield* Effect.fail(new NotLoggedInError());
      }

      yield* humanLog("info", "Not logged in; starting browser login", options);
      return yield* loginForSync();
    }

    const authenticatedConfig: AuthenticatedCliConfig = { ...stored, token: stored.token };
    const client = yield* clients.make({
      baseUrl: authenticatedConfig.apiUrl,
      token: authenticatedConfig.token,
    });
    const validated = yield* validateCurrentLogin(client, {
      ...options,
      showSpinner: options.showStoredLoginSpinner === true,
      successMessage: options.storedLoginSuccessMessage,
    });

    if (validated._tag === "valid") {
      return {
        authSource: "stored" as const,
        client,
        config: authenticatedConfig,
        user: validated.user,
      };
    }

    if (validated._tag === "failed") {
      return yield* Effect.fail(new SyncAuthValidationError({ cause: validated.cause }));
    }

    if (options.json || envTokenActive) {
      return yield* Effect.fail(new NotLoggedInError());
    }

    yield* config.clearToken();
    yield* humanLog("info", "Stored token is no longer valid; starting browser login", options);
    return yield* loginForSync();
  });
}

function loginForSync() {
  return Effect.gen(function* () {
    const clients = yield* Effect.service(ApiClientService);

    const login = yield* browserLoginEffect({ json: false });
    const token = login.config.token;
    const client = yield* clients.make({ baseUrl: login.config.apiUrl, token });

    return {
      authSource: "login" as const,
      client,
      config: { ...login.config, token },
      user: login.user,
    };
  });
}

function formatSyncUsd(value: number): string {
  return value >= 100 ? usd0.format(value) : usd2.format(value);
}

function formatInteger(value: number): string {
  return integer.format(value);
}

function formatCount(value: number, noun: string): string {
  return `${formatInteger(value)} ${noun}${value === 1 ? "" : "s"}`;
}

export {
  formatSyncUsd,
  openProfileIfAvailable,
  renderSyncSuccess,
  renderSyncSourceResult,
  renderSyncTable,
  resolveSyncAuth,
  sourceStatsForSync,
  syncSourceIssue,
  syncStatusForSources,
  syncCommand,
  syncEffect,
  syncJsonPayload,
  syncProgram,
  SyncAuthValidationError,
  SyncPushError,
  UnknownSourceError,
  uploadUsageReports,
};

export type {
  ResolveSyncAuthOptions,
  SyncAuth,
  SyncOptions,
  SyncResult,
  SyncProgramRuntime,
  SyncSourceIssue,
  SyncSourceResult,
  SyncSourceSummary,
  SyncStatus,
  UploadRetryPolicy,
};
