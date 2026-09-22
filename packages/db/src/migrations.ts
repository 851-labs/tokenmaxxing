import { readdirSync, readFileSync } from "node:fs";
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

interface Migration {
  statements: string[];
  tag: string;
}

interface JournalEntry {
  idx: number;
  tag: string;
}

interface SqlExecutor {
  exec(sql: string): void;
}

/** Every migration in journal order; fails on SQL files the journal omits. */
function readMigrations(): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  const entries = [...journal.entries].sort((left, right) => left.idx - right.idx);
  const journaled = new Set(entries.map((entry) => `${entry.tag}.sql`));
  const unjournaled = readdirSync(migrationsDir).filter(
    (file) => file.endsWith(".sql") && !journaled.has(file),
  );
  if (unjournaled.length > 0) {
    throw new Error(`Migrations missing from the journal: ${unjournaled.join(", ")}`);
  }

  return entries.map((entry) => ({
    statements: readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8")
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
    tag: entry.tag,
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
 * Applies migrations in journal order. `before` stops ahead of the named
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
