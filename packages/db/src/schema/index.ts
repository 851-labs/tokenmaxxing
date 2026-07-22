import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  login: text("login").notNull().unique("users_login_unique"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  shadowBannedAt: integer("shadow_banned_at", { mode: "timestamp_ms" }),
  shadowBannedByUserId: text("shadow_banned_by_user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

const userAccounts = sqliteTable(
  "user_accounts",
  {
    provider: text("provider", { enum: ["github", "google"] }).notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    login: text("login"),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
    index("user_accounts_user_idx").on(table.userId),
    index("user_accounts_email_idx").on(table.email),
  ],
);

/** id = sha256(token); the raw token lives only in the browser cookie. */
const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/**
 * Device-code login flow. The raw CLI token is parked on the row between
 * approve and poll; the row is deleted when poll delivers it (exactly once)
 * and rows expire 10 minutes after start regardless.
 */
const cliLoginRequests = sqliteTable("cli_login_requests", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique("cli_login_requests_code_unique"),
  status: text("status", { enum: ["pending", "approved"] })
    .notNull()
    .default("pending"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  token: text("token"),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name").notNull(),
  devicePlatform: text("device_platform").notNull(),
  deviceArch: text("device_arch"),
  deviceVersion: text("device_version"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Never expires by design; revokedAt is the only kill switch. */
const cliTokens = sqliteTable(
  "cli_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique("cli_tokens_token_hash_unique"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    name: text("name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("cli_tokens_user_idx").on(table.userId)],
);

/**
 * id is a client-generated UUID persisted in the CLI config — it survives
 * logout/login so re-syncs stay idempotent across re-authentication.
 */
const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    arch: text("arch"),
    version: text("version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastCheckInAt: integer("last_check_in_at", { mode: "timestamp_ms" }),
    serviceAutoUpdateAttemptedAt: integer("service_auto_update_attempted_at", {
      mode: "timestamp_ms",
    }),
    serviceAutoUpdateCompletedAt: integer("service_auto_update_completed_at", {
      mode: "timestamp_ms",
    }),
    serviceAutoUpdateCurrentVersion: text("service_auto_update_current_version"),
    serviceAutoUpdateEnabled: integer("service_auto_update_enabled", { mode: "boolean" }),
    serviceAutoUpdateError: text("service_auto_update_error"),
    serviceAutoUpdateInstalledVersion: text("service_auto_update_installed_version"),
    serviceAutoUpdateLatestVersion: text("service_auto_update_latest_version"),
    serviceAutoUpdateManager: text("service_auto_update_manager"),
    serviceAutoUpdateReason: text("service_auto_update_reason"),
    serviceAutoUpdateStatus: text("service_auto_update_status"),
    serviceBackend: text("service_backend"),
    serviceError: text("service_error"),
    serviceReloadRequired: integer("service_reload_required", { mode: "boolean" }),
    serviceRepairAttemptedAt: integer("service_repair_attempted_at", { mode: "timestamp_ms" }),
    serviceRepairCompletedAt: integer("service_repair_completed_at", { mode: "timestamp_ms" }),
    serviceRepairError: text("service_repair_error"),
    serviceRepairReason: text("service_repair_reason"),
    serviceRepairStatus: text("service_repair_status"),
    serviceRunnerTarget: text("service_runner_target"),
    serviceRunnerVersion: text("service_runner_version"),
    serviceSchedulerActive: integer("service_scheduler_active", { mode: "boolean" }),
    serviceStatus: text("service_status"),
    serviceTemplateVersion: integer("service_template_version"),
  },
  (table) => [index("devices_user_idx").on(table.userId)],
);

/**
 * One row per (device, local day, agent, model); the sync endpoint upserts
 * on that key (last write wins). `date` is an opaque YYYY-MM-DD string in
 * the device's local time — zero-padded ISO compares lexicographically,
 * which is what the leaderboard window scans rely on.
 */
const usageDays = sqliteTable(
  "usage_days",
  {
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    source: text("source").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.date, table.source, table.model] }),
    index("usage_days_user_date_idx").on(table.userId, table.date),
    index("usage_days_date_idx").on(table.date),
  ],
);

/**
 * One row per (device, agent) for sync-level aggregates that do not belong on
 * model/day usage rows. The CLI reports all-time session counts here during a
 * full sync; partial syncs leave these untouched.
 */
const usageSourceStats = sqliteTable(
  "usage_source_stats",
  {
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    sessionCount: integer("session_count").notNull().default(0),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.source] }),
    index("usage_source_stats_user_idx").on(table.userId),
  ],
);

/**
 * Normalized daily ccusage reports used for server-side parser backfills.
 * Historical rows may include session reports from before aggregate-only
 * session stats were introduced.
 */
const usageRawBatches = sqliteTable(
  "usage_raw_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    source: text("source").notNull(),
    reportKind: text("report_kind", { enum: ["daily", "session"] }).notNull(),
    ccusageCommand: text("ccusage_command").notNull(),
    payloadHash: text("payload_hash").notNull(),
    objectKey: text("object_key").notNull(),
    payloadBytes: integer("payload_bytes").notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    parserVersion: text("parser_version").notNull(),
  },
  (table) => [
    uniqueIndex("usage_raw_batches_device_payload_hash_unique").on(
      table.deviceId,
      table.payloadHash,
    ),
    index("usage_raw_batches_user_idx").on(table.userId),
    index("usage_raw_batches_device_idx").on(table.deviceId),
    index("usage_raw_batches_source_idx").on(table.source),
  ],
);

type User = typeof users.$inferSelect;
type NewUser = typeof users.$inferInsert;
type UserAccount = typeof userAccounts.$inferSelect;
type NewUserAccount = typeof userAccounts.$inferInsert;
type Session = typeof sessions.$inferSelect;
type NewSession = typeof sessions.$inferInsert;
type CliLoginRequest = typeof cliLoginRequests.$inferSelect;
type NewCliLoginRequest = typeof cliLoginRequests.$inferInsert;
type CliToken = typeof cliTokens.$inferSelect;
type NewCliToken = typeof cliTokens.$inferInsert;
type Device = typeof devices.$inferSelect;
type NewDevice = typeof devices.$inferInsert;
type UsageDay = typeof usageDays.$inferSelect;
type NewUsageDay = typeof usageDays.$inferInsert;
type UsageSourceStat = typeof usageSourceStats.$inferSelect;
type NewUsageSourceStat = typeof usageSourceStats.$inferInsert;
type UsageRawBatch = typeof usageRawBatches.$inferSelect;
type NewUsageRawBatch = typeof usageRawBatches.$inferInsert;

export {
  cliLoginRequests,
  cliTokens,
  devices,
  sessions,
  usageDays,
  usageRawBatches,
  usageSourceStats,
  userAccounts,
  users,
};

export type {
  CliLoginRequest,
  CliToken,
  Device,
  NewCliLoginRequest,
  NewCliToken,
  NewDevice,
  NewSession,
  NewUserAccount,
  NewUsageDay,
  NewUsageRawBatch,
  NewUsageSourceStat,
  NewUser,
  Session,
  UsageDay,
  UsageRawBatch,
  UsageSourceStat,
  UserAccount,
  User,
};
