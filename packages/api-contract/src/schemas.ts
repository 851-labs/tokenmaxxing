import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";

import { UsageDateKey } from "./date-key";

/**
 * Wire schemas. Conventions:
 *
 * - Money on responses is `spendUsd`; token counts are `*Tokens`; day counts
 *   are `activeDays`; date bounds are `firstDate`/`lastDate`. The exception is
 *   `UsageDayInput.costUsd`, which released CLIs already send.
 * - Ids are branded strings. The brand is type-only (the wire stays a plain
 *   string) and exists so swapped arguments fail to compile.
 * - `PublicUser` is what anonymous pages see; `AuthUser` (with the internal
 *   id) is reserved for the caller's own identity and the admin surface.
 * - Every schema exports a same-named type alias.
 */

const UserId = Schema.String.pipe(Schema.brand("UserId"));

type UserId = typeof UserId.Type;

const DeviceId = Schema.String.pipe(Schema.brand("DeviceId"));

type DeviceId = typeof DeviceId.Type;

/**
 * Every released CLI mints its device id with `crypto.randomUUID()`, so new
 * devices must present a UUID. Responses keep the plain {@link DeviceId}.
 */
const NewDeviceId = DeviceId.check(
  Schema.isPattern(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
);

type NewDeviceId = typeof NewDeviceId.Type;

const TokenId = Schema.String.pipe(Schema.brand("TokenId"));

type TokenId = typeof TokenId.Type;

const boundedString = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));

const boundedArray = <S extends Schema.Top>(item: S, maxLength: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maxLength));

/**
 * Free text the server stores but never needs whole (error messages): longer
 * values are cut on decode instead of failing the request, so a released CLI
 * reporting a long error still checks in. Encoding is unconstrained.
 */
const truncatedString = (maxLength: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (value) => truncate(value, maxLength),
        encode: (value) => value,
      }),
    ),
  );

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  // Never leave a lone high surrogate at the cut.
  const code = value.charCodeAt(maxLength - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength);
}

/** Device identity strings, shared by login and usage payloads. */
const MAX_DEVICE_NAME_LENGTH = 256;
const MAX_DEVICE_FIELD_LENGTH = 64;
/** Login codes are short; anything longer cannot match a stored one. */
const MAX_LOGIN_CODE_LENGTH = 128;

const HealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  product: Schema.String,
  service: Schema.String,
});

type HealthResponse = typeof HealthResponse.Type;

const PublicUser = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
});

type PublicUser = typeof PublicUser.Type;

/** PublicUser plus the internal id, in the field order released CLIs pinned. */
const AuthUser = Schema.Struct({
  avatarUrl: PublicUser.fields.avatarUrl,
  id: UserId,
  login: PublicUser.fields.login,
  name: PublicUser.fields.name,
});

type AuthUser = typeof AuthUser.Type;

const MeResponse = Schema.Struct({
  user: AuthUser,
});

type MeResponse = typeof MeResponse.Type;

const ProfileIdentityResponse = PublicUser.mapFields(Struct.pick(["avatarUrl", "login"]));

type ProfileIdentityResponse = typeof ProfileIdentityResponse.Type;

const OAuthProviderId = Schema.Literals(["github", "google"]);

type OAuthProviderId = typeof OAuthProviderId.Type;

const UserAccountSummary = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  emailVerified: Schema.Boolean,
  login: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  provider: OAuthProviderId,
  providerAccountId: Schema.String,
});

type UserAccountSummary = typeof UserAccountSummary.Type;

const ListAccountsResponse = Schema.Struct({
  accounts: Schema.Array(UserAccountSummary),
});

type ListAccountsResponse = typeof ListAccountsResponse.Type;

/** Identity resolved from a `tmx_` bearer token (CLI clients). */
const CliIdentity = Schema.Struct({
  deviceId: Schema.NullOr(DeviceId),
  tokenId: TokenId,
  user: AuthUser,
});

type CliIdentity = typeof CliIdentity.Type;

const DeviceSummary = Schema.Struct({
  arch: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  id: DeviceId,
  lastSyncAt: Schema.NullOr(Schema.String),
  name: Schema.String,
  platform: Schema.String,
  version: Schema.NullOr(Schema.String),
});

