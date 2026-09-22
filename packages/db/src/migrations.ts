import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Node-only access to the drizzle-kit migrations — the same files alchemy
 * applies to D1 — so tests build their schema from the real migration
 * history instead of hand-written DDL. Kept off the package root: the worker
 * bundle must never pull in node:fs.
 */

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** drizzle-kit v1 migration folders: `YYYYMMDDHHMMSS_name/migration.sql`. */
const MIGRATION_DIR_PATTERN = /^\d{14}_.+$/;

interface Migration {
  statements: string[];
  /** The migration folder name — also the name deploys record in `d1_migrations`. */
  tag: string;
}

interface SqlExecutor {
  exec(sql: string): void;
}

/**
 * Every migration in folder-name order — the order drizzle-kit and alchemy
 * apply them. Fails on anything else in the directory (a stray `.sql` file
 * or a pre-v1 `meta/` journal), which deploys would skip or reject.
 */
function readMigrations(): Migration[] {
  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const unexpected = entries.filter(
    (entry) =>
      !entry.isDirectory() ||
      !MIGRATION_DIR_PATTERN.test(entry.name) ||
      !existsSync(join(migrationsDir, entry.name, "migration.sql")),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Not drizzle-kit v1 migration folders: ${unexpected.map((entry) => entry.name).join(", ")}`,
    );
  }

  return entries
    .map((entry) => entry.name)
    .sort()
    .map((tag) => ({
      statements: readFileSync(join(migrationsDir, tag, "migration.sql"), "utf8")
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0),
      tag,
    }));
}

function readMigration(tag: string): Migration {
  const migration = readMigrations().find((candidate) => candidate.tag === tag);
  if (migration === undefined) {
    throw new Error(`Unknown migration tag: ${tag}`);
  }

  return migration;
}

/**
 * Applies migrations in order. `before` stops ahead of the named
 * tag so a migration's own test can seed the schema that preceded it.
 */
function applyMigrations(database: SqlExecutor, options: { before?: string } = {}): void {
  const migrations = readMigrations();
  if (options.before !== undefined) {
    readMigration(options.before);
  }

  for (const migration of migrations) {
    if (migration.tag === options.before) {
      return;
    }
    applyMigration(database, migration);
  }
}

function applyMigration(database: SqlExecutor, migration: Migration): void {
  for (const statement of migration.statements) {
    database.exec(statement);
  }
}

export { applyMigration, applyMigrations, migrationsDir, readMigration, readMigrations };

export type { Migration, SqlExecutor };
