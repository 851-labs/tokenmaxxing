import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { applyMigration, applyMigrations, readMigration } from "./migrations";

const MIGRATION_TAG = "0014_rehome_usage_raw_batches";

describe("rehome usage raw batches migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database, { before: MIGRATION_TAG });
    database.exec(`
      insert into users (id, login, created_at, updated_at) values
        ('old-owner', 'old-owner', 0, 0),
        ('new-owner', 'new-owner', 0, 0);
      insert into devices (id, user_id, name, platform, created_at) values
        ('moved-device', 'new-owner', 'laptop', 'darwin', 0),
        ('kept-device', 'old-owner', 'desktop', 'linux', 0);
    `);
  });

  afterEach(() => database.close());

  it("moves raw batches to their device's current owner", () => {
    insertRawBatch("moved", "old-owner", "moved-device");
    insertRawBatch("kept", "old-owner", "kept-device");
    insertRawBatch("orphaned", "merged-away", "deleted-device");

    applyMigration(database, readMigration(MIGRATION_TAG));

    expect(
      database
        .prepare(
          "select id, user_id as userId, object_key as objectKey from usage_raw_batches order by id",
        )
        .all(),
    ).toEqual([
      { id: "kept", objectKey: "objects/kept", userId: "old-owner" },
      { id: "moved", objectKey: "objects/moved", userId: "new-owner" },
      { id: "orphaned", objectKey: "objects/orphaned", userId: "merged-away" },
    ]);
  });

  function insertRawBatch(id: string, userId: string, deviceId: string) {
    database
      .prepare(
        `insert into usage_raw_batches (
          id, user_id, device_id, source, report_kind, ccusage_command, payload_hash,
          object_key, payload_bytes, captured_at, processed_at, parser_version
        ) values (?, ?, ?, 'codex', 'daily', 'ccusage codex daily', ?, ?, 2, 0, 0, 'v1')`,
      )
      .run(id, userId, deviceId, `hash-${id}`, `objects/${id}`);
  }
});
