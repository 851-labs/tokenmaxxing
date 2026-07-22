import { Data, Effect } from "effect";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_BATCH_SIZE = 50;
const SESSION_OBJECT_KEY_PATTERN =
  /^users\/[^/]+\/devices\/[^/]+\/ccusage\/[^/]+\/session\/[^/]+\.json$/;

type CleanupMode = "inventory" | "purge";

interface CleanupOptions {
  confirmation?: string | undefined;
  expectedCount?: number | undefined;
  mode: CleanupMode;
}

interface CleanupEnvironment {
  accountId: string;
  apiToken: string;
  bucketName: string;
  databaseName: string;
}

interface DatabaseRecord {
  name: string;
  uuid: string;
}

interface D1QueryResult {
  changes?: number | undefined;
  rows: readonly Record<string, unknown>[];
}

interface SessionBatchRow {
  id: string;
  objectKey: string;
}

interface SessionSourceInventory {
  affectedUsers: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  objectCount: number;
  payloadBytes: number;
  source: string;
}

interface SessionInventory {
  affectedUsers: number;
  d1Rows: number;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  payloadBytes: number;
  r2Objects: number;
  r2PayloadBytes: number;
  sources: readonly SessionSourceInventory[];
}

interface CleanupResult {
  after: SessionInventory;
  before: SessionInventory;
  d1RowsDeleted: number;
  r2ObjectsAlreadyMissing: number;
  r2ObjectsDeleted: number;
}

type CleanupLogEvent =
  | { inventory: SessionInventory; type: "inventory" }
  | {
      d1RowsDeleted: number;
      r2ObjectsAlreadyMissing: number;
      r2ObjectsDeleted: number;
      type: "purge-complete";
    };

interface CleanupApi {
  deleteR2Object(objectKey: string): Effect.Effect<"deleted" | "missing", CleanupApiError>;
  listDatabases(name: string): Effect.Effect<readonly DatabaseRecord[], CleanupApiError>;
  listR2SessionObjects(): Effect.Effect<readonly R2SessionObject[], CleanupApiError>;
  queryD1(
    databaseId: string,
    sql: string,
    params?: readonly string[],
  ): Effect.Effect<D1QueryResult, CleanupApiError>;
}

interface R2SessionObject {
  key: string;
  size: number;
}

class CleanupConfigurationError extends Data.TaggedError("CleanupConfigurationError")<{
  readonly message: string;
}> {}

class CleanupApiError extends Data.TaggedError("CleanupApiError")<{
  readonly operation: string;
  readonly status?: number | undefined;
}> {}

class CleanupVerificationError extends Data.TaggedError("CleanupVerificationError")<{
  readonly message: string;
}> {}

type CleanupError = CleanupApiError | CleanupConfigurationError | CleanupVerificationError;

const TOTAL_INVENTORY_SQL = `
SELECT
  COUNT(*) AS object_count,
  COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
  COUNT(DISTINCT user_id) AS affected_users,
  MIN(captured_at) AS first_captured_at,
  MAX(captured_at) AS last_captured_at
FROM usage_raw_batches
WHERE report_kind = 'session'
`;

const SOURCE_INVENTORY_SQL = `
SELECT
  source,
  COUNT(*) AS object_count,
  COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
  COUNT(DISTINCT user_id) AS affected_users,
  MIN(captured_at) AS first_captured_at,
  MAX(captured_at) AS last_captured_at
FROM usage_raw_batches
WHERE report_kind = 'session'
GROUP BY source
ORDER BY source
`;

const SESSION_BATCH_SQL = `
SELECT id, object_key
FROM usage_raw_batches
WHERE report_kind = 'session'
ORDER BY id
LIMIT ?
`;

