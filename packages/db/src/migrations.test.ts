import { DatabaseSync } from "node:sqlite";

import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { applyMigrations, readMigrations } from "./migrations";
import * as schema from "./schema/index";

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

const tables = Object.values(schema).map((table) => getTableConfig(table as SQLiteTable));

describe("migrations", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
  });

  afterEach(() => database.close());

  it("reads every migration in folder order", () => {
    const tags = readMigrations().map((migration) => migration.tag);

    expect(tags[0]).toBe("20260612221145_charming_morgan_stark");
    expect(tags).toEqual([...tags].sort());
    expect(tags).toContain("20260922190224_rehome_usage_raw_batches");
  });

  it("produces exactly the tables the drizzle schema declares", () => {
    const migrated = database
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
      .map((row) => row.name);

    expect(migrated).toEqual(tables.map((table) => table.name).sort());
  });

  it.each(tables.map((table) => [table.name, table] as const))(
    "matches the drizzle columns of %s",
    (name, table) => {
      const migrated = (
        database.prepare(`pragma table_info(${name})`).all() as unknown as ColumnInfo[]
      ).map((column) => ({
        name: column.name,
        notNull: column.notnull === 1,
        primaryKey: column.pk > 0,
      }));
      const compositeKey = new Set(
        table.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
      );
      const declared = table.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
        primaryKey: column.primary || compositeKey.has(column.name),
      }));

      expect(sortByName(migrated)).toEqual(sortByName(declared));
    },
  );
});

function sortByName<A extends { name: string }>(values: A[]): A[] {
  return [...values].sort((left, right) => left.name.localeCompare(right.name));
}
