import { Context, Data, Effect } from "effect";
import { Layer } from "effect";

class RawUsageStorageError extends Data.TaggedError("RawUsageStorageError")<{
  readonly cause: unknown;
}> {}

interface R2BucketLike {
  put(
    key: string,
    value: string,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
    },
  ): Effect.Effect<unknown, unknown, any>;
  delete(keys: string[]): Effect.Effect<unknown, unknown, any>;
}

interface RawUsageObjectStoreShape {
  putObject(input: {
    key: string;
    payloadBytes: number;
    payloadHash: string;
    payloadJson: string;
  }): Effect.Effect<void, RawUsageStorageError, any>;
  /** Deletes objects by key; missing keys are a no-op, so retries are safe. */
  deleteObjects(keys: readonly string[]): Effect.Effect<void, RawUsageStorageError, any>;
}

/** R2 caps a multi-key delete at 1000 keys. */
const DELETE_BATCH_SIZE = 1000;

class RawUsageObjectStore extends Context.Service<RawUsageObjectStore, RawUsageObjectStoreShape>()(
  "@tokenmaxxing/api/RawUsageObjectStore",
) {
  static layer(bucket: R2BucketLike): Layer.Layer<RawUsageObjectStore> {
    return Layer.succeed(
      RawUsageObjectStore,
      RawUsageObjectStore.of({
        putObject: ({ key, payloadBytes, payloadHash, payloadJson }) =>
          bucket
            .put(key, payloadJson, {
              customMetadata: {
                payloadBytes: String(payloadBytes),
                payloadHash,
              },
              httpMetadata: { contentType: "application/json" },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new RawUsageStorageError({ cause })),
            ),
        deleteObjects: (keys) =>
          Effect.gen(function* () {
            for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
              yield* bucket
                .delete(keys.slice(offset, offset + DELETE_BATCH_SIZE))
                .pipe(Effect.mapError((cause) => new RawUsageStorageError({ cause })));
            }
          }),
      }),
    );
  }
}

export { RawUsageObjectStore, RawUsageStorageError };
