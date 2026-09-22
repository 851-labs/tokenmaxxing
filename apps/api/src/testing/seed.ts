import type { DatabaseSync } from "node:sqlite";

/**
 * Row builders for the migrated test schema. Every column the tests do not
 * care about gets a fixed default, so assertions only mention what matters.
 */

interface SeedUser {
  avatarUrl?: string | null;
  createdAt?: number;
  id: string;
  login?: string;
  name?: string | null;
  shadowBannedAt?: number | null;
  shadowBannedByUserId?: string | null;
}

interface SeedAccount {
  email?: string | null;
  emailVerified?: boolean;
  provider?: "github" | "google";
  providerAccountId: string;
  userId: string;
}

interface SeedDevice {
  createdAt?: number;
  id: string;
  name?: string;
  userId: string;
}

interface SeedToken {
  deviceId?: string | null;
  id: string;
  revokedAt?: number | null;
  userId: string;
}

interface SeedUsage {
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  date: string;
  deviceId: string;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  source?: string;
  syncedAt?: number;
  totalTokens?: number;
  userId: string;
}

interface SeedSourceStats {
  deviceId: string;
  sessionCount: number;
  source: string;
  userId: string;
}

interface SeedRawBatch {
  deviceId: string;
  id: string;
  objectKey: string;
  userId: string;
}

function seedUser(sqlite: DatabaseSync, user: SeedUser): void {
  sqlite
    .prepare(
      `insert into users (
        id, login, name, avatar_url, shadow_banned_at, shadow_banned_by_user_id,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      user.login ?? user.id,
      user.name ?? null,
      user.avatarUrl ?? null,
      user.shadowBannedAt ?? null,
      user.shadowBannedByUserId ?? null,
      user.createdAt ?? 0,
      user.createdAt ?? 0,
    );
}

function seedAccount(sqlite: DatabaseSync, account: SeedAccount): void {
  sqlite
    .prepare(
      `insert into user_accounts (
        provider, provider_account_id, user_id, email, email_verified, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      account.provider ?? "github",
      account.providerAccountId,
      account.userId,
      account.email ?? null,
      account.emailVerified === true ? 1 : 0,
    );
}

function seedSession(sqlite: DatabaseSync, id: string, userId: string): void {
  sqlite
    .prepare("insert into sessions (id, user_id, expires_at, created_at) values (?, ?, ?, 0)")
    .run(id, userId, Number.MAX_SAFE_INTEGER);
}

function seedLoginRequest(sqlite: DatabaseSync, id: string, userId: string | null): void {
  sqlite
    .prepare(
      `insert into cli_login_requests (
        id, code, status, user_id, device_id, device_name, device_platform, expires_at, created_at
      ) values (?, ?, 'pending', ?, 'login-device', 'laptop', 'darwin', 0, 0)`,
    )
    .run(id, `code-${id}`, userId);
}

function seedDevice(sqlite: DatabaseSync, device: SeedDevice): void {
  sqlite
    .prepare(
      "insert into devices (id, user_id, name, platform, created_at) values (?, ?, ?, 'darwin', ?)",
    )
    .run(device.id, device.userId, device.name ?? device.id, device.createdAt ?? 0);
}

function seedToken(sqlite: DatabaseSync, token: SeedToken): void {
  sqlite
    .prepare(
      `insert into cli_tokens (id, token_hash, user_id, device_id, name, created_at, revoked_at)
       values (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      token.id,
      `sha256:${token.id}`,
      token.userId,
      token.deviceId ?? null,
      token.id,
      token.revokedAt ?? null,
    );
}

function seedUsage(sqlite: DatabaseSync, usage: SeedUsage): void {
  sqlite
    .prepare(
      `insert into usage_days (
        device_id, user_id, date, source, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      usage.deviceId,
      usage.userId,
      usage.date,
      usage.source ?? "codex",
      usage.model ?? "gpt-5",
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cacheCreationTokens ?? 0,
      usage.cacheReadTokens ?? 0,
      usage.totalTokens ?? 0,
      usage.costUsd ?? 0,
      usage.syncedAt ?? 0,
    );
}

function seedSourceStats(sqlite: DatabaseSync, stats: SeedSourceStats): void {
  sqlite
    .prepare(
      `insert into usage_source_stats (device_id, user_id, source, session_count, synced_at)
       values (?, ?, ?, ?, 0)`,
    )
    .run(stats.deviceId, stats.userId, stats.source, stats.sessionCount);
}

function seedRawBatch(sqlite: DatabaseSync, batch: SeedRawBatch): void {
  sqlite
    .prepare(
      `insert into usage_raw_batches (
        id, user_id, device_id, source, report_kind, ccusage_command, payload_hash,
        object_key, payload_bytes, captured_at, processed_at, parser_version
      ) values (?, ?, ?, 'codex', 'daily', 'ccusage codex daily', ?, ?, 2, 0, 0, 'test')`,
    )
    .run(batch.id, batch.userId, batch.deviceId, `hash-${batch.id}`, batch.objectKey);
}

/**
 * Row counts for every table with a user_id column — discovered from the
 * migrated schema, so a new user-owned table is covered automatically.
 */
function countRowsByUser(sqlite: DatabaseSync, userId: string): Record<string, number> {
  const tables = sqlite
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((row) => String(row.name))
    .filter((table) =>
      sqlite
        .prepare(`pragma table_info(${table})`)
        .all()
        .some((column) => column.name === "user_id"),
    );

  return Object.fromEntries(
    tables.map((table) => {
      const row = sqlite
        .prepare(`select count(*) as count from ${table} where user_id = ?`)
        .get(userId);
      return [table, Number(row?.count ?? 0)];
    }),
  );
}

export {
  countRowsByUser,
  seedAccount,
  seedDevice,
  seedLoginRequest,
  seedRawBatch,
  seedSession,
  seedSourceStats,
  seedToken,
  seedUsage,
  seedUser,
};
