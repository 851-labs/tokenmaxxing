import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CleanupApiError,
  CleanupConfigurationError,
  CleanupVerificationError,
  encodeObjectKey,
  executeCleanup,
  makeCleanupApi,
  parseCleanupOptions,
  safeErrorMessage,
  type CleanupApi,
  type CleanupLogEvent,
  type R2SessionObject,
} from "./purge-raw-session-reports";

const databaseName = "tokenmaxxing-prod";
const databaseId = "database-id";

interface FakeState {
  events: string[];
  failR2Key?: string | undefined;
  r2Objects: R2SessionObject[];
  rows: Array<{ id: string; objectKey: string }>;
}

function sessionKey(suffix: string): string {
  return `users/user-secret/devices/device-secret/ccusage/codex/session/${suffix}.json`;
}

function makeState(count = 1): FakeState {
  return {
    events: [],
    r2Objects: Array.from({ length: count }, (_, index) => ({
      key: sessionKey(`hash-${index}`),
      size: 100 + index,
    })),
    rows: Array.from({ length: count }, (_, index) => ({
      id: `private-row-${index}`,
      objectKey: sessionKey(`hash-${index}`),
    })),
  };
}

function makeFakeApi(state: FakeState): CleanupApi {
  return {
    deleteR2Object: (objectKey) => {
      state.events.push("r2-delete");
      if (state.failR2Key === objectKey) {
        return Effect.fail(new CleanupApiError({ operation: "delete R2 object", status: 500 }));
      }
      const index = state.r2Objects.findIndex((object) => object.key === objectKey);
      if (index === -1) {
        return Effect.succeed("missing");
      }
      state.r2Objects.splice(index, 1);
      return Effect.succeed("deleted");
    },
    listDatabases: () => {
      state.events.push("database-list");
      return Effect.succeed([{ name: databaseName, uuid: databaseId }]);
    },
    listR2SessionObjects: () => {
      state.events.push("r2-list");
      return Effect.succeed([...state.r2Objects]);
    },
    queryD1: (_databaseId, sql, params = []) => {
      if (sql.includes("GROUP BY source")) {
        state.events.push("d1-source-inventory");
        return Effect.succeed({
          rows:
            state.rows.length === 0
              ? []
              : [
                  {
                    affected_users: 1,
                    first_captured_at: 1_752_883_200_000,
                    last_captured_at: 1_752_883_200_000,
                    object_count: state.rows.length,
                    payload_bytes: state.rows.length * 100,
                    source: "codex",
                  },
                ],
        });
      }
      if (sql.includes("COUNT(*) AS object_count")) {
        state.events.push("d1-total-inventory");
        return Effect.succeed({
          rows: [
            {
              affected_users: state.rows.length === 0 ? 0 : 1,
              first_captured_at: state.rows.length === 0 ? null : 1_752_883_200_000,
              last_captured_at: state.rows.length === 0 ? null : 1_752_883_200_000,
              object_count: state.rows.length,
              payload_bytes: state.rows.length * 100,
            },
          ],
        });
      }
      if (sql.includes("SELECT id, object_key")) {
        state.events.push("d1-batch-read");
        return Effect.succeed({
          rows: state.rows.map((row) => ({ id: row.id, object_key: row.objectKey })),
        });
      }
      if (sql.startsWith("DELETE FROM usage_raw_batches")) {
        state.events.push("d1-delete");
        const ids = new Set(params.slice(1));
        const before = state.rows.length;
        state.rows = state.rows.filter((row) => !ids.has(row.id));
        return Effect.succeed({ changes: before - state.rows.length, rows: [] });
      }
      return Effect.fail(new CleanupApiError({ operation: "unexpected fake query" }));
    },
  };
}

function purgeOptions(expectedCount: number) {
  return {
    confirmation: "PURGE_SESSION_REPORTS",
    expectedCount,
    mode: "purge" as const,
  };
}