function parseCleanupOptions(
  args: readonly string[],
): Effect.Effect<CleanupOptions, CleanupConfigurationError> {
  const knownFlags = new Set(["confirmation", "expected-count", "mode"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      return Effect.fail(
        new CleanupConfigurationError({
          message: "Arguments must be provided as --name value pairs.",
        }),
      );
    }
    const name = flag.slice(2);
    if (!knownFlags.has(name)) {
      return Effect.fail(
        new CleanupConfigurationError({ message: `Unknown argument: --${name}.` }),
      );
    }
    values.set(name, value);
  }

  const mode = values.get("mode");
  if (mode !== "inventory" && mode !== "purge") {
    return Effect.fail(
      new CleanupConfigurationError({ message: "--mode must be inventory or purge." }),
    );
  }

  const expectedCountValue = values.get("expected-count");
  const expectedCount =
    expectedCountValue === undefined ? undefined : Number.parseInt(expectedCountValue, 10);
  if (
    expectedCountValue !== undefined &&
    (!/^\d+$/.test(expectedCountValue) ||
      expectedCount === undefined ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0)
  ) {
    return Effect.fail(
      new CleanupConfigurationError({
        message: "--expected-count must be a non-negative integer.",
      }),
    );
  }

  return Effect.succeed({
    confirmation: values.get("confirmation"),
    expectedCount,
    mode,
  });
}

function readCleanupEnvironment(
  env: Record<string, string | undefined>,
): Effect.Effect<CleanupEnvironment, CleanupConfigurationError> {
  const required = [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_BUCKET_NAME",
    "CLOUDFLARE_DATABASE_NAME",
  ] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    return Effect.fail(
      new CleanupConfigurationError({
        message: `Missing required environment variables: ${missing.join(", ")}.`,
      }),
    );
  }

  return Effect.succeed({
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: env.CLOUDFLARE_API_TOKEN!,
    bucketName: env.CLOUDFLARE_BUCKET_NAME!,
    databaseName: env.CLOUDFLARE_DATABASE_NAME!,
  });
}

