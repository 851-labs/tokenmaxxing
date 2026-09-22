import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import type { Layer } from "effect";

import { Drizzle } from "../database";

/**
 * Test-only D1 stand-in over node:sqlite with every drizzle migration
 * applied, so repository tests run the real D1 query builder SQL (including
 * `RETURNING` and `db.batch`) against the real schema. Implements just the
 * D1 surface drizzle-orm/d1 calls: prepare/bind/all/raw/run and batch.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations/", import.meta.url).href,
);

/** A service with its `any` requirements erased so tests can runPromise it
 * directly (the repositories are already provided). */
type RunnableService<S> = {
  [K in keyof S]: S[K] extends (...args: infer Args) => Effect.Effect<infer A, infer E, any>
    ? (...args: Args) => Effect.Effect<A, E>
    : S[K];
};

interface TestDatabase {
  drizzleLayer: Layer.Layer<Drizzle>;
  sqlite: DatabaseSync;
}

function makeTestDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const migration = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") {
        sqlite.exec(statement);
      }
    }
  }

  const d1 = new SqliteD1(sqlite) as unknown as D1Database;

  return {
    drizzleLayer: Drizzle.layer({ raw: Effect.succeed(d1) }),
    sqlite,
  };
}

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query, []);
  }

  /** D1 batches run as one implicit transaction. */
  async batch(statements: SqliteD1Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.allSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (cause) {
      this.sqlite.exec("ROLLBACK");
      throw cause;
    }
  }
}

class SqliteD1Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly query: string,
    private readonly params: SQLInputValue[],
  ) {}

  bind(...params: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, this.query, params.map(toSqlValue));
  }

  allSync() {
    const results = this.sqlite.prepare(this.query).all(...this.params);
    return { meta: { changes: results.length }, results, success: true };
  }

  async all() {
    return this.allSync();
  }

  async raw() {
    return this.allSync().results.map((row) => Object.values(row));
  }

  async run() {
    const result = this.sqlite.prepare(this.query).run(...this.params);
    return { meta: { changes: Number(result.changes) }, results: [], success: true };
  }
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value as SQLInputValue;
}

export { makeTestDatabase };

export type { RunnableService, TestDatabase };
