import { Effect, Layer } from "effect";

import { RawUsageObjectStore } from "../usage/raw-store";

/**
 * In-memory stand-in for the R2 binding, fed through the real
 * RawUsageObjectStore.layer so tests exercise its key/metadata mapping.
 */

interface MemoryObject {
  customMetadata: Record<string, string> | undefined;
  value: string;
}

interface MemoryBucket {
  /** Every successful delete call's keys, in call order. */
  readonly deletes: string[][];
  readonly layer: Layer.Layer<RawUsageObjectStore>;
  readonly objects: Map<string, MemoryObject>;
  /** Every put key, in call order. */
  readonly puts: string[];
  /** Fails later deletes with `cause`; `null` restores them. */
  setDeleteFailure(cause: Error | null): void;
}

interface MemoryBucketOptions {
  /** Runs before each delete call applies — e.g. to race a write in. */
  onDelete?: (keys: readonly string[]) => void;
}

function makeMemoryBucket(options: MemoryBucketOptions = {}): MemoryBucket {
  const objects = new Map<string, MemoryObject>();
  const deletes: string[][] = [];
  const puts: string[] = [];
  let deleteFailure: Error | null = null;

  const layer = RawUsageObjectStore.layer({
    delete: (keys) =>
      Effect.suspend(() => {
        if (deleteFailure !== null) {
          return Effect.fail(deleteFailure);
        }
        options.onDelete?.(keys);
        deletes.push([...keys]);
        for (const key of keys) {
          objects.delete(key);
        }
        return Effect.void;
      }),
    put: (key, value, putOptions) =>
      Effect.sync(() => {
        puts.push(key);
        objects.set(key, { customMetadata: putOptions?.customMetadata, value });
      }),
  });

  return {
    deletes,
    layer,
    objects,
    puts,
    setDeleteFailure: (cause) => {
      deleteFailure = cause;
    },
  };
}

export { makeMemoryBucket };

export type { MemoryBucket, MemoryObject };
