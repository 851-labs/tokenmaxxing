import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Drizzle } from "../database";
import { UsageRepositoryLive } from "./d1";
import { RawUsageObjectStore } from "./raw-store";
import { UsageRepository } from "./service";

describe("D1 usage replacement", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      create table usage_days (
        device_id text not null,
        user_id text not null,
        date text not null,
        source text not null,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_creation_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        total_tokens integer not null default 0,
        cost_usd real not null default 0,
        synced_at integer not null,
        primary key (device_id, date, source, model)
      );
    `);
  });

  afterEach(() => sqlite.close());

  it("prunes only older models omitted from covered device/day/source slices", async () => {
    const insertUsage = sqlite.prepare(
      `insert into usage_days (
        device_id, user_id, date, source, model, synced_at
      ) values (?, 'user', ?, ?, ?, ?)`,
    );
    insertUsage.run("device", "2026-07-21", "codex", "keep", 500);
    insertUsage.run("device", "2026-07-21", "codex", "stale", 500);
    insertUsage.run("device", "2026-07-21", "codex", "newer", 1_500);
    insertUsage.run("device", "2026-07-21", "claude", "other-source", 500);
    insertUsage.run("device", "2026-07-20", "codex", "other-date", 500);
    insertUsage.run("other-device", "2026-07-21", "codex", "other-device", 500);

    const repository = await makeRepository(sqlite);
    await run(
      repository.pruneChunk(
        "device",
        [{ date: "2026-07-21", models: ["keep"], source: "codex" }],
        new Date(1_000),
      ),
    );

    expect(
      sqlite
        .prepare(
          `select device_id, date, source, model
           from usage_days
           order by device_id, date, source, model`,
        )
        .all(),
    ).toEqual([
      {
        date: "2026-07-20",
        device_id: "device",
        model: "other-date",
        source: "codex",
      },
      {
        date: "2026-07-21",
        device_id: "device",
        model: "other-source",
        source: "claude",
      },
      {
        date: "2026-07-21",
        device_id: "device",
        model: "keep",
        source: "codex",
      },
      {
        date: "2026-07-21",
        device_id: "device",
        model: "newer",
        source: "codex",
      },
      {
        date: "2026-07-21",
        device_id: "other-device",
        model: "other-device",
        source: "codex",
      },
    ]);
  });

  it("removes all older rows when a covered slice contains no models", async () => {
    sqlite.exec(`
      insert into usage_days (
        device_id, user_id, date, source, model, synced_at
      ) values
        ('device', 'user', '2026-07-21', 'codex', 'stale-a', 500),
        ('device', 'user', '2026-07-21', 'codex', 'stale-b', 500);
    `);

    const repository = await makeRepository(sqlite);
    await run(
      repository.pruneChunk(
        "device",
        [{ date: "2026-07-21", models: [], source: "codex" }],
        new Date(1_000),
      ),
    );

    expect(sqlite.prepare("select model from usage_days").all()).toEqual([]);
  });
});

async function makeRepository(sqlite: DatabaseSync) {
  const drizzleLayer = Drizzle.layer({ raw: Effect.succeed(d1Database(sqlite)) });
  const rawStoreLayer = Layer.succeed(
    RawUsageObjectStore,
    RawUsageObjectStore.of({
      putObject: () => Effect.succeed(undefined),
    }),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* UsageRepository;
    }).pipe(
      Effect.provide(
        UsageRepositoryLive.pipe(Layer.provide(Layer.merge(drizzleLayer, rawStoreLayer))),
      ),
    ),
  );
}

function run<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}

function d1Database(sqlite: DatabaseSync): D1Database {
  return {
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
    prepare: (query: string) => d1Statement(sqlite, query),
  } as unknown as D1Database;
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  parameters: SQLInputValue[] = [],
): D1PreparedStatement {
  return {
    all: async () => ({ results: sqlite.prepare(query).all(...parameters) }),
    bind: (...values: unknown[]) => d1Statement(sqlite, query, values as SQLInputValue[]),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...parameters);
    },
    run: async () => sqlite.prepare(query).run(...parameters),
  } as unknown as D1PreparedStatement;
}
