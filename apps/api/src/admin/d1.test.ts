import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "../testing/sqlite-d1";
import { buildService } from "../testing/effect";
import { seedAccount, seedDevice, seedToken, seedUsage, seedUser } from "../testing/seed";
import { AdminRepositoryLive } from "./d1";
import { AdminRepository } from "./service";

describe("D1 listUserSnapshots", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
  });

  afterEach(() => database.close());

  it("assembles one snapshot per user, ordered by login", async () => {
    const { sqlite } = database;
    seedUser(sqlite, {
      avatarUrl: "a.png",
      createdAt: 1_000,
      id: "u-zed",
      login: "zed",
      name: "Zed",
    });
    seedUser(sqlite, {
      createdAt: 2_000,
      id: "u-amy",
      login: "amy",
      shadowBannedAt: 3_000,
      shadowBannedByUserId: "u-zed",
    });
    seedAccount(sqlite, {
      email: "zed@example.com",
      emailVerified: true,
      provider: "google",
      providerAccountId: "zed-google",
      userId: "u-zed",
    });
    seedAccount(sqlite, { providerAccountId: "zed-github", userId: "u-zed" });
    seedDevice(sqlite, { createdAt: 4_000, id: "laptop", name: "Laptop", userId: "u-zed" });
    seedToken(sqlite, { deviceId: "laptop", id: "token", revokedAt: 5_000, userId: "u-zed" });
    seedUsage(sqlite, {
      costUsd: 1,
      date: "2026-07-01",
      deviceId: "laptop",
      source: "codex",
      totalTokens: 10,
      userId: "u-zed",
    });
    seedUsage(sqlite, {
      costUsd: 2,
      date: "2026-07-03",
      deviceId: "laptop",
      source: "claude",
      totalTokens: 20,
      userId: "u-zed",
    });
    seedUsage(sqlite, {
      costUsd: 4,
      date: "2026-07-02",
      deviceId: "desktop",
      source: "codex",
      totalTokens: 40,
      userId: "u-zed",
    });
    const repository = await buildService(
      AdminRepository,
      AdminRepositoryLive.pipe(Layer.provide(database.drizzleLayer)),
    );

    const snapshots = await Effect.runPromise(repository.listUserSnapshots());

    expect(snapshots.map((snapshot) => snapshot.user.login)).toEqual(["amy", "zed"]);
    const [amy, zed] = snapshots;
    expect(amy).toEqual({
      accounts: [],
      deviceUsage: [],
      devices: [],
      shadowBan: { at: new Date(3_000).toISOString(), byUserId: "u-zed" },
      sources: [],
      tokens: [],
      usage: { activeDays: 0, lastUsageDate: null, totalSpendUsd: 0, totalTokens: 0 },
      user: {
        avatarUrl: null,
        createdAt: new Date(2_000).toISOString(),
        id: "u-amy",
        login: "amy",
        name: null,
        updatedAt: new Date(2_000).toISOString(),
      },
    });
    expect(zed?.accounts).toEqual([
      { email: null, emailVerified: false, login: null, provider: "github" },
      { email: "zed@example.com", emailVerified: true, login: null, provider: "google" },
    ]);
    expect(zed?.devices).toEqual([
      expect.objectContaining({
        createdAt: new Date(4_000).toISOString(),
        id: "laptop",
        lastSyncAt: null,
        name: "Laptop",
        platform: "darwin",
      }),
    ]);
    expect(zed?.tokens).toEqual([
      { deviceId: "laptop", lastUsedAt: null, revokedAt: new Date(5_000).toISOString() },
    ]);
    expect(zed?.usage).toEqual({
      activeDays: 3,
      lastUsageDate: "2026-07-03",
      totalSpendUsd: 7,
      totalTokens: 70,
    });
    expect(zed?.sources).toEqual(["claude", "codex"]);
    expect(
      [...(zed?.deviceUsage ?? [])].sort((left, right) =>
        left.deviceId.localeCompare(right.deviceId),
      ),
    ).toEqual([
      {
        activeDays: 1,
        deviceId: "desktop",
        lastUsageDate: "2026-07-02",
        sources: ["codex"],
        totalSpendUsd: 4,
        totalTokens: 40,
      },
      {
        activeDays: 2,
        deviceId: "laptop",
        lastUsageDate: "2026-07-03",
        sources: ["claude", "codex"],
        totalSpendUsd: 3,
        totalTokens: 30,
      },
    ]);
    expect(zed?.shadowBan).toBeNull();
  });
});
