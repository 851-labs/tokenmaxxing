import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { applyMigrations } from "@tokenmaxxing/db/migrations";
import { Effect, Layer } from "effect";

import { Drizzle } from "../database";

/**
 * Shared D1 test harness: an in-memory node:sqlite database migrated with
 * the real packages/db migrations (journal order), wrapped in the subset of
 * the D1 binding drizzle-orm/d1 calls — prepare/bind/all/raw/run/first and
 * an atomic batch — so repository tests run the real query-builder SQL
 * (including `RETURNING` and `db.batch`) against the real schema. Foreign
 * keys stay on, matching D1.
 */

/** A service with its `any` requirements erased so tests can runPromise it
 * directly (the repositories are already provided). */
type RunnableService<S> = {
  [K in keyof S]: S[K] extends (...args: infer Args) => Effect.Effect<infer A, infer E, any>
    ? (...args: Args) => Effect.Effect<A, E>
    : S[K];
};

interface TestDatabase {
  readonly d1: D1Database;
  readonly drizzleLayer: Layer.Layer<Drizzle>;
  readonly sqlite: DatabaseSync;
  close(): void;
}

/** `before` stops ahead of the named migration tag. */
function makeTestDatabase(options: { before?: string } = {}): TestDatabase {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  applyMigrations(sqlite, options);
  const d1 = makeD1Database(sqlite);

  return {
    close: () => sqlite.close(),
    d1,
    drizzleLayer: Drizzle.layer({ raw: Effect.succeed(d1) }),
    sqlite,
  };
}

function makeD1Database(sqlite: DatabaseSync): D1Database {
  return {
    /** D1 batches run as one implicit transaction. */
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("begin");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.all());
        }
        sqlite.exec("commit");
        return results;
      } catch (error) {
        sqlite.exec("rollback");
        throw error;
      }
    },
    exec: async (query: string) => {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
    prepare: (query: string) => makeD1Statement(sqlite, query),
  } as unknown as D1Database;
}

function makeD1Statement(
  sqlite: DatabaseSync,
  query: string,
  parameters: SQLInputValue[] = [],
): D1PreparedStatement {
  return {
    all: async () => {
      const results = sqlite.prepare(query).all(...parameters);
      return { meta: { changes: results.length }, results, success: true };
    },
    bind: (...values: unknown[]) => makeD1Statement(sqlite, query, values.map(toSqlValue)),
    first: async () => sqlite.prepare(query).get(...parameters) ?? null,
    // Positional arrays, not Object.values: joined tables share column
    // names, which would collapse in row objects.
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...parameters);
    },
    run: async () => {
      const result = sqlite.prepare(query).run(...parameters);
      return {
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        results: [],
        success: true,
      };
    },
  } as unknown as D1PreparedStatement;
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

export { makeD1Database, makeTestDatabase };

export type { RunnableService, TestDatabase };