type DeviceSummary = typeof DeviceSummary.Type;

const ListDevicesResponse = Schema.Struct({
  devices: Schema.Array(DeviceSummary),
});

type ListDevicesResponse = typeof ListDevicesResponse.Type;

const CliTokenSummary = Schema.Struct({
  createdAt: Schema.String,
  deviceId: Schema.NullOr(DeviceId),
  id: TokenId,
  lastUsedAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});

type CliTokenSummary = typeof CliTokenSummary.Type;

const ListTokensResponse = Schema.Struct({
  tokens: Schema.Array(CliTokenSummary),
});

type ListTokensResponse = typeof ListTokensResponse.Type;

/**
 * Device-code CLI login (RFC 8628 shaped). Current CLIs send
 * `flow: "device_code"` and poll with the secret `deviceCode`; the short
 * `userCode` only ever travels to the browser for approval. Requests started
 * without `flow` are legacy (pre-device-code CLIs): they get no deviceCode
 * and may poll by `code` until the legacy sunset.
 */
const CliLoginFlow = Schema.Literal("device_code");

type CliLoginFlow = typeof CliLoginFlow.Type;

/**
 * Flat `device*` fields rather than a nested device struct: released CLIs send
 * exactly this shape, so it stays frozen. `deviceId` is minted by the CLI and
 * becomes the device row id.
 */
