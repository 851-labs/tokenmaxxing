import * as Schema from "effect/Schema";

import { DateKey } from "./date-key";

const HealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  product: Schema.String,
  service: Schema.String,
});

const AuthUser = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  id: Schema.String,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
});

type AuthUser = typeof AuthUser.Type;

const MeResponse = Schema.Struct({
  user: AuthUser,
});

const ProfileIdentityResponse = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  login: Schema.String,
});

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

/** Identity resolved from a `tmx_` bearer token (CLI clients). */
const CliIdentity = Schema.Struct({
  deviceId: Schema.NullOr(Schema.String),
  tokenId: Schema.String,
  user: AuthUser,
});

type CliIdentity = typeof CliIdentity.Type;

const DeviceSummary = Schema.Struct({
  arch: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  id: Schema.String,
  lastSyncAt: Schema.NullOr(Schema.String),
  name: Schema.String,
  platform: Schema.String,
  version: Schema.NullOr(Schema.String),
});

const CliTokenSummary = Schema.Struct({
  createdAt: Schema.String,
  deviceId: Schema.NullOr(Schema.String),
  id: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});

/**
 * Device-code CLI login (RFC 8628 shaped). Current CLIs send
 * `flow: "device_code"` and poll with the secret `deviceCode`; the short
 * `userCode` only ever travels to the browser for approval. Requests started
 * without `flow` are legacy (pre-device-code CLIs): they get no deviceCode
 * and may poll by `code` until the legacy sunset.
 */
const CliLoginFlow = Schema.Literal("device_code");

