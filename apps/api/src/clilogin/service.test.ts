import type { DatabaseSync } from "node:sqlite";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hashCliToken, hashDeviceCode } from "../auth/crypto";
import type { AuthUser as CurrentUser } from "@tokenmaxxing/api-contract";
import { makeTestDatabase, type RunnableService } from "../testing/sqlite-d1";
import { CliLoginRepositoryLive } from "./d1";
import {
  CliLoginRepository,
  CliLoginService,
  cliLoginVerificationUri,
  LEGACY_LOGIN_SUNSET,
  LOGIN_REQUEST_TTL_MS,
  makeCliLoginService,
} from "./service";

type Service = RunnableService<typeof CliLoginService.Service>;

const alice: CurrentUser = { avatarUrl: null, id: "user_alice", login: "alice", name: null };
const mallory: CurrentUser = { avatarUrl: null, id: "user_mallory", login: "mallory", name: null };

const device = {
  deviceArch: "arm64",
  deviceId: "device_laptop",
  deviceName: "alice-laptop",
  devicePlatform: "darwin",
  deviceVersion: "1.2.3",
};

const NOW = new Date("2026-09-22T12:00:00.000Z");

let sqlite: DatabaseSync;
let service: Service;
let repository: RunnableService<typeof CliLoginRepository.Service>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  const database = makeTestDatabase();
  sqlite = database.sqlite;
  const repositoryLayer = CliLoginRepositoryLive.pipe(Layer.provide(database.drizzleLayer));
  repository = (await Effect.runPromise(
    Effect.gen(function* () {
      return yield* CliLoginRepository;
    }).pipe(Effect.provide(repositoryLayer)),
  )) as typeof repository;
  service = (await Effect.runPromise(
    makeCliLoginService().pipe(
      Effect.provide(CliLoginRepositoryLive.pipe(Layer.provide(database.drizzleLayer))),
    ),
  )) as Service;
  insertUser(alice);
  insertUser(mallory);
});

afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe("cliLoginVerificationUri", () => {
  it("points CLI login requests at the canonical login route", () => {
    expect(cliLoginVerificationUri("https://tokenmaxxing.example", "ABCD-1234")).toBe(
      "https://tokenmaxxing.example/login/cli?code=ABCD-1234",
    );
  });

  it("encodes the login code query parameter", () => {
    expect(cliLoginVerificationUri("https://tokenmaxxing.example", "ABCD 1234")).toBe(
      "https://tokenmaxxing.example/login/cli?code=ABCD%201234",
    );
  });
});

describe("CliLoginService.start", () => {
  it("returns a secret deviceCode and stores only its hash", async () => {
    const started = await start();

    expect(started.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.code).toBe(started.userCode);
    expect(started.verificationUri).toBe(
      `https://tokenmaxxing.example/login/cli?code=${started.userCode}`,
    );
    // The deviceCode never appears in the verification URL.
    expect(started.verificationUri).not.toContain(started.deviceCode);

    const rows = loginRequestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.device_code_hash).toBe(
      await Effect.runPromise(hashDeviceCode(started.deviceCode ?? "")),
    );
    expect(JSON.stringify(rows)).not.toContain(started.deviceCode);
  });

  it("starts legacy requests without a deviceCode before the sunset", async () => {
    const started = await Effect.runPromise(service.start(device, "https://tokenmaxxing.example"));

    expect(started.deviceCode).toBeUndefined();
    expect(loginRequestRows()[0]?.device_code_hash).toBeNull();
  });

  it("refuses legacy starts after the sunset", async () => {
    vi.setSystemTime(LEGACY_LOGIN_SUNSET);

    const error = await failure(service.start(device, "https://tokenmaxxing.example"));

    expect(error._tag).toBe("CliUpgradeRequired");
    expect(loginRequestRows()).toHaveLength(0);
  });
});