const CliLoginStartInput = Schema.Struct({
  deviceArch: Schema.optional(boundedString(MAX_DEVICE_FIELD_LENGTH)),
  deviceId: NewDeviceId,
  deviceName: boundedString(MAX_DEVICE_NAME_LENGTH),
  devicePlatform: boundedString(MAX_DEVICE_FIELD_LENGTH),
  deviceVersion: Schema.optional(boundedString(MAX_DEVICE_FIELD_LENGTH)),
  flow: Schema.optional(CliLoginFlow),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type CliLoginStartInput = typeof CliLoginStartInput.Type;

const CliLoginStartResponse = Schema.Struct({
  /** Legacy alias of `userCode`, kept for pre-device-code CLIs. */
  code: Schema.String,
  /** Present only for `flow: "device_code"` starts; never shown to users. */
  deviceCode: Schema.optional(Schema.String),
  expiresAt: Schema.String,
  intervalSeconds: Schema.Number,
  userCode: Schema.String,
  verificationUri: Schema.String,
});

type CliLoginStartResponse = typeof CliLoginStartResponse.Type;

const CliLoginDeviceCodePollInput = Schema.Struct({
  deviceCode: boundedString(MAX_LOGIN_CODE_LENGTH),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type CliLoginDeviceCodePollInput = typeof CliLoginDeviceCodePollInput.Type;

/** Pre-device-code CLIs poll with the user code; see the legacy sunset. */
const CliLoginLegacyPollInput = Schema.Struct({
  code: boundedString(MAX_LOGIN_CODE_LENGTH),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type CliLoginLegacyPollInput = typeof CliLoginLegacyPollInput.Type;

const CliLoginPollInput = Schema.Union([CliLoginDeviceCodePollInput, CliLoginLegacyPollInput]);

type CliLoginPollInput = typeof CliLoginPollInput.Type;

const CliLoginPollResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("complete"),
    token: Schema.String,
    user: AuthUser,
  }),
]);

type CliLoginPollResponse = typeof CliLoginPollResponse.Type;

/** What the approval page shows so the user knows which device they admit. */
const CliLoginRequestSummary = Schema.Struct({
  code: Schema.String,
  createdAt: Schema.String,
  deviceArch: Schema.NullOr(Schema.String),
  deviceName: Schema.String,
  devicePlatform: Schema.String,
  deviceVersion: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
  legacyClient: Schema.Boolean,
  status: Schema.Literals(["pending", "approved"]),
});

type CliLoginRequestSummary = typeof CliLoginRequestSummary.Type;

const CliLoginApproveInput = Schema.Struct({
  code: boundedString(MAX_LOGIN_CODE_LENGTH),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type CliLoginApproveInput = typeof CliLoginApproveInput.Type;

const CliLoginApproveResponse = Schema.Struct({
  deviceName: Schema.String,
  ok: Schema.Boolean,
});

type CliLoginApproveResponse = typeof CliLoginApproveResponse.Type;

/**
 * Agents the CLI can sync, in CLI display order. Input schemas only accept
 * these; response schemas keep `source` as a plain string so older decoders
 * keep working when a source is added.
 */
const USAGE_SOURCES = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "copilot",
  "hermes",
  "pi",
  "grok",
  "antigravity",
  "zcode",
  "amp",
  "qwen",
  "kimi",
  "kilo",
  "goose",
  "droid",
  "codebuff",
  "openclaw",
] as const;

const UsageSource = Schema.Literals(USAGE_SOURCES);

type UsageSource = typeof UsageSource.Type;

/** Token counts are non-negative safe integers (ccusage never emits fractions). */
const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

type TokenCount = typeof TokenCount.Type;

/** USD amounts are finite and non-negative; rejects JSON "NaN"/"Infinity" too. */
const UsdAmount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

type UsdAmount = typeof UsdAmount.Type;

const MAX_MODEL_NAME_LENGTH = 256;
/** Legacy `/usage/sync` clients upload in chunks of 1000 rows. */
const MAX_SYNC_DAYS = 1_000;
/** ~27 years of daily entries; anything larger is not a real ccusage report. */
const MAX_REPORT_DAYS = 10_000;
/** One daily plus one legacy session report per source, with headroom. */
const MAX_RAW_REPORTS = 64;
const MAX_SOURCE_STATS = 64;
const MAX_COMMAND_ARGS = 32;
const MAX_COMMAND_ARG_LENGTH = 256;

const UsageDeviceInput = Schema.Struct({
  arch: Schema.optional(boundedString(MAX_DEVICE_FIELD_LENGTH)),
  name: boundedString(MAX_DEVICE_NAME_LENGTH),
  platform: boundedString(MAX_DEVICE_FIELD_LENGTH),
  version: Schema.optional(boundedString(MAX_DEVICE_FIELD_LENGTH)),
});

type UsageDeviceInput = typeof UsageDeviceInput.Type;

/**
 * One day of usage for one (source, model) pair, as aggregated by the CLI
 * from ccusage output. `date` is an opaque YYYY-MM-DD local-time bucket.
 * `costUsd` predates the `spendUsd` convention and is frozen by released CLIs.
 */
const UsageDayInput = Schema.Struct({
  cacheCreationTokens: TokenCount,
  cacheReadTokens: TokenCount,
  costUsd: UsdAmount,
  date: UsageDateKey,
  inputTokens: TokenCount,
  model: boundedString(MAX_MODEL_NAME_LENGTH),
  outputTokens: TokenCount,
  source: UsageSource,
  totalTokens: TokenCount,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type UsageDayInput = typeof UsageDayInput.Type;

const SourceUsageStatsInput = Schema.Struct({
  sessionCount: TokenCount,
  source: UsageSource,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type SourceUsageStatsInput = typeof SourceUsageStatsInput.Type;

// `session` remains accepted for old CLIs; ingestion counts those entries in
// memory and never persists their payloads.
const UsageRawReportKind = Schema.Literals(["daily", "session"]);

type UsageRawReportKind = typeof UsageRawReportKind.Type;

/**
 * `payload` is raw ccusage JSON in one of several per-source dialects; the
 * API decodes it leniently (and day by day) after the envelope is accepted.
 * Only the size of a `daily` array is checked up front, so an oversized
 * report is rejected like every other capped field instead of being dropped.
 */
const RawUsageReportPayload = Schema.Unknown.check(
  Schema.makeFilter(
    (payload: unknown) =>
      !isDailyPayloadOverCap(payload) || `expected at most ${MAX_REPORT_DAYS} daily entries`,
  ),
);

function isDailyPayloadOverCap(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("daily" in payload)) {
    return false;
  }

  return Array.isArray(payload.daily) && payload.daily.length > MAX_REPORT_DAYS;
}

const RawUsageReportInput = Schema.Struct({
  command: boundedArray(boundedString(MAX_COMMAND_ARG_LENGTH), MAX_COMMAND_ARGS),
  payload: RawUsageReportPayload,
  reportKind: UsageRawReportKind,
  source: UsageSource,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type RawUsageReportInput = typeof RawUsageReportInput.Type;

const ServiceCheckInStatus = Schema.Literals(["started", "success", "failure"]);

type ServiceCheckInStatus = typeof ServiceCheckInStatus.Type;

const ServiceAutoUpdateManager = Schema.Literals(["bun", "npm", "pnpm", "registry", "yarn"]);

type ServiceAutoUpdateManager = typeof ServiceAutoUpdateManager.Type;

const ServiceAutoUpdateStatus = Schema.Literals(["failure", "not-needed", "skipped", "success"]);

type ServiceAutoUpdateStatus = typeof ServiceAutoUpdateStatus.Type;

const ServiceAutoUpdateReason = Schema.Literals([
  "disabled",
  "download-failed",
  "integrity-mismatch",
  "install-failed",
  "latest-unknown",
  "manager-missing",
  "manager-not-found",
  "metadata-missing",
  "package-manager-failed",
  "platform-package-missing",
  "version-unchanged",
]);

type ServiceAutoUpdateReason = typeof ServiceAutoUpdateReason.Type;

/**
 * Service telemetry bounds. Identifiers, versions and timestamps are short in
 * every released CLI, so oversized values are rejected; error messages come
 * from `String(cause)` and are truncated instead (see {@link truncatedString}).
 */
const MAX_TELEMETRY_FIELD_LENGTH = 256;
const MAX_TELEMETRY_ERROR_LENGTH = 4_096;

const TelemetryField = boundedString(MAX_TELEMETRY_FIELD_LENGTH);

const TelemetryError = truncatedString(MAX_TELEMETRY_ERROR_LENGTH);

const ServiceAutoUpdate = Schema.Struct({
  attemptedAt: Schema.optional(Schema.NullOr(TelemetryField)),
  completedAt: Schema.optional(Schema.NullOr(TelemetryField)),
  currentVersion: Schema.optional(Schema.NullOr(TelemetryField)),
  enabled: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(TelemetryError)),
  installedVersion: Schema.optional(Schema.NullOr(TelemetryField)),
  latestVersion: Schema.optional(Schema.NullOr(TelemetryField)),
  manager: Schema.NullOr(ServiceAutoUpdateManager),
  reason: Schema.NullOr(ServiceAutoUpdateReason),
  status: ServiceAutoUpdateStatus,
});

type ServiceAutoUpdate = typeof ServiceAutoUpdate.Type;

const ServiceRepairReason = Schema.Literals([
  "auto-updated",
  "reload-required",
  "scheduler-inactive",
  "service-failure",
]);

type ServiceRepairReason = typeof ServiceRepairReason.Type;

const ServiceRepairStatus = Schema.Literals(["failure", "scheduled", "success"]);

type ServiceRepairStatus = typeof ServiceRepairStatus.Type;

const ServiceCheckInInput = Schema.Struct({
  autoUpdate: Schema.optional(ServiceAutoUpdate),
  backend: Schema.optional(TelemetryField),
  error: Schema.optional(TelemetryError),
  reloadRequired: Schema.optional(Schema.Boolean),
  repairAttemptedAt: Schema.optional(TelemetryField),
  repairCompletedAt: Schema.optional(TelemetryField),
  repairError: Schema.optional(TelemetryError),
  repairReason: Schema.optional(ServiceRepairReason),
  repairStatus: Schema.optional(ServiceRepairStatus),
  runnerTarget: Schema.optional(TelemetryField),
  runnerVersion: Schema.optional(TelemetryField),
  schedulerActive: Schema.optional(Schema.Boolean),
  status: ServiceCheckInStatus,
  templateVersion: Schema.optional(Schema.Number),
});

type ServiceCheckInInput = typeof ServiceCheckInInput.Type;

const UsageCheckInInput = Schema.Struct({
  device: UsageDeviceInput,
  service: ServiceCheckInInput,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type UsageCheckInInput = typeof UsageCheckInInput.Type;

const UsageCheckInResponse = Schema.Struct({
  checkedInAt: Schema.String,
});

type UsageCheckInResponse = typeof UsageCheckInResponse.Type;

const IngestUsageInput = Schema.Struct({
  device: UsageDeviceInput,
  reports: boundedArray(RawUsageReportInput, MAX_RAW_REPORTS),
  sourceStats: Schema.optional(boundedArray(SourceUsageStatsInput, MAX_SOURCE_STATS)),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type IngestUsageInput = typeof IngestUsageInput.Type;

/**
 * Legacy `/usage/sync` rows are decoded one by one on the server (as
 * {@link UsageDayInput}) and invalid rows are dropped: 0.2.x CLIs resend their
 * whole history on every sync, so rejecting the upload for one bad row would
 * block that device forever. The envelope itself stays strict.
 */
const SyncUsageDayInput = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: "A UsageDayInput row; rows that fail to decode are dropped individually.",
});

type SyncUsageDayInput = typeof SyncUsageDayInput.Type;

const SyncUsageInput = Schema.Struct({
  days: boundedArray(SyncUsageDayInput, MAX_SYNC_DAYS),
  device: UsageDeviceInput,
  sourceStats: Schema.optional(boundedArray(SourceUsageStatsInput, MAX_SOURCE_STATS)),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type SyncUsageInput = typeof SyncUsageInput.Type;

const SyncUsageResponse = Schema.Struct({
  received: Schema.Number,
  syncedAt: Schema.String,
  upserted: Schema.Number,
});

type SyncUsageResponse = typeof SyncUsageResponse.Type;

const LeaderboardMetric = Schema.Literals(["spend", "tokens"]);

type LeaderboardMetric = typeof LeaderboardMetric.Type;

const LeaderboardWindow = Schema.Literals(["all", "30d", "7d"]);

type LeaderboardWindow = typeof LeaderboardWindow.Type;

const DEFAULT_LEADERBOARD_METRIC = "spend" as const satisfies LeaderboardMetric;
const DEFAULT_LEADERBOARD_WINDOW = "30d" as const satisfies LeaderboardWindow;

/** One public user's usage over some window; the leaderboard adds `rank`. */
const UserUsageMetric = Schema.Struct({
  activeDays: Schema.Number,
  lastDate: Schema.NullOr(Schema.String),
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  user: PublicUser,
});

type UserUsageMetric = typeof UserUsageMetric.Type;

const LeaderboardEntry = UserUsageMetric.mapFields(Struct.assign({ rank: Schema.Number }));

type LeaderboardEntry = typeof LeaderboardEntry.Type;

const LeaderboardResponse = Schema.Struct({
  entries: Schema.Array(LeaderboardEntry),
  metric: LeaderboardMetric,
  window: LeaderboardWindow,
});

type LeaderboardResponse = typeof LeaderboardResponse.Type;

const StatsTotals = Schema.Struct({
  activeDays: Schema.Number,
  cacheCreationTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  deviceCount: Schema.Number,
  firstDate: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  lastDate: Schema.NullOr(Schema.String),
  outputTokens: Schema.Number,
  rowCount: Schema.Number,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

type StatsTotals = typeof StatsTotals.Type;

/** One calendar day across all public users; also used for peak days. */
const StatsDailyPoint = Schema.Struct({
  date: Schema.String,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

type StatsDailyPoint = typeof StatsDailyPoint.Type;

/** One (date, key) cell; `key` is the model or source being grouped. */
const StatsDailyModelPoint = Schema.Struct({
  date: Schema.String,
  key: Schema.String,
  outputTokens: Schema.Number,
  rowCount: Schema.Number,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
});

type StatsDailyModelPoint = typeof StatsDailyModelPoint.Type;

/**
 * Series per stats chart: www stacks each metric's top models and folds the
 * rest into one "Other" series. The API keeps every model that ranks in the
 * top `STATS_CHART_MODEL_LIMIT` of any charted metric (spend, tokens,
 * sessions) and sums the long tail into `STATS_OTHER_MODEL_KEY`, so the
 * charts stay exact without shipping every model ever seen.
 */
const STATS_CHART_MODEL_LIMIT = 10;
const STATS_OTHER_MODEL_KEY = "Other";

/** One (date, model) cell of a window's daily charts; `rowCount` is sessions. */
const StatsChartPoint = StatsDailyModelPoint.mapFields(Struct.omit(["outputTokens"]));

type StatsChartPoint = typeof StatsChartPoint.Type;

const StatsRankedMetric = Schema.Struct({
  key: Schema.String,
  rowCount: Schema.Number,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

type StatsRankedMetric = typeof StatsRankedMetric.Type;

/** `ytd` starts on Jan 1 of the server's current UTC year. */
const StatsWindowId = Schema.Literals(["last30d", "ytd"]);

type StatsWindowId = typeof StatsWindowId.Type;

const StatsWindow = Schema.Struct({
  /** Daily chart cells, date-ascending; see `STATS_OTHER_MODEL_KEY`. */
  dailyByModel: Schema.Array(StatsChartPoint),
  modelsBySpend: Schema.Array(StatsRankedMetric),
  modelsByTokens: Schema.Array(StatsRankedMetric),
  /** Inclusive YYYY-MM-DD lower bound. */
  since: Schema.String,
  sources: Schema.Array(StatsRankedMetric),
  totals: StatsTotals,
});

type StatsWindow = typeof StatsWindow.Type;

/** Exactly what the /stats page renders: one entry per selectable window. */
const StatsResponse = Schema.Struct({
  generatedAt: Schema.String,
  windows: Schema.Record(StatsWindowId, StatsWindow),
});

type StatsResponse = typeof StatsResponse.Type;

const ProfileStats = Schema.Struct({
  activeDays: Schema.Number,
  avgSpendPerActiveDay: Schema.Number,
  currentStreakDays: Schema.Number,
  deviceCount: Schema.Number,
  firstDate: Schema.NullOr(Schema.String),
  lastDate: Schema.NullOr(Schema.String),
  leaderboardRank: Schema.NullOr(Schema.Number),
  longestStreakDays: Schema.Number,
  peakDay: Schema.NullOr(StatsDailyPoint.mapFields(Struct.pick(["date", "spendUsd"]))),
  sessionCount: Schema.Number,
  sources: Schema.Array(Schema.String),
  spendUsd: Schema.Number,
  topModel: Schema.NullOr(
    Schema.Struct({
      model: Schema.String,
      spendUsd: Schema.Number,
    }),
  ),
  totalTokens: Schema.Number,
});

type ProfileStats = typeof ProfileStats.Type;

const ProfileResponse = Schema.Struct({
  stats: ProfileStats,
  user: PublicUser,
});

type ProfileResponse = typeof ProfileResponse.Type;

// Public endpoint: device names are hostnames, visible only to their owner
// (via /me/devices), so they are deliberately not a public grouping.
const ProfileDailyGroupBy = Schema.Literals(["model", "source"]);

type ProfileDailyGroupBy = typeof ProfileDailyGroupBy.Type;

/**
 * One row per (date, key); `key` is the model or source the row groups by.
 * Only the fields the profile charts read are carried on the wire — input/cache
 * token breakdowns are intentionally omitted to keep the profile payload small.
 */
const ProfileDailyRow = StatsDailyModelPoint.mapFields(Struct.omit(["rowCount"]));

type ProfileDailyRow = typeof ProfileDailyRow.Type;

const ProfileDailyRange = Schema.Struct({
  firstDate: Schema.String,
  lastDate: Schema.String,
});

type ProfileDailyRange = typeof ProfileDailyRange.Type;

const ProfileDailyResponse = Schema.Struct({
  days: Schema.Array(ProfileDailyRow),
  range: ProfileDailyRange,
});

type ProfileDailyResponse = typeof ProfileDailyResponse.Type;

const OkResponse = Schema.Struct({
  ok: Schema.Boolean,
});

type OkResponse = typeof OkResponse.Type;

const ShadowBan = Schema.Struct({
  at: Schema.String,
  byUserId: UserId,
});

type ShadowBan = typeof ShadowBan.Type;

const ShadowBanUserResponse = Schema.Struct({
  shadowBan: Schema.NullOr(ShadowBan),
  userId: UserId,
});

type ShadowBanUserResponse = typeof ShadowBanUserResponse.Type;

const AdminDeviceStatus = Schema.Literals(["healthy", "repair-needed", "stale", "unknown"]);

type AdminDeviceStatus = typeof AdminDeviceStatus.Type;

const AdminDeviceUpdateStatus = Schema.Literals([
  "current",
  "outdated",
  "unknown",
  "update-blocked",
]);

type AdminDeviceUpdateStatus = typeof AdminDeviceUpdateStatus.Type;

/** A device plus the latest service check-in columns, flattened as stored. */
const AdminLatestDevice = DeviceSummary.mapFields(
  Struct.assign({
    lastCheckInAt: Schema.NullOr(Schema.String),
    serviceAutoUpdateAttemptedAt: Schema.NullOr(Schema.String),
    serviceAutoUpdateCompletedAt: Schema.NullOr(Schema.String),
    serviceAutoUpdateCurrentVersion: Schema.NullOr(Schema.String),
    serviceAutoUpdateEnabled: Schema.NullOr(Schema.Boolean),
    serviceAutoUpdateError: Schema.NullOr(Schema.String),
    serviceAutoUpdateInstalledVersion: Schema.NullOr(Schema.String),
    serviceAutoUpdateLatestVersion: Schema.NullOr(Schema.String),
    serviceAutoUpdateManager: Schema.NullOr(ServiceAutoUpdateManager),
    serviceAutoUpdateReason: Schema.NullOr(ServiceAutoUpdateReason),
    serviceAutoUpdateStatus: Schema.NullOr(ServiceAutoUpdateStatus),
    serviceBackend: Schema.NullOr(Schema.String),
    serviceError: Schema.NullOr(Schema.String),
    serviceReloadRequired: Schema.NullOr(Schema.Boolean),
    serviceRepairAttemptedAt: Schema.NullOr(Schema.String),
    serviceRepairCompletedAt: Schema.NullOr(Schema.String),
    serviceRepairError: Schema.NullOr(Schema.String),
    serviceRepairReason: Schema.NullOr(ServiceRepairReason),
    serviceRepairStatus: Schema.NullOr(ServiceRepairStatus),
    serviceRunnerTarget: Schema.NullOr(Schema.String),
    serviceRunnerVersion: Schema.NullOr(Schema.String),
    serviceSchedulerActive: Schema.NullOr(Schema.Boolean),
    serviceStatus: Schema.NullOr(ServiceCheckInStatus),
    serviceTemplateVersion: Schema.NullOr(Schema.Number),
  }),
);

type AdminLatestDevice = typeof AdminLatestDevice.Type;

const AdminDeviceDebugRow = Schema.Struct({
  activeDays: Schema.Number,
  activeTokenCount: Schema.Number,
  device: AdminLatestDevice,
  isOutdated: Schema.Boolean,
  lastTokenUsedAt: Schema.NullOr(Schema.String),
  lastUsageDate: Schema.NullOr(Schema.String),
  latestCheckInAt: Schema.NullOr(Schema.String),
  revokedTokenCount: Schema.Number,
  sources: Schema.Array(Schema.String),
  spendUsd: Schema.Number,
  status: AdminDeviceStatus,
  tokenCount: Schema.Number,
  totalTokens: Schema.Number,
  updateBlockedReason: Schema.NullOr(Schema.String),
  updateStatus: AdminDeviceUpdateStatus,
  user: AuthUser,
});

type AdminDeviceDebugRow = typeof AdminDeviceDebugRow.Type;

const AdminAccountDebugSummary = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  emailVerified: Schema.Boolean,
  login: Schema.NullOr(Schema.String),
  provider: OAuthProviderId,
});

type AdminAccountDebugSummary = typeof AdminAccountDebugSummary.Type;

const AdminUserDebugRow = Schema.Struct({
  accounts: Schema.Array(AdminAccountDebugSummary),
  activeDays: Schema.Number,
  activeTokenCount: Schema.Number,
  createdAt: Schema.String,
  deviceCount: Schema.Number,
  lastTokenUsedAt: Schema.NullOr(Schema.String),
  lastUsageDate: Schema.NullOr(Schema.String),
  latestCheckInAt: Schema.NullOr(Schema.String),
  latestDevice: Schema.NullOr(AdminLatestDevice),
  providers: Schema.Array(OAuthProviderId),
  revokedTokenCount: Schema.Number,
  shadowBan: Schema.NullOr(ShadowBan),
  sources: Schema.Array(Schema.String),
  spendUsd: Schema.Number,
  status: AdminDeviceStatus,
  tokenCount: Schema.Number,
  totalTokens: Schema.Number,
  updatedAt: Schema.String,
  user: AuthUser,
  verifiedEmails: Schema.Array(Schema.String),
});

type AdminUserDebugRow = typeof AdminUserDebugRow.Type;

const AdminLatestCliVersions = Schema.Struct({
  alpha: Schema.NullOr(Schema.String),
  beta: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.String),
  rc: Schema.NullOr(Schema.String),
});

type AdminLatestCliVersions = typeof AdminLatestCliVersions.Type;

const AdminUsersResponse = Schema.Struct({
  devices: Schema.Array(AdminDeviceDebugRow),
  generatedAt: Schema.String,
  latestCliPublishedAt: Schema.NullOr(Schema.String),
  latestCliVersion: Schema.NullOr(Schema.String),
  latestCliVersions: AdminLatestCliVersions,
  staleThresholdHours: Schema.Number,
  summary: Schema.Struct({
    healthy: Schema.Number,
    outdated: Schema.Number,
    repairNeeded: Schema.Number,
    stale: Schema.Number,
    totalDevices: Schema.Number,
    totalUsers: Schema.Number,
    updateBlocked: Schema.Number,
    unknown: Schema.Number,
  }),
  users: Schema.Array(AdminUserDebugRow),
});

type AdminUsersResponse = typeof AdminUsersResponse.Type;

export {
  AdminAccountDebugSummary,
  AdminDeviceDebugRow,
  AdminDeviceStatus,
  AdminDeviceUpdateStatus,
  AdminLatestCliVersions,
  AdminLatestDevice,
  AdminUserDebugRow,
  AdminUsersResponse,
  AuthUser,
  CliIdentity,
  CliLoginApproveInput,
  CliLoginApproveResponse,
  CliLoginDeviceCodePollInput,
  CliLoginFlow,
  CliLoginLegacyPollInput,
  CliLoginPollInput,
  CliLoginPollResponse,
  CliLoginRequestSummary,
  CliLoginStartInput,
  CliLoginStartResponse,
  CliTokenSummary,
  DEFAULT_LEADERBOARD_METRIC,
  DEFAULT_LEADERBOARD_WINDOW,
  DeviceId,
  DeviceSummary,
  HealthResponse,
  IngestUsageInput,
  LeaderboardEntry,
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
  ListAccountsResponse,
  ListDevicesResponse,
  ListTokensResponse,
  MAX_REPORT_DAYS,
  MeResponse,
  NewDeviceId,
  OAuthProviderId,
  OkResponse,
  ProfileDailyGroupBy,
  ProfileDailyRange,
  ProfileDailyResponse,
  ProfileDailyRow,
  ProfileIdentityResponse,
  ProfileResponse,
  ProfileStats,
  PublicUser,
  RawUsageReportInput,
  ServiceAutoUpdate,
  ServiceAutoUpdateManager,
  ServiceAutoUpdateReason,
  ServiceAutoUpdateStatus,
  ServiceCheckInInput,
  ServiceCheckInStatus,
  ServiceRepairReason,
  ServiceRepairStatus,
  ShadowBan,
  ShadowBanUserResponse,
  SourceUsageStatsInput,
  STATS_CHART_MODEL_LIMIT,
  STATS_OTHER_MODEL_KEY,
  StatsChartPoint,
  StatsDailyModelPoint,
  StatsDailyPoint,
  StatsRankedMetric,
  StatsResponse,
  StatsTotals,
  StatsWindow,
  StatsWindowId,
  SyncUsageDayInput,
  SyncUsageInput,
  SyncUsageResponse,
  TokenCount,
  TokenId,
  USAGE_SOURCES,
  UsageCheckInInput,
  UsageCheckInResponse,
  UsageDayInput,
  UsageDeviceInput,
  UsageRawReportKind,
  UsageSource,
  UsdAmount,
  UserAccountSummary,
  UserId,
  UserUsageMetric,
};
