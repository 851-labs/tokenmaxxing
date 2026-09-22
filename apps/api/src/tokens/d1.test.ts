import { Exit, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService, runTest, runTestExit } from "../testing/effect";
import { makeMemoryBucket, type MemoryBucket } from "../testing/r2";
import {
  seedDevice,
  seedRawBatch,
  seedSourceStats,
  seedToken,
  seedUsage,
  seedUser,
} from "../testing/seed";
import { isLastUsedStale, TokensRepositoryLive } from "./d1";
import { TokensRepository } from "./service";

const NOW = new Date(9_000);

describe("isLastUsedStale", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("refreshes a never-used token", () => {
    expect(isLastUsedStale(null, now)).toBe(true);
  });

  it("skips the write within the hour and refreshes after it", () => {
    expect(isLastUsedStale(new Date("2026-09-22T11:30:00.000Z"), now)).toBe(false);
    expect(isLastUsedStale(new Date("2026-09-22T11:00:00.000Z"), now)).toBe(true);
  });
});

describe("D1 deleteDevice", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    const { sqlite } = database;

    seedUser(sqlite, { id: "user" });
    seedUser(sqlite, { id: "other" });
    for (const [deviceId, userId] of [
      ["doomed", "user"],
      ["kept", "user"],
      ["foreign", "other"],
    ] as const) {
      seedDevice(sqlite, { id: deviceId, userId });
      seedUsage(sqlite, { date: "2026-07-01", deviceId, userId });
      seedSourceStats(sqlite, { deviceId, sessionCount: 1, source: "codex", userId });
      seedToken(sqlite, { deviceId, id: `${deviceId}-token`, userId });
      seedRawBatch(sqlite, {
        deviceId,
        id: `${deviceId}-raw`,
        objectKey: rawKey(deviceId),
        userId,
      });
    }
    seedToken(sqlite, { deviceId: "doomed", id: "doomed-old-token", revokedAt: 1, userId: "user" });
    seedRawBatch(sqlite, {
      deviceId: "doomed",
      id: "doomed-raw-2",
      objectKey: `${rawKey("doomed")}.2`,
      userId: "user",
    });
  });

  afterEach(() => database.close());

  async function makeRepository(bucket: MemoryBucket) {
    for (const row of database.sqlite
      .prepare("select object_key as objectKey from usage_raw_batches")
      .all()) {
      bucket.objects.set(String(row.objectKey), { customMetadata: undefined, value: "{}" });
    }

    return buildService(
      TokensRepository,
      TokensRepositoryLive.pipe(Layer.provide(Layer.merge(database.drizzleLayer, bucket.layer))),
    );
  }

  it("removes the device's rows and raw objects and revokes its tokens", async () => {
    const bucket = makeMemoryBucket();
    const repository = await makeRepository(bucket);

    const deleted = await runTest(repository.deleteDevice("user", "doomed", NOW));

    expect(deleted).toBe(true);
    expect(deviceIds("devices")).toEqual(["foreign", "kept"]);
    expect(deviceIds("usage_days")).toEqual(["foreign", "kept"]);
    expect(deviceIds("usage_source_stats")).toEqual(["foreign", "kept"]);
    expect(deviceIds("usage_raw_batches")).toEqual(["foreign", "kept"]);
    expect([...bucket.objects.keys()].sort()).toEqual([rawKey("foreign"), rawKey("kept")]);
    expect(tokens()).toEqual([
      { id: "doomed-old-token", revokedAt: 1 },
      { id: "doomed-token", revokedAt: NOW.getTime() },
      { id: "foreign-token", revokedAt: null },
      { id: "kept-token", revokedAt: null },
    ]);
  });

  it("touches nothing of a device owned by someone else", async () => {
    const bucket = makeMemoryBucket();
    const repository = await makeRepository(bucket);

    const deleted = await runTest(repository.deleteDevice("user", "foreign", NOW));

    expect(deleted).toBe(false);
    expect(deviceIds("devices")).toEqual(["doomed", "foreign", "kept"]);
    expect(deviceIds("usage_raw_batches")).toEqual(["doomed", "doomed", "foreign", "kept"]);
    expect(bucket.objects.has(rawKey("foreign"))).toBe(true);
    expect(tokens().find((token) => token.id === "foreign-token")?.revokedAt).toBeNull();
  });

  it("leaves every row in place when object deletion fails, so a retry completes", async () => {
    const bucket = makeMemoryBucket();
    const repository = await makeRepository(bucket);
    bucket.setDeleteFailure(new Error("r2 down"));

    const exit = await runTestExit(repository.deleteDevice("user", "doomed", NOW));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(deviceIds("devices")).toEqual(["doomed", "foreign", "kept"]);
    expect(deviceIds("usage_raw_batches")).toEqual(["doomed", "doomed", "foreign", "kept"]);

    bucket.setDeleteFailure(null);
    expect(await runTest(repository.deleteDevice("user", "doomed", NOW))).toBe(true);
    expect(deviceIds("usage_raw_batches")).toEqual(["foreign", "kept"]);
    expect(bucket.objects.has(rawKey("doomed"))).toBe(false);
  });

  it("deletes the object of a raw report ingested while the delete was running", async () => {
    let raced = false;
    const bucket = makeMemoryBucket({
      onDelete: () => {
        if (raced) {
          return;
        }
        raced = true;
        seedRawBatch(database.sqlite, {
          deviceId: "doomed",
          id: "doomed-raw-late",
          objectKey: `${rawKey("doomed")}.late`,
          userId: "user",
        });
        bucket.objects.set(`${rawKey("doomed")}.late`, { customMetadata: undefined, value: "{}" });
      },
    });
    const repository = await makeRepository(bucket);

    await runTest(repository.deleteDevice("user", "doomed", NOW));

    expect(deviceIds("usage_raw_batches")).toEqual(["foreign", "kept"]);
    expect(bucket.deletes.at(-1)).toEqual([`${rawKey("doomed")}.late`]);
    expect([...bucket.objects.keys()].sort()).toEqual([rawKey("foreign"), rawKey("kept")]);
  });

  it("finds the device's raw reports through an index", async () => {
    const repository = await makeRepository(makeMemoryBucket());

    await runTest(repository.deleteDevice("user", "doomed", NOW));

    expect(database.tableScans("usage_raw_batches")).toEqual([]);
  });

  function deviceIds(table: string): string[] {
    const column = table === "devices" ? "id" : "device_id";

    return database.sqlite
      .prepare(`select ${column} as deviceId from ${table} order by ${column}`)
      .all()
      .map((row) => String(row.deviceId));
  }

  function tokens() {
    return database.sqlite
      .prepare("select id, revoked_at as revokedAt from cli_tokens order by id")
      .all();
  }
});

function rawKey(deviceId: string): string {
  return `users/owner/devices/${deviceId}/ccusage/codex/daily/hash.json`;
}