const CliLoginStartInput = Schema.Struct({
  deviceArch: Schema.optional(Schema.String),
  deviceId: Schema.String,
  deviceName: Schema.String,
  devicePlatform: Schema.String,
  deviceVersion: Schema.optional(Schema.String),
  flow: Schema.optional(CliLoginFlow),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

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

const CliLoginDeviceCodePollInput = Schema.Struct({
  deviceCode: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

/** Pre-device-code CLIs poll with the user code; see the legacy sunset. */
const CliLoginLegacyPollInput = Schema.Struct({
  code: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

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
  code: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const CliLoginApproveResponse = Schema.Struct({
  deviceName: Schema.String,
  ok: Schema.Boolean,
});

/**
 * Agents the CLI can sync, in CLI display order. Input schemas only accept
 * these; response schemas keep `source` as a plain string so older decoders
 * keep working when a source is added.
 */
const USAGE_SOURCES = ["claude", "codex", "opencode", "gemini", "copilot", "hermes", "pi"] as const;

const UsageSource = Schema.Literals(USAGE_SOURCES);

type UsageSource = typeof UsageSource.Type;

/** Token counts are non-negative safe integers (ccusage never emits fractions). */
const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** USD amounts are finite and non-negative; rejects JSON "NaN"/"Infinity" too. */
const UsdAmount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const boundedString = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));

const boundedArray = <S extends Schema.Top>(item: S, maxLength: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maxLength));

const MAX_MODEL_NAME_LENGTH = 256;
/** Legacy `/usage/sync` clients upload in chunks of 1000 rows. */
const MAX_SYNC_DAYS = 1_000;
/** One daily plus one legacy session report per source, with headroom. */
const MAX_RAW_REPORTS = 64;
const MAX_SOURCE_STATS = 64;
const MAX_COMMAND_ARGS = 32;
const MAX_COMMAND_ARG_LENGTH = 256;

const UsageDeviceInput = Schema.Struct({
  arch: Schema.optional(boundedString(64)),
  name: boundedString(256),
  platform: boundedString(64),
  version: Schema.optional(boundedString(64)),
});

/**
 * One day of usage for one (source, model) pair, as aggregated by the CLI
 * from ccusage output. `date` is an opaque YYYY-MM-DD local-time bucket.
 */
const UsageDayInput = Schema.Struct({
  cacheCreationTokens: TokenCount,
  cacheReadTokens: TokenCount,
  costUsd: UsdAmount,
  date: DateKey,
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
 */
const RawUsageReportInput = Schema.Struct({
  command: boundedArray(boundedString(MAX_COMMAND_ARG_LENGTH), MAX_COMMAND_ARGS),
  payload: Schema.Unknown,
  reportKind: UsageRawReportKind,
  source: UsageSource,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type RawUsageReportInput = typeof RawUsageReportInput.Type;

const ServiceCheckInStatus = Schema.Literals(["started", "success", "failure"]);

type ServiceCheckInStatusValue = typeof ServiceCheckInStatus.Type;

const ServiceAutoUpdateManager = Schema.Literals(["bun", "npm", "pnpm", "registry", "yarn"]);

type ServiceAutoUpdateManagerValue = typeof ServiceAutoUpdateManager.Type;

const ServiceAutoUpdateStatus = Schema.Literals(["failure", "not-needed", "skipped", "success"]);

type ServiceAutoUpdateStatusValue = typeof ServiceAutoUpdateStatus.Type;

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

type ServiceAutoUpdateReasonValue = typeof ServiceAutoUpdateReason.Type;

const ServiceAutoUpdate = Schema.Struct({
  attemptedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  currentVersion: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  installedVersion: Schema.optional(Schema.NullOr(Schema.String)),
  latestVersion: Schema.optional(Schema.NullOr(Schema.String)),
  manager: Schema.NullOr(ServiceAutoUpdateManager),
  reason: Schema.NullOr(ServiceAutoUpdateReason),
  status: ServiceAutoUpdateStatus,
});

const ServiceRepairReason = Schema.Literals([
  "auto-updated",
  "reload-required",
  "scheduler-inactive",
  "service-failure",
]);

type ServiceRepairReasonValue = typeof ServiceRepairReason.Type;

const ServiceRepairStatus = Schema.Literals(["failure", "scheduled", "success"]);

type ServiceRepairStatusValue = typeof ServiceRepairStatus.Type;

const UsageCheckInInput = Schema.Struct({
  device: UsageDeviceInput,
  service: Schema.Struct({
    autoUpdate: Schema.optional(ServiceAutoUpdate),
    backend: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    reloadRequired: Schema.optional(Schema.Boolean),
    repairAttemptedAt: Schema.optional(Schema.String),
    repairCompletedAt: Schema.optional(Schema.String),
    repairError: Schema.optional(Schema.String),
    repairReason: Schema.optional(ServiceRepairReason),
    repairStatus: Schema.optional(ServiceRepairStatus),
    runnerTarget: Schema.optional(Schema.String),
    runnerVersion: Schema.optional(Schema.String),
    schedulerActive: Schema.optional(Schema.Boolean),
    status: ServiceCheckInStatus,
    templateVersion: Schema.optional(Schema.Number),
  }),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const UsageCheckInResponse = Schema.Struct({
  checkedInAt: Schema.String,
});

const IngestUsageInput = Schema.Struct({
  device: UsageDeviceInput,
  reports: boundedArray(RawUsageReportInput, MAX_RAW_REPORTS),
  sourceStats: Schema.optional(boundedArray(SourceUsageStatsInput, MAX_SOURCE_STATS)),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const SyncUsageInput = Schema.Struct({
  days: boundedArray(UsageDayInput, MAX_SYNC_DAYS),
  device: UsageDeviceInput,
  sourceStats: Schema.optional(boundedArray(SourceUsageStatsInput, MAX_SOURCE_STATS)),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const SyncUsageResponse = Schema.Struct({
  received: Schema.Number,
  syncedAt: Schema.String,
  upserted: Schema.Number,
});

const LeaderboardMetric = Schema.Literals(["spend", "tokens"]);
const LeaderboardWindow = Schema.Literals(["all", "30d", "7d"]);

type LeaderboardMetric = typeof LeaderboardMetric.Type;
type LeaderboardWindow = typeof LeaderboardWindow.Type;

const DEFAULT_LEADERBOARD_METRIC = "spend" as const satisfies LeaderboardMetric;
const DEFAULT_LEADERBOARD_WINDOW = "30d" as const satisfies LeaderboardWindow;

const LeaderboardEntry = Schema.Struct({
  activeDays: Schema.Number,
  lastDate: Schema.NullOr(Schema.String),
  rank: Schema.Number,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  user: AuthUser,
});

const LeaderboardResponse = Schema.Struct({
  entries: Schema.Array(LeaderboardEntry),
  metric: LeaderboardMetric,
  window: LeaderboardWindow,
});

const StatsTotals = Schema.Struct({
  activeDates: Schema.Number,
  cacheCreationTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  deviceCount: Schema.Number,
  firstDate: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  lastDate: Schema.NullOr(Schema.String),
  outputTokens: Schema.Number,
  rowCount: Schema.Number,
  totalSpendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

const StatsDailyPoint = Schema.Struct({
  date: Schema.String,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

const StatsDailyModelPoint = Schema.Struct({
  costUsd: Schema.Number,
  date: Schema.String,
  key: Schema.String,
  outputTokens: Schema.Number,
  rowCount: Schema.Number,
  totalTokens: Schema.Number,
});

const StatsRankedMetric = Schema.Struct({
  key: Schema.String,
  rowCount: Schema.Number,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

const StatsUserMetric = Schema.Struct({
  activeDays: Schema.Number,
  lastDate: Schema.NullOr(Schema.String),
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  user: AuthUser,
});

const StatsPeakDay = Schema.Struct({
  date: Schema.String,
  spendUsd: Schema.Number,
  totalTokens: Schema.Number,
  userCount: Schema.Number,
});

const StatsResponse = Schema.Struct({
  allTime: StatsTotals,
  daily: Schema.Array(StatsDailyPoint),
  dailyByModel: Schema.Array(StatsDailyModelPoint),
  generatedAt: Schema.String,
  last30d: StatsTotals,
  last30dSince: Schema.String,
  peaks: Schema.Struct({
    spend: Schema.NullOr(StatsPeakDay),
    tokens: Schema.NullOr(StatsPeakDay),
  }),
  sources: Schema.Struct({
    allTime: Schema.Array(StatsRankedMetric),
    last30d: Schema.Array(StatsRankedMetric),
    year2026: Schema.Array(StatsRankedMetric),
  }),
  topModels: Schema.Struct({
    allTimeBySpend: Schema.Array(StatsRankedMetric),
    allTimeByTokens: Schema.Array(StatsRankedMetric),
    last30dBySpend: Schema.Array(StatsRankedMetric),
    last30dByTokens: Schema.Array(StatsRankedMetric),
    year2026BySpend: Schema.Array(StatsRankedMetric),
    year2026ByTokens: Schema.Array(StatsRankedMetric),
  }),
  topUsers: Schema.Struct({
    bySpend: Schema.Array(StatsUserMetric),
    byTokens: Schema.Array(StatsUserMetric),
  }),
  year2026: StatsTotals,
  year2026Since: Schema.String,
});

const ProfileStats = Schema.Struct({
  activeDays: Schema.Number,
  avgSpendPerActiveDay: Schema.Number,
  currentStreakDays: Schema.Number,
  deviceCount: Schema.Number,
  firstDate: Schema.NullOr(Schema.String),
  lastDate: Schema.NullOr(Schema.String),
  leaderboardRank: Schema.NullOr(Schema.Number),
  longestStreakDays: Schema.Number,
  peakDay: Schema.NullOr(
    Schema.Struct({
      date: Schema.String,
      spendUsd: Schema.Number,
    }),
  ),
  sessionCount: Schema.Number,
  sources: Schema.Array(Schema.String),
  topModel: Schema.NullOr(
    Schema.Struct({
      model: Schema.String,
      spendUsd: Schema.Number,
    }),
  ),
  totalSpendUsd: Schema.Number,
  totalTokens: Schema.Number,
});

const ProfileResponse = Schema.Struct({
  stats: ProfileStats,
  user: AuthUser,
});

// Public endpoint: device names are hostnames, visible only to their owner
// (via /me/devices), so they are deliberately not a public grouping.
const ProfileDailyGroupBy = Schema.Literals(["model", "source"]);

type ProfileDailyGroupBy = typeof ProfileDailyGroupBy.Type;

/**
 * One row per (date, key); `key` is the model or source the row groups by.
 * Only the fields the profile charts read are carried on the wire — input/cache
 * token breakdowns are intentionally omitted to keep the profile payload small.
 */
const ProfileDailyRow = Schema.Struct({
  costUsd: Schema.Number,
  date: Schema.String,
  key: Schema.String,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
});

const ProfileDailyRange = Schema.Struct({
  first: Schema.String,
  last: Schema.String,
});

const ProfileDailyResponse = Schema.Struct({
  range: ProfileDailyRange,
  days: Schema.Array(ProfileDailyRow),
});

const OkResponse = Schema.Struct({
  ok: Schema.Boolean,
});

const ShadowBan = Schema.Struct({
  at: Schema.String,
  byUserId: Schema.String,
});

type ShadowBan = typeof ShadowBan.Type;

const ShadowBanUserResponse = Schema.Struct({
  shadowBan: Schema.NullOr(ShadowBan),
  userId: Schema.String,
});

const AdminDeviceStatus = Schema.Literals(["healthy", "repair-needed", "stale", "unknown"]);

type AdminDeviceStatus = typeof AdminDeviceStatus.Type;

const AdminDeviceUpdateStatus = Schema.Literals([
  "current",
  "outdated",
  "unknown",
  "update-blocked",
]);

type AdminDeviceUpdateStatus = typeof AdminDeviceUpdateStatus.Type;

const AdminLatestDevice = Schema.Struct({
  arch: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  id: Schema.String,
  lastCheckInAt: Schema.NullOr(Schema.String),
  lastSyncAt: Schema.NullOr(Schema.String),
  name: Schema.String,
  platform: Schema.String,
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
  version: Schema.NullOr(Schema.String),
});

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
  status: AdminDeviceStatus,
  tokenCount: Schema.Number,
  totalSpendUsd: Schema.Number,
  totalTokens: Schema.Number,
  updateBlockedReason: Schema.NullOr(Schema.String),
  updateStatus: AdminDeviceUpdateStatus,
  user: AuthUser,
});

const AdminAccountDebugSummary = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  emailVerified: Schema.Boolean,
  login: Schema.NullOr(Schema.String),
  provider: OAuthProviderId,
});

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
  status: AdminDeviceStatus,
  tokenCount: Schema.Number,
  totalSpendUsd: Schema.Number,
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
  AdminDeviceDebugRow,
  AdminDeviceStatus,
  AdminDeviceUpdateStatus,
  AdminUserDebugRow,
  AdminUsersResponse,
  AuthUser,
  CliIdentity,
  CliLoginApproveInput,
  CliLoginApproveResponse,
  CliLoginPollInput,
  CliLoginPollResponse,
  CliLoginRequestSummary,
  CliLoginStartInput,
  CliLoginStartResponse,
  CliTokenSummary,
  DeviceSummary,
  HealthResponse,
  IngestUsageInput,
  DEFAULT_LEADERBOARD_METRIC,
  DEFAULT_LEADERBOARD_WINDOW,
  LeaderboardEntry,
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
  MeResponse,
  OAuthProviderId,
  OkResponse,
  ProfileDailyGroupBy,
  ProfileDailyRange,
  ProfileDailyResponse,
  ProfileDailyRow,
  ProfileIdentityResponse,
  ProfileResponse,
  ProfileStats,
  RawUsageReportInput,
  ShadowBan,
  ShadowBanUserResponse,
  ServiceAutoUpdate,
  ServiceAutoUpdateManager,
  ServiceAutoUpdateReason,
  ServiceAutoUpdateStatus,
  ServiceCheckInStatus,
  ServiceRepairReason,
  ServiceRepairStatus,
  SourceUsageStatsInput,
  StatsDailyPoint,
  StatsDailyModelPoint,
  StatsPeakDay,
  StatsRankedMetric,
  StatsResponse,
  StatsTotals,
  StatsUserMetric,
  SyncUsageInput,
  SyncUsageResponse,
  UsageCheckInInput,
  UsageCheckInResponse,
  UserAccountSummary,
  UsageDayInput,
  UsageDeviceInput,
  UsageRawReportKind,
  USAGE_SOURCES,
  UsageSource,
  UsdAmount,
  TokenCount,
};

export type {
  ServiceAutoUpdateManagerValue,
  ServiceAutoUpdateReasonValue,
  ServiceAutoUpdateStatusValue,
  ServiceCheckInStatusValue,
  ServiceRepairReasonValue,
  ServiceRepairStatusValue,
};