describe("CliLoginService approve + poll", () => {
  it("stays pending until a user approves", async () => {
    const started = await start();

    await expect(poll(started)).resolves.toEqual({ status: "pending" });
    expect(await Effect.runPromise(service.describe(started.userCode))).toMatchObject({
      deviceName: "alice-laptop",
      devicePlatform: "darwin",
      legacyClient: false,
      status: "pending",
    });
  });

  it("delivers a token to the deviceCode holder exactly once and stores only its hash", async () => {
    const started = await start();
    await Effect.runPromise(service.approve(alice, started.userCode));

    // Approve mints nothing: no token is parked anywhere before poll.
    expect(countRows("cli_tokens")).toBe(0);
    expect(loginRequestRows()[0]).toMatchObject({ status: "approved", user_id: alice.id });

    const result = await poll(started);
    if (result.status !== "complete") {
      throw new Error("expected a completed poll");
    }
    expect(result.user).toEqual(alice);
    expect(result.token).toMatch(/^tmx_/);

    const tokens = sqlite.prepare("SELECT * FROM cli_tokens").all();
    expect(tokens).toEqual([
      expect.objectContaining({
        device_id: device.deviceId,
        token_hash: await Effect.runPromise(hashCliToken(result.token)),
        user_id: alice.id,
      }),
    ]);
    expect(JSON.stringify(tokens)).not.toContain(result.token);
    expect(loginRequestRows()).toHaveLength(0);

    expect((await failure(pollEffect(started)))._tag).toBe("LoginCodeNotFound");
  });

  it("rejects a wrong deviceCode without consuming the approval", async () => {
    const started = await start();
    await Effect.runPromise(service.approve(alice, started.userCode));

    const error = await failure(service.poll({ deviceCode: "not-the-device-code" }));

    expect(error._tag).toBe("LoginCodeNotFound");
    expect(countRows("cli_tokens")).toBe(0);
    await expect(poll(started)).resolves.toMatchObject({ status: "complete" });
  });

  it("never hands a device-code request's token to someone polling with the user code", async () => {
    const started = await start();
    await Effect.runPromise(service.approve(alice, started.userCode));

    const error = await failure(service.poll({ code: started.userCode }));

    expect(error._tag).toBe("LoginCodeNotFound");
    expect(countRows("cli_tokens")).toBe(0);
    expect(loginRequestRows()[0]?.status).toBe("approved");
  });

  it("lets legacy requests poll by user code until the sunset", async () => {
    const started = await Effect.runPromise(service.start(device, "https://tokenmaxxing.example"));
    await Effect.runPromise(service.approve(alice, started.code));

    const result = await Effect.runPromise(service.poll({ code: started.code.toLowerCase() }));

    expect(result).toMatchObject({ status: "complete", user: alice });
    expect(countRows("cli_tokens")).toBe(1);
  });

  it("stops legacy polling at the sunset", async () => {
    vi.setSystemTime(new Date(LEGACY_LOGIN_SUNSET.getTime() - 60_000));
    const started = await Effect.runPromise(service.start(device, "https://tokenmaxxing.example"));
    await Effect.runPromise(service.approve(alice, started.code));
    vi.setSystemTime(LEGACY_LOGIN_SUNSET);

    const error = await failure(service.poll({ code: started.code }));

    expect(error._tag).toBe("LoginCodeNotFound");
    expect(countRows("cli_tokens")).toBe(0);
  });

  it("expires requests for approve and poll", async () => {
    const pending = await start();
    const approved = await start();
    await Effect.runPromise(service.approve(alice, approved.userCode));
    vi.setSystemTime(new Date(NOW.getTime() + LOGIN_REQUEST_TTL_MS + 1));

    expect((await failure(service.approve(alice, pending.userCode)))._tag).toBe("LoginCodeExpired");
    expect((await failure(pollEffect(approved)))._tag).toBe("LoginCodeExpired");
    expect(countRows("cli_tokens")).toBe(0);
    expect(loginRequestRows()).toHaveLength(0);
  });

  it("treats a repeated approve by the same user as a no-op and never mints twice", async () => {
    const started = await start();

    await Effect.runPromise(service.approve(alice, started.userCode));
    await expect(Effect.runPromise(service.approve(alice, started.userCode))).resolves.toEqual({
      deviceName: "alice-laptop",
    });
    const error = await failure(service.approve(mallory, started.userCode));

    expect(error._tag).toBe("LoginCodeNotFound");
    expect(loginRequestRows()[0]?.user_id).toBe(alice.id);
    await expect(poll(started)).resolves.toMatchObject({ status: "complete", user: alice });
    expect(countRows("cli_tokens")).toBe(1);
  });

  it("lets exactly one of two concurrent approvals win", async () => {
    const started = await start();

    const results = await Effect.runPromise(
      Effect.all(
        [alice, mallory].map((user) => service.approve(user, started.userCode).pipe(Effect.result)),
        { concurrency: "unbounded" },
      ),
    );

    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
  });

  it("delivers the token to exactly one of many concurrent polls", async () => {
    const started = await start();
    await Effect.runPromise(service.approve(alice, started.userCode));

    const results = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 5 }, () =>
          service.poll({ deviceCode: started.deviceCode ?? "" }).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      ),
    );

    const completed = results.filter(
      (result) => result._tag === "Success" && result.success.status === "complete",
    );
    expect(completed).toHaveLength(1);
    expect(countRows("cli_tokens")).toBe(1);
  });
});

