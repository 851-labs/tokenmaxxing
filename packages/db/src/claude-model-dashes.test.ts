import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { applyMigration, applyMigrations, readMigration } from "./migrations";

const MIGRATION_TAG = "20261104220909_claude_model_dashes";

describe("claude model dashes migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database, { before: MIGRATION_TAG });
  });

  afterEach(() => database.close());

  it("renames dotted Claude versions to their dashed API ids", () => {
    insertUsage({ date: "2026-10-01", model: "claude-opus-5.5", totalTokens: 10 });
    insertUsage({ date: "2026-10-01", model: "claude-3.5-sonnet", totalTokens: 20 });
    insertUsage({ date: "2026-10-02", model: "Claude-Haiku-4.5", totalTokens: 30 });

    runMigration();

    expect(models()).toEqual([
      { date: "2026-10-01", model: "claude-3-5-sonnet", totalTokens: 20 },
      { date: "2026-10-01", model: "claude-opus-5-5", totalTokens: 10 },
      { date: "2026-10-02", model: "Claude-Haiku-4-5", totalTokens: 30 },
    ]);
  });

  it("sums both spellings of one model synced together for a day", () => {
    insertUsage({
      countedBy: "ccusage-v20-raw-6",
      date: "2026-10-01",
      model: "claude-opus-5.5",
      totalTokens: 10,
    });
    insertUsage({
      countedBy: "ccusage-v20-raw-6",
      date: "2026-10-01",
      model: "claude-opus-5-5",
      totalTokens: 90,
    });
    insertUsage({ date: "2026-10-02", model: "claude-sonnet-4.6", totalTokens: 5 });
    insertUsage({
      countedBy: "ccusage-v20-raw-6",
      date: "2026-10-02",
      model: "claude-sonnet-4-6",
      totalTokens: 7,
    });

    runMigration();

    expect(models()).toEqual([
      { date: "2026-10-01", model: "claude-opus-5-5", totalTokens: 100 },
      { date: "2026-10-02", model: "claude-sonnet-4-6", totalTokens: 12 },
    ]);
    expect(
      database
        .prepare(
          `select
            input_tokens as inputTokens,
            output_tokens as outputTokens,
            cache_creation_tokens as cacheCreationTokens,
            cache_read_tokens as cacheReadTokens,
            cost_usd as costUsd,
            counted_by as countedBy
          from usage_days order by date`,
        )
        .all(),
    ).toEqual([
      {
        cacheCreationTokens: 100,
        cacheReadTokens: 100,
        costUsd: 100,
        countedBy: "ccusage-v20-raw-6",
        inputTokens: 100,
        outputTokens: 100,
      },
      // Rows that disagree on their parser lose it, so the next sync replaces them.
      {
        cacheCreationTokens: 12,
        cacheReadTokens: 12,
        costUsd: 12,
        countedBy: null,
        inputTokens: 12,
        outputTokens: 12,
      },
    ]);
  });

  it("leaves other models' dots and every other row alone", () => {
    insertUsage({ date: "2026-10-01", model: "gpt-5.5", totalTokens: 1 });
    insertUsage({ date: "2026-10-01", model: "anthropic/claude-opus-5.5", totalTokens: 2 });
    insertUsage({ date: "2026-10-01", model: "claude-opus-5-5", totalTokens: 3 });
    insertUsage({ date: "2026-10-02", model: "claude-opus-5-5", totalTokens: 4 });

    runMigration();

    expect(models()).toEqual([
      { date: "2026-10-01", model: "anthropic/claude-opus-5.5", totalTokens: 2 },
      { date: "2026-10-01", model: "claude-opus-5-5", totalTokens: 3 },
      { date: "2026-10-01", model: "gpt-5.5", totalTokens: 1 },
      { date: "2026-10-02", model: "claude-opus-5-5", totalTokens: 4 },
    ]);
  });

  it("keeps the primary key in place", () => {
    insertUsage({ date: "2026-10-01", model: "claude-opus-5.5", totalTokens: 10 });

    runMigration();

    expect(() =>
      insertUsage({ date: "2026-10-01", model: "claude-opus-5-5", totalTokens: 20 }),
    ).toThrow();
  });

  function models() {
    return database
      .prepare(
        "select date, model, total_tokens as totalTokens from usage_days order by date, model",
      )
      .all();
  }

  function insertUsage({
    countedBy = null,
    date,
    model,
    totalTokens,
  }: {
    countedBy?: string | null;
    date: string;
    model: string;
    totalTokens: number;
  }) {
    database
      .prepare(
        `insert into usage_days (
          device_id, user_id, date, source, model, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, synced_at, counted_by
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "device_123",
        "user_123",
        date,
        "opencode",
        model,
        totalTokens,
        totalTokens,
        totalTokens,
        totalTokens,
        totalTokens,
        totalTokens,
        100,
        countedBy,
      );
  }

  function runMigration() {
    applyMigration(database, readMigration(MIGRATION_TAG));
  }
});
