import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  applyMigrations as alchemyApplyMigrations,
  inlineSqlParams,
  type SqlExecutor,
} from "alchemy/SQL/Migrations/index";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyMigration,
  migrationsDir,
  readMigrations,
  type Migration,
} from "@tokenmaxxing/db/migrations";

import { migrations } from "./database";

/**
 * Every row prod's `d1_migrations` held before the drizzle-kit v1 layout,
 * mapped to the folder `drizzle-kit up` converted it to. Alchemy matches
 * bookkeeping rows to migrations by name, so prod's rows are renamed to
 * these folder names before the first deploy that reads the v1 layout.
 */
const LEGACY_MIGRATION_NAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["0000_charming_morgan_stark.sql", "20260612221145_charming_morgan_stark"],
  ["0001_swift_black_cat.sql", "20260614233643_swift_black_cat"],
  ["0002_smooth_malice.sql", "20260616060627_smooth_malice"],
  ["0003_even_silver_centurion.sql", "20260617063018_even_silver_centurion"],
  ["0004_unique_lightspeed.sql", "20260619203544_unique_lightspeed"],
  ["0005_solid_ironclad.sql", "20260621173214_solid_ironclad"],
  ["0006_concerned_patch.sql", "20260621214839_concerned_patch"],
  ["0007_bright_tiger_shark.sql", "20260622011124_bright_tiger_shark"],
  ["0008_slimy_wither.sql", "20260622204519_slimy_wither"],
  ["0009_overjoyed_vargas.sql", "20260710034351_overjoyed_vargas"],
  ["0010_mysterious_the_liberteens.sql", "20260710040831_mysterious_the_liberteens"],
  ["0011_normalize_ccusage_model_labels.sql", "20260722183503_normalize_ccusage_model_labels"],
  ["0012_cli_login_device_code.sql", "20260922180853_cli_login_device_code"],
  ["0013_eager_whirlwind.sql", "20260922185239_eager_whirlwind"],
];

const PROBE_MIGRATION = "29991231235959_probe";

interface ExecutedSql {
  kind: "batch" | "query";
  sql: string;
}

interface BookkeepingRow {
  appliedAt: string;
  hash: string;
  name: string;
}

