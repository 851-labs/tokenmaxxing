import { Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import {
  countRowsByUser,
  seedAccount,
  seedDevice,
  seedLoginRequest,
  seedRawBatch,
  seedSession,
  seedSourceStats,
  seedToken,
  seedUsage,
  seedUser,
} from "../testing/seed";
import { AuthRepositoryLive, mergedShadowBan } from "./d1";
import { AuthRepository } from "./service";

const visible = {
  shadowBannedAt: null,
  shadowBannedByUserId: null,
};

const banned = {
  shadowBannedAt: new Date("2026-07-09T20:00:00.000Z"),
  shadowBannedByUserId: "admin_123",
};

describe("mergedShadowBan", () => {
  it("propagates a source account ban to a visible target", () => {
    expect(mergedShadowBan(banned, visible)).toEqual(banned);
  });

  it("keeps an existing target ban", () => {
    expect(mergedShadowBan(visible, banned)).toEqual(banned);
  });

  it("keeps two visible accounts visible", () => {
    expect(mergedShadowBan(visible, visible)).toEqual(visible);
  });
});

describe("D1 mergeUsers", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
    const { sqlite } = database;

    seedUser(sqlite, { avatarUrl: "source.png", id: "source", name: "Source Name" });
    seedUser(sqlite, { id: "target", name: null });
    seedUser(sqlite, { id: "bystander" });

    seedAccount(sqlite, { providerAccountId: "source-github", userId: "source" });
    seedAccount(sqlite, {
      provider: "google",
      providerAccountId: "source-google",
      userId: "source",
    });
    seedAccount(sqlite, { providerAccountId: "target-github", userId: "target" });
    seedSession(sqlite, "source-session", "source");
    seedLoginRequest(sqlite, "source-login", "source");
    seedDevice(sqlite, { id: "source-device", userId: "source" });
    seedToken(sqlite, { deviceId: "source-device", id: "source-token", userId: "source" });
    seedUsage(sqlite, { date: "2026-07-01", deviceId: "source-device", userId: "source" });
    seedSourceStats(sqlite, {
      deviceId: "source-device",
      sessionCount: 3,
      source: "codex",
      userId: "source",
    });
    seedRawBatch(sqlite, {
      deviceId: "source-device",
      id: "source-raw",
      objectKey: "users/source/devices/source-device/ccusage/codex/daily/a.json",
      userId: "source",
    });

    seedDevice(sqlite, { id: "bystander-device", userId: "bystander" });
    seedUsage(sqlite, { date: "2026-07-01", deviceId: "bystander-device", userId: "bystander" });
  });

  afterEach(() => database.close());

  function makeRepository() {
    return buildService(
      AuthRepository,
      AuthRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );
  }

  it("moves every user-owned row to the target and deletes the source", async () => {
    const before = countRowsByUser(database.sqlite, "source");
    const repository = await makeRepository();

    const merged = await Effect.runPromise(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "target" }),
    );

    expect(merged).toEqual({
      avatarUrl: "source.png",
      id: "target",
      login: "target",
      name: "Source Name",
    });
    expect(Object.values(before).every((count) => count > 0)).toBe(true);
    expect(countRowsByUser(database.sqlite, "source")).toEqual(mapValues(before, () => 0));
    expect(countRowsByUser(database.sqlite, "target")).toEqual(
      mapValues(before, (count, table) => count + (table === "user_accounts" ? 1 : 0)),
    );
    expect(countRowsByUser(database.sqlite, "bystander")).toMatchObject({
      devices: 1,
      usage_days: 1,
    });
    expect(
      database.sqlite
        .prepare("select id from users order by id")
        .all()
        .map((row) => row.id),
    ).toEqual(["bystander", "target"]);
    expect(
      database.sqlite.prepare("select object_key as objectKey from usage_raw_batches").get(),
    ).toEqual({ objectKey: "users/source/devices/source-device/ccusage/codex/daily/a.json" });
  });

  it("re-homes raw reports through an index", async () => {
    const repository = await makeRepository();

    await Effect.runPromise(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "target" }),
    );

    expect(database.tableScans("usage_raw_batches")).toEqual([]);
  });

  it("carries a source shadow ban onto the target", async () => {
    database.sqlite
      .prepare(
        "update users set shadow_banned_at = 5, shadow_banned_by_user_id = 'admin' where id = 'source'",
      )
      .run();
    const repository = await makeRepository();

    await Effect.runPromise(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "target" }),
    );

    expect(
      database.sqlite
        .prepare(
          "select shadow_banned_at as at, shadow_banned_by_user_id as byUserId from users where id = 'target'",
        )
        .get(),
    ).toEqual({ at: 5, byUserId: "admin" });
  });

  it("moves nothing when any statement in the batch fails", async () => {
    const before = countRowsByUser(database.sqlite, "source");
    database.sqlite.exec(`
      create trigger fail_device_move before update on devices
      begin select raise(abort, 'boom'); end;
    `);
    const repository = await makeRepository();

    const exit = await Effect.runPromiseExit(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "target" }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(countRowsByUser(database.sqlite, "source")).toEqual(before);
  });

  it("returns the user unchanged when merging into itself", async () => {
    const before = countRowsByUser(database.sqlite, "source");
    const repository = await makeRepository();

    const merged = await Effect.runPromise(
      repository.mergeUsers({ sourceUserId: "source", targetUserId: "source" }),
    );

    expect(merged.id).toBe("source");
    expect(countRowsByUser(database.sqlite, "source")).toEqual(before);
  });
});

function mapValues(
  record: Record<string, number>,
  map: (value: number, key: string) => number,
): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value, key)]));
}
