import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0011_normalize_ccusage_model_labels.sql", import.meta.url),
  "utf8",
);

describe("normalize ccusage model labels migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE usage_days (
        device_id text NOT NULL,
        user_id text NOT NULL,
        date text NOT NULL,
        source text NOT NULL,
        model text NOT NULL,
        input_tokens integer DEFAULT 0 NOT NULL,
        output_tokens integer DEFAULT 0 NOT NULL,
        cache_creation_tokens integer DEFAULT 0 NOT NULL,
        cache_read_tokens integer DEFAULT 0 NOT NULL,
        total_tokens integer DEFAULT 0 NOT NULL,
        cost_usd real DEFAULT 0 NOT NULL,
        synced_at integer NOT NULL,
        PRIMARY KEY(device_id, date, source, model)
      );
      CREATE INDEX usage_days_user_date_idx ON usage_days (user_id, date);
      CREATE INDEX usage_days_date_idx ON usage_days (date);
    `);
  });

  afterEach(() => database.close());

  it("normalizes existing rows while preserving the latest daily snapshot", () => {
    insertUsage({ date: "2026-07-01", model: "[pi] gpt-5.5", totalTokens: 10 });
    insertUsage({ date: "2026-07-02", model: "[preview] gpt-5.5", totalTokens: 20 });
    insertUsage({ date: "2026-07-03", model: "[pi]   ", totalTokens: 30 });
    insertUsage({
      date: "2026-07-04",
      model: "[pi] gpt-5.5",
      syncedAt: 100,
      totalTokens: 100,
    });
    insertUsage({
      date: "2026-07-04",
      model: "gpt-5.5",
      syncedAt: 200,
      totalTokens: 200,
    });
    insertUsage({
      date: "2026-07-05",
      model: "deepseek-v4",
      syncedAt: 200,
      totalTokens: 500,
    });
    insertUsage({
      date: "2026-07-05",
      model: "[pi] deepseek-v4",
      syncedAt: 300,
      totalTokens: 30,
    });
    insertUsage({
      date: "2026-07-05",
      model: "[PI]deepseek-v4",
      syncedAt: 300,
      totalTokens: 40,
    });

    runMigration();

    expect(
      database
        .prepare(
          "select date, model, total_tokens as totalTokens, synced_at as syncedAt from usage_days order by date, model",
        )
        .all(),
    ).toEqual([
      { date: "2026-07-01", model: "gpt-5.5", syncedAt: 100, totalTokens: 10 },
      { date: "2026-07-02", model: "[preview] gpt-5.5", syncedAt: 100, totalTokens: 20 },
      { date: "2026-07-03", model: "[pi]   ", syncedAt: 100, totalTokens: 30 },
      { date: "2026-07-04", model: "gpt-5.5", syncedAt: 200, totalTokens: 200 },
      { date: "2026-07-05", model: "deepseek-v4", syncedAt: 300, totalTokens: 70 },
    ]);
    expect(
      database
        .prepare(
          `select
            input_tokens as inputTokens,
            output_tokens as outputTokens,
            cache_creation_tokens as cacheCreationTokens,
            cache_read_tokens as cacheReadTokens,
            cost_usd as costUsd
          from usage_days where date = '2026-07-05'`,
        )
        .get(),
    ).toEqual({
      cacheCreationTokens: 70,
      cacheReadTokens: 70,
      costUsd: 70,
      inputTokens: 70,
      outputTokens: 70,
    });
  });

  it("keeps the primary key and query indexes in place", () => {
    insertUsage({ date: "2026-07-01", model: "[pi] gpt-5.5", totalTokens: 10 });

    runMigration();

    const indexes = database
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'usage_days'")
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["usage_days_date_idx", "usage_days_user_date_idx"]),
    );
    expect(() => insertUsage({ date: "2026-07-01", model: "gpt-5.5", totalTokens: 20 })).toThrow();
  });

  function insertUsage({
    date,
    model,
    syncedAt = 100,
    totalTokens,
  }: {
    date: string;
    model: string;
    syncedAt?: number;
    totalTokens: number;
  }) {
    database
      .prepare(
        `insert into usage_days (
          device_id, user_id, date, source, model, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "device_123",
        "user_123",
        date,
        "pi",
        model,
        totalTokens,
        totalTokens,
        totalTokens,
        totalTokens,
        totalTokens,
        totalTokens,
        syncedAt,
      );
  }

  function runMigration() {
    for (const statement of migration.split("--> statement-breakpoint")) {
      database.exec(statement);
    }
  }
});