describe("D1 migrations config", () => {
  let database: DatabaseSync;
  let executed: ExecutedSql[];
  let scratchDir: string | undefined;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    executed = [];
    scratchDir = undefined;
  });

  afterEach(() => {
    database.close();
    if (scratchDir !== undefined) {
      rmSync(scratchDir, { force: true, recursive: true });
    }
  });

  it("points at the drizzle-kit v1 migration folders", () => {
    expect(migrations).toEqual({ dir: "./packages/db/migrations", table: "d1_migrations" });
    expect(readMigrations().map((migration) => migration.tag)).toEqual(
      expect.arrayContaining(LEGACY_MIGRATION_NAMES.map(([, current]) => current)),
    );
  });

  it("migrates an empty database from scratch", async () => {
    await runMigrations(migrationsDir);

    expect(writes()).toHaveLength(1 + readMigrations().length);
    expect(bookkeeping().map((row) => row.name)).toEqual(
      readMigrations().map((migration) => migration.tag),
    );
  });

  it("adopts prod's renamed history without re-running any migration", async () => {
    seedProdDatabase(LEGACY_MIGRATION_NAMES.map(([, current]) => current));

    await expect(runMigrations(migrationsDir)).resolves.toBeUndefined();

    const recorded = new Set(LEGACY_MIGRATION_NAMES.map(([, current]) => current));
    const pending = readMigrations().filter((migration) => !recorded.has(migration.tag));
    for (const migration of readMigrations()) {
      expect(executedStatementsOf(migration), migration.tag).toBe(
        recorded.has(migration.tag) ? 0 : 1,
      );
    }
    // One bookkeeping rebuild, then exactly one batch per pending migration.
    expect(writes()).toHaveLength(1 + pending.length);
    expect(bookkeeping()).toEqual(
      readMigrations().map((migration) => ({
        appliedAt: recorded.has(migration.tag)
          ? legacyAppliedAt(migration.tag)
          : expect.any(String),
        hash: sha256(readFileSync(join(migrationsDir, migration.tag, "migration.sql"), "utf8")),
        name: migration.tag,
      })),
    );
  });

  it("is a no-op on the next deploy", async () => {
    seedProdDatabase(LEGACY_MIGRATION_NAMES.map(([, current]) => current));
    await runMigrations(migrationsDir);
    const before = bookkeeping();
    executed = [];

    await runMigrations(migrationsDir);

    expect(writes()).toEqual([]);
    expect(bookkeeping()).toEqual(before);
  });

  it("applies a newly added migration on its own", async () => {
    seedProdDatabase(LEGACY_MIGRATION_NAMES.map(([, current]) => current));
    await runMigrations(migrationsDir);
    executed = [];
    const dir = copyMigrationsWithProbe();

    await runMigrations(dir);

    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toContain("CREATE TABLE `probe`");
    expect(writes()[0]).toContain(`'${PROBE_MIGRATION}'`);
    expect(bookkeeping().map((row) => row.name)).toEqual([
      ...readMigrations().map((migration) => migration.tag),
      PROBE_MIGRATION,
    ]);
  });

  it("refuses unrenamed legacy rows instead of re-running migrations", async () => {
    seedProdDatabase(LEGACY_MIGRATION_NAMES.map(([legacy]) => legacy));
    const before = legacyRows();

    const error = await Effect.runPromise(
      Effect.flip(applyWith(migrationsDir)).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(error._tag).toBe("MigrationHistoryConflictError");
    expect(error._tag === "MigrationHistoryConflictError" ? error.unmatched : []).toEqual(
      LEGACY_MIGRATION_NAMES.map(([legacy]) => legacy),
    );
    expect(writes()).toEqual([]);
    expect(legacyRows()).toEqual(before);
  });

  /**
   * Prod as of the v1 conversion: the schema through the last recorded
   * migration, plus the pre-registry `d1_migrations` table (TEXT ids) that
   * earlier deploys wrote.
   */
  function seedProdDatabase(names: ReadonlyArray<string>): void {
    const applied = new Set(LEGACY_MIGRATION_NAMES.map(([, current]) => current));
    for (const migration of readMigrations()) {
      if (applied.has(migration.tag)) {
        applyMigration(database, migration);
      }
    }
    database.exec(`
      CREATE TABLE d1_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const insert = database.prepare(
      "insert into d1_migrations (id, name, applied_at) values (?, ?, ?)",
    );
    names.forEach((name, index) => {
      insert.run(String(index + 1).padStart(5, "0"), name, legacyAppliedAtAt(index));
    });
  }

  function runMigrations(dir: string): Promise<void> {
    return Effect.runPromise(applyWith(dir).pipe(Effect.provide(NodeServices.layer)));
  }

  function applyWith(dir: string) {
    return alchemyApplyMigrations({
      executor: makeD1Executor(),
      resolved: { dir, table: migrations.table },
    });
  }

  /**
   * Mirrors alchemy's D1 HTTP executor (makeD1MigrationExecutor, not exported):
   * params inline as literals and a batch is one multi-statement query, which
   * D1 runs atomically.
   */
  function makeD1Executor(): SqlExecutor {
    return {
      batch: (statements) =>
        Effect.sync(() => {
          const sql = statements
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0)
            .map((statement) => (statement.endsWith(";") ? statement : `${statement};`))
            .join("\n");
          executed.push({ kind: "batch", sql });
          database.exec("BEGIN");
          try {
            database.exec(sql);
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        }),
      dialect: "sqlite",
      query: (sql, params) =>
        Effect.sync(() => {
          const inlined =
            params !== undefined && params.length > 0
              ? inlineSqlParams(sql, params, "sqlite")
              : sql;
          executed.push({ kind: "query", sql: inlined });
          return database.prepare(inlined).all() as Array<Record<string, unknown>>;
        }),
    };
  }

  function writes(): string[] {
    return executed.filter((call) => call.kind === "batch").map((call) => call.sql);
  }

  function executedStatementsOf(migration: Migration): number {
    return writes().filter((sql) =>
      migration.statements.every((statement) => sql.includes(statement)),
    ).length;
  }

  function bookkeeping(): BookkeepingRow[] {
    return database
      .prepare("select name, hash, applied_at as appliedAt from d1_migrations order by id")
      .all() as unknown as BookkeepingRow[];
  }

  function legacyRows(): unknown[] {
    return database.prepare("select id, name, applied_at from d1_migrations order by id").all();
  }

  function copyMigrationsWithProbe(): string {
    scratchDir = mkdtempSync(join(tmpdir(), "tokenmaxxing-migrations-"));
    cpSync(migrationsDir, scratchDir, { recursive: true });
    mkdirSync(join(scratchDir, PROBE_MIGRATION));
    writeFileSync(
      join(scratchDir, PROBE_MIGRATION, "migration.sql"),
      "CREATE TABLE `probe` (`id` text PRIMARY KEY NOT NULL);",
    );
    return scratchDir;
  }
});

function legacyAppliedAt(name: string): string {
  return legacyAppliedAtAt(LEGACY_MIGRATION_NAMES.findIndex(([, current]) => current === name));
}

function legacyAppliedAtAt(index: number): string {
  return `2026-09-01 00:00:${String(index).padStart(2, "0")}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
