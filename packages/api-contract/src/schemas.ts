import * as Schema from "effect/Schema";

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

const CliLoginStartInput = Schema.Struct({
  deviceArch: Schema.optional(Schema.String),
  deviceId: Schema.String,
  deviceName: Schema.String,
  devicePlatform: Schema.String,
  deviceVersion: Schema.optional(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const CliLoginStartResponse = Schema.Struct({
  code: Schema.String,
  expiresAt: Schema.String,
  intervalSeconds: Schema.Number,
  verificationUri: Schema.String,
});

const CliLoginPollInput = Schema.Struct({
  code: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const CliLoginPollResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("complete"),
    token: Schema.String,
    user: AuthUser,
  }),
]);

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
 * One day of usage for one (source, model) pair, as aggregated by the CLI
 * from ccusage output. `date` is an opaque YYYY-MM-DD local-time bucket.
 */
const UsageDayInput = Schema.Struct({
  cacheCreationTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  costUsd: Schema.Number,
  date: Schema.String,
  inputTokens: Schema.Number,
  model: Schema.String,
  outputTokens: Schema.Number,
  source: Schema.String,
  totalTokens: Schema.Number,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type UsageDayInput = typeof UsageDayInput.Type;

const SourceUsageStatsInput = Schema.Struct({
  sessionCount: Schema.Number,
  source: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

type SourceUsageStatsInput = typeof SourceUsageStatsInput.Type;

const UsageRawReportKind = Schema.Literals(["daily", "session"]);

type UsageRawReportKind = typeof UsageRawReportKind.Type;

const RawUsageReportInput = Schema.Struct({
  command: Schema.Array(Schema.String),
  payload: Schema.Unknown,
  reportKind: UsageRawReportKind,
  source: Schema.String,
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
  device: Schema.Struct({
    arch: Schema.optional(Schema.String),
    name: Schema.String,
    platform: Schema.String,
    version: Schema.optional(Schema.String),
  }),
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
  device: Schema.Struct({
    arch: Schema.optional(Schema.String),
    name: Schema.String,
    platform: Schema.String,
    version: Schema.optional(Schema.String),
  }),
  reports: Schema.Array(RawUsageReportInput),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

const SyncUsageInput = Schema.Struct({
  days: Schema.Array(UsageDayInput),
  device: Schema.Struct({
    arch: Schema.optional(Schema.String),
    name: Schema.String,
    platform: Schema.String,
    version: Schema.optional(Schema.String),
  }),
  sourceStats: Schema.optional(Schema.Array(SourceUsageStatsInput)),
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

const ProfileStats = Schema.Struct({
  activeDays: Schema.Number,
  avgSpendPerActiveDay: Schema.Number,
  currentStreakDays: Schema.Number,
  deviceCount: Schema.Number,
  firstDate: Schema.NullOr(Schema.String),
  lastDate: Schema.NullOr(Schema.String),
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

const ProfileDailyGroupBy = Schema.Literals(["model", "source", "device"]);

type ProfileDailyGroupBy = typeof ProfileDailyGroupBy.Type;

/**
 * One row per (date, key); `key` is the model/source/device the row groups by.
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

const AdminUsersResponse = Schema.Struct({
  devices: Schema.Array(AdminDeviceDebugRow),
  generatedAt: Schema.String,
  latestCliPublishedAt: Schema.NullOr(Schema.String),
  latestCliVersion: Schema.NullOr(Schema.String),
  rolloutGraceHours: Schema.Number,
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
  CliLoginStartInput,
  CliLoginStartResponse,
  CliTokenSummary,
  DeviceSummary,
  HealthResponse,
  IngestUsageInput,
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
  ProfileResponse,
  ProfileStats,
  RawUsageReportInput,
  ServiceAutoUpdate,
  ServiceAutoUpdateManager,
  ServiceAutoUpdateReason,
  ServiceAutoUpdateStatus,
  ServiceCheckInStatus,
  ServiceRepairReason,
  ServiceRepairStatus,
  SourceUsageStatsInput,
  SyncUsageInput,
  SyncUsageResponse,
  UsageCheckInInput,
  UsageCheckInResponse,
  UserAccountSummary,
  UsageDayInput,
  UsageRawReportKind,
};

export type {
  ServiceAutoUpdateManagerValue,
  ServiceAutoUpdateReasonValue,
  ServiceAutoUpdateStatusValue,
  ServiceCheckInStatusValue,
  ServiceRepairReasonValue,
  ServiceRepairStatusValue,
};
