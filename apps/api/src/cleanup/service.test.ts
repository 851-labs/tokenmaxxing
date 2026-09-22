import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type RunnableService } from "../testing/sqlite-d1";
import { CleanupRepositoryLive } from "./d1";
import { CleanupService, makeCleanupService } from "./service";

const NOW = new Date("2026-09-22T12:00:00.000Z");

describe("CleanupService.purgeExpired", () => {
  it("deletes expired sessions and CLI login requests and keeps live ones", async () => {
    const { drizzleLayer, sqlite } = makeTestDatabase();
    const cleanup = (await Effect.runPromise(
      makeCleanupService().pipe(
        Effect.provide(CleanupRepositoryLive.pipe(Layer.provide(drizzleLayer))),
      ),
    )) as RunnableService<typeof CleanupService.Service>;
    sqlite
      .prepare("INSERT INTO users (id, login, created_at, updated_at) VALUES ('u', 'u', 0, 0)")
      .run();
    const insertSession = sqlite.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'u', ?, 0)",
    );
    const insertRequest = sqlite.prepare(
      "INSERT INTO cli_login_requests (id, code, device_id, device_name, device_platform, expires_at, created_at) VALUES (?, ?, 'd', 'd', 'darwin', ?, 0)",
    );
    insertSession.run("session_expired", NOW.getTime() - 1);
    insertSession.run("session_live", NOW.getTime() + 60_000);
    insertRequest.run("request_expired", "AAAA-AAAA", NOW.getTime());
    insertRequest.run("request_live", "BBBB-BBBB", NOW.getTime() + 60_000);

    await expect(Effect.runPromise(cleanup.purgeExpired(NOW))).resolves.toEqual({
      cliLoginRequests: 1,
      sessions: 1,
    });
    expect(sqlite.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session_live" }]);
    expect(sqlite.prepare("SELECT id FROM cli_login_requests").all()).toEqual([
      { id: "request_live" },
    ]);
    sqlite.close();
  });
});