describe("executeCleanup", () => {
  it("inventories aggregate metadata without mutating D1 or R2", async () => {
    const state = makeState(2);
    const logs: CleanupLogEvent[] = [];

    const result = await Effect.runPromise(
      executeCleanup({ mode: "inventory" }, makeFakeApi(state), databaseName, (event) =>
        logs.push(event),
      ),
    );

    expect(result.before).toMatchObject({ d1Rows: 2, r2Objects: 2, affectedUsers: 1 });
    expect(state.events).not.toContain("r2-delete");
    expect(state.events).not.toContain("d1-delete");
    expect(JSON.stringify(logs)).not.toContain("user-secret");
    expect(JSON.stringify(logs)).not.toContain("device-secret");
    expect(JSON.stringify(logs)).not.toContain("hash-0");
  });

  it("rejects purge before any API request when confirmation is absent", async () => {
    const state = makeState();

    await expect(
      Effect.runPromise(
        executeCleanup({ expectedCount: 1, mode: "purge" }, makeFakeApi(state), databaseName),
      ),
    ).rejects.toBeInstanceOf(CleanupConfigurationError);
    expect(state.events).toEqual([]);
  });

  it("rejects a stale expected count without deleting anything", async () => {
    const state = makeState(2);

    await expect(
      Effect.runPromise(executeCleanup(purgeOptions(1), makeFakeApi(state), databaseName)),
    ).rejects.toBeInstanceOf(CleanupVerificationError);
    expect(state.events).not.toContain("r2-delete");
    expect(state.events).not.toContain("d1-delete");
  });

  it("deletes R2 objects before their D1 rows and verifies an empty final state", async () => {
    const state = makeState(2);

    const result = await Effect.runPromise(
      executeCleanup(purgeOptions(2), makeFakeApi(state), databaseName),
    );

    const firstR2Delete = state.events.indexOf("r2-delete");
    const firstD1Delete = state.events.indexOf("d1-delete");
    expect(firstR2Delete).toBeGreaterThan(-1);
    expect(firstD1Delete).toBeGreaterThan(firstR2Delete);
    expect(result).toMatchObject({
      after: { d1Rows: 0, r2Objects: 0 },
      d1RowsDeleted: 2,
      r2ObjectsDeleted: 2,
    });
  });

  it("keeps D1 metadata when any R2 deletion in the batch fails", async () => {
    const state = makeState(2);
    state.failR2Key = state.rows[1]!.objectKey;

    await expect(
      Effect.runPromise(executeCleanup(purgeOptions(2), makeFakeApi(state), databaseName)),
    ).rejects.toBeInstanceOf(CleanupApiError);
    expect(state.events).not.toContain("d1-delete");
    expect(state.rows).toHaveLength(2);
  });

  it("refuses a D1 session row whose object key is outside the session namespace", async () => {
    const state = makeState();
    state.rows[0]!.objectKey =
      "users/user-secret/devices/device-secret/ccusage/codex/daily/do-not-delete.json";

    await expect(
      Effect.runPromise(executeCleanup(purgeOptions(1), makeFakeApi(state), databaseName)),
    ).rejects.toBeInstanceOf(CleanupApiError);
    expect(state.events).not.toContain("r2-delete");
    expect(state.events).not.toContain("d1-delete");
  });

  it("treats missing R2 objects as an idempotent success", async () => {
    const state = makeState();
    state.r2Objects = [];

    const result = await Effect.runPromise(
      executeCleanup(purgeOptions(1), makeFakeApi(state), databaseName),
    );

    expect(result.r2ObjectsAlreadyMissing).toBe(1);
    expect(result.d1RowsDeleted).toBe(1);
    expect(result.after).toMatchObject({ d1Rows: 0, r2Objects: 0 });
  });

  it("removes exact-pattern orphaned R2 objects after D1 cleanup", async () => {
    const state = makeState(0);
    state.r2Objects = [{ key: sessionKey("orphan"), size: 42 }];

    const result = await Effect.runPromise(
      executeCleanup(purgeOptions(0), makeFakeApi(state), databaseName),
    );

    expect(result.r2ObjectsDeleted).toBe(1);
    expect(result.after.r2Objects).toBe(0);
  });

  it("fails final verification when R2 still reports a session object", async () => {
    const state = makeState(0);
    const api = makeFakeApi(state);
    const phantom = { key: sessionKey("phantom"), size: 42 };
    api.listR2SessionObjects = () => Effect.succeed([phantom]);
    api.deleteR2Object = () => Effect.succeed("missing");

    await expect(
      Effect.runPromise(executeCleanup(purgeOptions(0), api, databaseName)),
    ).rejects.toBeInstanceOf(CleanupVerificationError);
  });

  it("requires one exact database-name match", async () => {
    const state = makeState();
    const api = makeFakeApi(state);
    api.listDatabases = () =>
      Effect.succeed([{ name: "tokenmaxxing-prod-copy", uuid: databaseId }]);

    await expect(
      Effect.runPromise(executeCleanup({ mode: "inventory" }, api, databaseName)),
    ).rejects.toBeInstanceOf(CleanupVerificationError);
  });
});