function makeCleanupApi(
  environment: CleanupEnvironment,
  fetchImplementation: typeof fetch = fetch,
): CleanupApi {
  const accountPath = `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(environment.accountId)}`;
  const headers = {
    Authorization: `Bearer ${environment.apiToken}`,
    "Content-Type": "application/json",
  };

  const requestJson = <A>(
    operation: string,
    url: string,
    init?: RequestInit,
  ): Effect.Effect<A, CleanupApiError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImplementation(url, { ...init, headers });
        if (!response.ok) {
          return Promise.reject(new CleanupApiError({ operation, status: response.status }));
        }

        const body = (await response.json()) as CloudflareEnvelope<A>;
        if (body.success !== true) {
          return Promise.reject(new CleanupApiError({ operation, status: response.status }));
        }
        return body.result;
      },
      catch: (error) =>
        error instanceof CleanupApiError ? error : new CleanupApiError({ operation }),
    });

  return {
    deleteR2Object: (objectKey) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImplementation(
            `${accountPath}/r2/buckets/${encodeURIComponent(environment.bucketName)}/objects/${encodeObjectKey(objectKey)}`,
            { headers, method: "DELETE" },
          );
          if (response.status === 404) {
            return "missing" as const;
          }
          if (!response.ok) {
            return Promise.reject(
              new CleanupApiError({ operation: "delete R2 object", status: response.status }),
            );
          }
          const body = (await response.json()) as CloudflareEnvelope<unknown>;
          if (body.success !== true) {
            return Promise.reject(
              new CleanupApiError({ operation: "delete R2 object", status: response.status }),
            );
          }
          return "deleted" as const;
        },
        catch: (error) =>
          error instanceof CleanupApiError
            ? error
            : new CleanupApiError({ operation: "delete R2 object" }),
      }),
    listDatabases: (name) =>
      requestJson<readonly CloudflareDatabaseRecord[]>(
        "list D1 databases",
        `${accountPath}/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
      ).pipe(
        Effect.flatMap((records) => {
          const databases = records.flatMap((record) =>
            typeof record.name === "string" && typeof record.uuid === "string"
              ? [{ name: record.name, uuid: record.uuid }]
              : [],
          );
          return databases.length === records.length
            ? Effect.succeed(databases)
            : Effect.fail(new CleanupApiError({ operation: "decode D1 database list" }));
        }),
      ),
    listR2SessionObjects: () =>
      Effect.gen(function* () {
        const objects: R2SessionObject[] = [];
        let cursor: string | undefined;
        do {
          const search = new URLSearchParams({ per_page: "1000", prefix: "users/" });
          if (cursor !== undefined) {
            search.set("cursor", cursor);
          }
          const response = yield* requestCloudflareEnvelope<readonly CloudflareR2Object[]>(
            fetchImplementation,
            "list R2 objects",
            `${accountPath}/r2/buckets/${encodeURIComponent(environment.bucketName)}/objects?${search.toString()}`,
            headers,
          );
          for (const object of response.result) {
            if (typeof object.key !== "string" || typeof object.size !== "number") {
              return yield* Effect.fail(
                new CleanupApiError({ operation: "decode R2 object metadata" }),
              );
            }
            if (SESSION_OBJECT_KEY_PATTERN.test(object.key)) {
              objects.push({ key: object.key, size: object.size });
            }
          }
          const isTruncated =
            response.resultInfo?.is_truncated === true || response.resultInfo?.isTruncated === true;
          cursor = isTruncated ? response.resultInfo?.cursor : undefined;
          if (isTruncated && !cursor) {
            return yield* Effect.fail(new CleanupApiError({ operation: "paginate R2 objects" }));
          }
        } while (cursor !== undefined);

        return objects;
      }),
    queryD1: (databaseId, sql, params = []) =>
      requestJson<readonly CloudflareD1QueryResult[]>(
        "query D1 database",
        `${accountPath}/d1/database/${encodeURIComponent(databaseId)}/query`,
        {
          body: JSON.stringify({ params, sql }),
          method: "POST",
        },
      ).pipe(
        Effect.flatMap((results) => {
          const result = results[0];
          if (results.length !== 1 || result?.success !== true || !Array.isArray(result.results)) {
            return Effect.fail(new CleanupApiError({ operation: "decode D1 query result" }));
          }
          return Effect.succeed({ changes: result.meta?.changes, rows: result.results });
        }),
      ),
  };
}

function requestCloudflareEnvelope<A>(
  fetchImplementation: typeof fetch,
  operation: string,
  url: string,
  headers: Record<string, string>,
): Effect.Effect<{ result: A; resultInfo?: CloudflareResultInfo | undefined }, CleanupApiError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetchImplementation(url, { headers });
      if (!response.ok) {
        return Promise.reject(new CleanupApiError({ operation, status: response.status }));
      }
      const body = (await response.json()) as CloudflareEnvelope<A>;
      if (body.success !== true) {
        return Promise.reject(new CleanupApiError({ operation, status: response.status }));
      }
      return { result: body.result, resultInfo: body.result_info };
    },
    catch: (error) =>
      error instanceof CleanupApiError ? error : new CleanupApiError({ operation }),
  });
}

interface CloudflareEnvelope<A> {
  result: A;
  result_info?: CloudflareResultInfo | undefined;
  success: boolean;
}

interface CloudflareResultInfo {
  cursor?: string | undefined;
  isTruncated?: boolean | undefined;
  is_truncated?: boolean | undefined;
}

interface CloudflareDatabaseRecord {
  name?: unknown;
  uuid?: unknown;
}

interface CloudflareD1QueryResult {
  meta?: { changes?: number | undefined } | undefined;
  results?: readonly Record<string, unknown>[] | undefined;
  success?: boolean | undefined;
}

interface CloudflareR2Object {
  key?: unknown;
  size?: unknown;
}

function executeCleanup(
  options: CleanupOptions,
  api: CleanupApi,
  databaseName: string,
  log: (event: CleanupLogEvent) => void = (event) => console.log(JSON.stringify(event)),
): Effect.Effect<CleanupResult, CleanupError> {
  return Effect.gen(function* () {
    yield* validatePurgeOptions(options);
    const databaseId = yield* resolveDatabaseId(api, databaseName);
    const before = yield* inventorySessionReports(api, databaseId);
    log({ inventory: before, type: "inventory" });

    if (options.mode === "inventory") {
      return {
        after: before,
        before,
        d1RowsDeleted: 0,
        r2ObjectsAlreadyMissing: 0,
        r2ObjectsDeleted: 0,
      };
    }

    if (options.expectedCount !== before.d1Rows) {
      return yield* Effect.fail(
        new CleanupVerificationError({
          message: `Expected ${options.expectedCount} D1 session rows, found ${before.d1Rows}.`,
        }),
      );
    }

    let d1RowsDeleted = 0;
    let r2ObjectsAlreadyMissing = 0;
    let r2ObjectsDeleted = 0;

    while (true) {
      const rows = yield* readSessionBatch(api, databaseId, DEFAULT_BATCH_SIZE);
      if (rows.length === 0) {
        break;
      }

      const deleteResults = yield* Effect.forEach(
        rows,
        (row) => api.deleteR2Object(row.objectKey),
        { concurrency: 5 },
      );
      r2ObjectsDeleted += deleteResults.filter((result) => result === "deleted").length;
      r2ObjectsAlreadyMissing += deleteResults.filter((result) => result === "missing").length;

      const changes = yield* deleteD1Rows(
        api,
        databaseId,
        rows.map((row) => row.id),
      );
      if (changes !== rows.length) {
        return yield* Effect.fail(
          new CleanupVerificationError({
            message: `D1 deleted ${changes} rows from a ${rows.length}-row batch.`,
          }),
        );
      }
      d1RowsDeleted += changes;
    }

    const orphanedObjects = yield* api.listR2SessionObjects();
    const orphanDeleteResults = yield* Effect.forEach(
      orphanedObjects,
      (object) => api.deleteR2Object(object.key),
      { concurrency: 5 },
    );
    r2ObjectsDeleted += orphanDeleteResults.filter((result) => result === "deleted").length;
    r2ObjectsAlreadyMissing += orphanDeleteResults.filter((result) => result === "missing").length;

    const after = yield* inventorySessionReports(api, databaseId);
    if (after.d1Rows !== 0 || after.r2Objects !== 0) {
      return yield* Effect.fail(
        new CleanupVerificationError({
          message: `Cleanup verification failed: ${after.d1Rows} D1 rows and ${after.r2Objects} R2 objects remain.`,
        }),
      );
    }

    log({ d1RowsDeleted, r2ObjectsAlreadyMissing, r2ObjectsDeleted, type: "purge-complete" });
    return { after, before, d1RowsDeleted, r2ObjectsAlreadyMissing, r2ObjectsDeleted };
  });
}

function validatePurgeOptions(
  options: CleanupOptions,
): Effect.Effect<void, CleanupConfigurationError> {
  if (options.mode === "inventory") {
    return Effect.void;
  }
  if (options.confirmation !== "PURGE_SESSION_REPORTS") {
    return Effect.fail(
      new CleanupConfigurationError({
        message: "Purge requires --confirmation PURGE_SESSION_REPORTS.",
      }),
    );
  }
  if (options.expectedCount === undefined) {
    return Effect.fail(
      new CleanupConfigurationError({ message: "Purge requires --expected-count." }),
    );
  }
  return Effect.void;
}

function resolveDatabaseId(
  api: CleanupApi,
  databaseName: string,
): Effect.Effect<string, CleanupApiError | CleanupVerificationError> {
  return Effect.gen(function* () {
    const databases = (yield* api.listDatabases(databaseName)).filter(
      (database) => database.name === databaseName,
    );
    if (databases.length !== 1) {
      return yield* Effect.fail(
        new CleanupVerificationError({
          message: `Expected exactly one D1 database named ${databaseName}, found ${databases.length}.`,
        }),
      );
    }
    return databases[0]!.uuid;
  });
}

function inventorySessionReports(
  api: CleanupApi,
  databaseId: string,
): Effect.Effect<SessionInventory, CleanupApiError> {
  return Effect.gen(function* () {
    const [totalResult, sourceResult, r2Objects] = yield* Effect.all(
      [
        api.queryD1(databaseId, TOTAL_INVENTORY_SQL),
        api.queryD1(databaseId, SOURCE_INVENTORY_SQL),
        api.listR2SessionObjects(),
      ],
      { concurrency: 3 },
    );
    const total = totalResult.rows[0];
    if (total === undefined) {
      return yield* Effect.fail(new CleanupApiError({ operation: "decode D1 inventory" }));
    }

    const sources = yield* Effect.forEach(sourceResult.rows, decodeSourceInventory);
    return {
      affectedUsers: yield* readNumber(total, "affected_users", "decode D1 inventory"),
      d1Rows: yield* readNumber(total, "object_count", "decode D1 inventory"),
      firstCapturedAt: yield* readTimestamp(total, "first_captured_at"),
      lastCapturedAt: yield* readTimestamp(total, "last_captured_at"),
      payloadBytes: yield* readNumber(total, "payload_bytes", "decode D1 inventory"),
      r2Objects: r2Objects.length,
      r2PayloadBytes: r2Objects.reduce((sum, object) => sum + object.size, 0),
      sources,
    };
  });
}

function decodeSourceInventory(
  row: Record<string, unknown>,
): Effect.Effect<SessionSourceInventory, CleanupApiError> {
  return Effect.gen(function* () {
    const source = row.source;
    if (typeof source !== "string") {
      return yield* Effect.fail(new CleanupApiError({ operation: "decode D1 source inventory" }));
    }
    return {
      affectedUsers: yield* readNumber(row, "affected_users", "decode D1 source inventory"),
      firstCapturedAt: yield* readTimestamp(row, "first_captured_at"),
      lastCapturedAt: yield* readTimestamp(row, "last_captured_at"),
      objectCount: yield* readNumber(row, "object_count", "decode D1 source inventory"),
      payloadBytes: yield* readNumber(row, "payload_bytes", "decode D1 source inventory"),
      source,
    };
  });
}

function readSessionBatch(
  api: CleanupApi,
  databaseId: string,
  batchSize: number,
): Effect.Effect<readonly SessionBatchRow[], CleanupApiError> {
  return api.queryD1(databaseId, SESSION_BATCH_SQL, [String(batchSize)]).pipe(
    Effect.flatMap((result) =>
      Effect.forEach(result.rows, (row) => {
        const id = row.id;
        const objectKey = row.object_key;
        return typeof id === "string" &&
          typeof objectKey === "string" &&
          SESSION_OBJECT_KEY_PATTERN.test(objectKey)
          ? Effect.succeed({ id, objectKey })
          : Effect.fail(new CleanupApiError({ operation: "decode D1 session batch" }));
      }),
    ),
  );
}

function deleteD1Rows(
  api: CleanupApi,
  databaseId: string,
  ids: readonly string[],
): Effect.Effect<number, CleanupApiError> {
  if (ids.length === 0) {
    return Effect.succeed(0);
  }
  const placeholders = ids.map(() => "?").join(", ");
  return api
    .queryD1(
      databaseId,
      `DELETE FROM usage_raw_batches WHERE report_kind = ? AND id IN (${placeholders})`,
      ["session", ...ids],
    )
    .pipe(
      Effect.flatMap((result) =>
        result.changes === undefined
          ? Effect.fail(new CleanupApiError({ operation: "decode D1 delete result" }))
          : Effect.succeed(result.changes),
      ),
    );
}

function readNumber(
  row: Record<string, unknown>,
  field: string,
  operation: string,
): Effect.Effect<number, CleanupApiError> {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value)
    ? Effect.succeed(value)
    : Effect.fail(new CleanupApiError({ operation }));
}

function readTimestamp(
  row: Record<string, unknown>,
  field: string,
): Effect.Effect<string | null, CleanupApiError> {
  const value = row[field];
  if (value === null) {
    return Effect.succeed(null);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Effect.fail(new CleanupApiError({ operation: "decode D1 inventory timestamp" }));
  }
  return Effect.succeed(new Date(value).toISOString());
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof CleanupApiError) {
    const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
    return `Cloudflare operation failed: ${error.operation}${status}.`;
  }
  if (error instanceof CleanupConfigurationError || error instanceof CleanupVerificationError) {
    return error.message;
  }
  return "Cleanup failed with an unexpected error.";
}

function runCli(): Effect.Effect<void, CleanupError> {
  return Effect.gen(function* () {
    const options = yield* parseCleanupOptions(process.argv.slice(2));
    const environment = yield* readCleanupEnvironment(process.env);
    const api = makeCleanupApi(environment);
    yield* executeCleanup(options, api, environment.databaseName);
  });
}

if (import.meta.main) {
  Effect.runPromise(runCli()).catch((error: unknown) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}

export {
  CleanupApiError,
  CleanupConfigurationError,
  CleanupVerificationError,
  encodeObjectKey,
  executeCleanup,
  makeCleanupApi,
  parseCleanupOptions,
  readCleanupEnvironment,
  safeErrorMessage,
  SESSION_OBJECT_KEY_PATTERN,
};

export type {
  CleanupApi,
  CleanupEnvironment,
  CleanupLogEvent,
  CleanupOptions,
  CleanupResult,
  D1QueryResult,
  R2SessionObject,
  SessionInventory,
};