describe("CliLoginService device ownership", () => {
  it("never reassigns another user's device or its usage history", async () => {
    insertDevice(device.deviceId, alice.id);
    insertUsage(device.deviceId, alice.id);

    // Mallory starts a login claiming Alice's device id and approves it.
    const started = await start();
    await Effect.runPromise(service.approve(mallory, started.userCode));
    const result = await poll(started);

    expect(result).toMatchObject({ status: "complete", user: mallory });
    expect(ownerOf(device.deviceId)).toBe(alice.id);
    expect(sqlite.prepare("SELECT DISTINCT user_id FROM usage_days").all()).toEqual([
      { user_id: alice.id },
    ]);
    expect(sqlite.prepare("SELECT DISTINCT user_id FROM usage_source_stats").all()).toEqual([
      { user_id: alice.id },
    ]);
    const [token] = sqlite.prepare("SELECT device_id, user_id FROM cli_tokens").all();
    expect(token?.user_id).toBe(mallory.id);
    expect(token?.device_id).not.toBe(device.deviceId);
    expect(ownerOf(String(token?.device_id))).toBe(mallory.id);
  });

  it("refuses at the database to bind a token to a device another user owns", async () => {
    // The race the service's ownership lookup cannot see: the device became
    // Alice's between resolving it and issuing Mallory's token.
    insertDevice(device.deviceId, alice.id);

    const issued = await Effect.runPromise(
      repository.issueCliToken({
        deviceArch: null,
        deviceId: device.deviceId,
        deviceName: "mallory-box",
        devicePlatform: "linux",
        deviceVersion: null,
        now: NOW,
        tokenHash: "sha256:mallory",
        tokenId: "token_mallory",
        userId: mallory.id,
      }),
    );

    expect(issued).toBe(false);
    expect(countRows("cli_tokens")).toBe(0);
    expect(sqlite.prepare("SELECT user_id, name FROM devices").all()).toEqual([
      { name: "alice-laptop", user_id: alice.id },
    ]);
  });

  it("maps repeat logins by the other user on the same machine to one device", async () => {
    insertDevice(device.deviceId, alice.id);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = await start();
      await Effect.runPromise(service.approve(mallory, started.userCode));
      await poll(started);
    }

    const deviceIds = sqlite
      .prepare("SELECT DISTINCT device_id FROM cli_tokens WHERE user_id = ?")
      .all(mallory.id);
    expect(deviceIds).toHaveLength(1);
  });

  it("keeps the client device id when the device is new or already the user's", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = await start();
      await Effect.runPromise(service.approve(alice, started.userCode));
      await poll(started);
    }

    expect(ownerOf(device.deviceId)).toBe(alice.id);
    expect(
      sqlite
        .prepare("SELECT DISTINCT device_id FROM cli_tokens")
        .all()
        .map((row) => row.device_id),
    ).toEqual([device.deviceId]);
  });
});

function start() {
  return Effect.runPromise(
    service.start({ ...device, flow: "device_code" }, "https://tokenmaxxing.example"),
  );
}

function pollEffect(started: { deviceCode?: string | undefined }) {
  return service.poll({ deviceCode: started.deviceCode ?? "" });
}

function poll(started: { deviceCode?: string | undefined }) {
  return Effect.runPromise(pollEffect(started));
}

function failure<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(Effect.flip(effect));
}

function loginRequestRows() {
  return sqlite.prepare("SELECT * FROM cli_login_requests").all();
}

function countRows(table: string): number {
  return Number(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count);
}

function ownerOf(deviceId: string) {
  return sqlite.prepare("SELECT user_id FROM devices WHERE id = ?").get(deviceId)?.user_id;
}

function insertUser(user: CurrentUser) {
  sqlite
    .prepare("INSERT INTO users (id, login, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(user.id, user.login, NOW.getTime(), NOW.getTime());
}

function insertDevice(deviceId: string, userId: string) {
  sqlite
    .prepare(
      "INSERT INTO devices (id, user_id, name, platform, created_at) VALUES (?, ?, 'alice-laptop', 'darwin', ?)",
    )
    .run(deviceId, userId, NOW.getTime());
}

function insertUsage(deviceId: string, userId: string) {
  sqlite
    .prepare(
      "INSERT INTO usage_days (device_id, user_id, date, source, model, synced_at) VALUES (?, ?, '2026-09-21', 'claude', 'opus', ?)",
    )
    .run(deviceId, userId, NOW.getTime());
  sqlite
    .prepare(
      "INSERT INTO usage_source_stats (device_id, user_id, source, synced_at) VALUES (?, ?, 'claude', ?)",
    )
    .run(deviceId, userId, NOW.getTime());
}