describe("CLI validation and Cloudflare transport", () => {
  it("parses an explicitly confirmed purge", async () => {
    await expect(
      Effect.runPromise(
        parseCleanupOptions([
          "--mode",
          "purge",
          "--expected-count",
          "12",
          "--confirmation",
          "PURGE_SESSION_REPORTS",
        ]),
      ),
    ).resolves.toEqual({
      confirmation: "PURGE_SESSION_REPORTS",
      expectedCount: 12,
      mode: "purge",
    });
  });

  it("rejects unknown arguments and unsafe expected counts", async () => {
    await expect(
      Effect.runPromise(parseCleanupOptions(["--mode", "inventory", "--dryrun", "true"])),
    ).rejects.toBeInstanceOf(CleanupConfigurationError);
    await expect(
      Effect.runPromise(
        parseCleanupOptions(["--mode", "purge", "--expected-count", "9007199254740992"]),
      ),
    ).rejects.toBeInstanceOf(CleanupConfigurationError);
  });

  it("preserves slashes while encoding each R2 key segment", () => {
    expect(encodeObjectKey("users/a b/session/hash?#.json")).toBe(
      "users/a%20b/session/hash%3F%23.json",
    );
  });

  it("paginates R2 metadata and retains only exact session object keys", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          result: [
            { key: sessionKey("one"), size: 10 },
            { key: "users/u/devices/d/ccusage/codex/daily/keep.json", size: 20 },
          ],
          result_info: { cursor: "next-page", is_truncated: true },
          success: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          result: [{ key: sessionKey("two"), size: 30 }],
          result_info: { is_truncated: false },
          success: true,
        }),
      );
    const api = makeCleanupApi(
      {
        accountId: "account",
        apiToken: "secret-token",
        bucketName: "bucket",
        databaseName,
      },
      fetchMock,
    );

    await expect(Effect.runPromise(api.listR2SessionObjects())).resolves.toEqual([
      { key: sessionKey("one"), size: 10 },
      { key: sessionKey("two"), size: 30 },
    ]);
    const secondRequest = fetchMock.mock.calls[1]?.[0];
    expect(typeof secondRequest).toBe("string");
    expect(secondRequest).toContain("cursor=next-page");
  });

  it("rejects a 2xx R2 delete response whose Cloudflare success flag is false", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        errors: [{ message: sessionKey("private") }],
        result: null,
        success: false,
      }),
    );
    const api = makeCleanupApi(
      {
        accountId: "account",
        apiToken: "secret-token",
        bucketName: "bucket",
        databaseName,
      },
      fetchMock,
    );

    await expect(Effect.runPromise(api.deleteR2Object(sessionKey("private")))).rejects.toEqual(
      expect.objectContaining({ _tag: "CleanupApiError", operation: "delete R2 object" }),
    );
  });

  it("sanitizes Cloudflare failures without exposing keys or response bodies", () => {
    const error = new CleanupApiError({ operation: "delete R2 object", status: 500 });
    const message = safeErrorMessage(error);

    expect(message).toBe("Cloudflare operation failed: delete R2 object (HTTP 500).");
    expect(message).not.toContain("user-secret");
    expect(message).not.toContain("secret-token");
  });
});
