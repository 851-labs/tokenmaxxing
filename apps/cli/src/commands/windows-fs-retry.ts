import { setTimeout as sleepFor } from "node:timers/promises";

/**
 * Retries a filesystem call that Windows refuses for a moment.
 *
 * On Windows a delete or rename fails with EBUSY, EPERM, EACCES or
 * ENOTEMPTY while any process holds a handle on the file, or on a file
 * inside the dir: antivirus or the search indexer scanning a file that was
 * just written, or a child (ccusage's node.exe, the runner itself) that has
 * exited but is still being torn down. Those handles go away within a second
 * or two, so the call is retried with a short backoff before it counts as
 * failed. Elsewhere these codes mean a real permission problem and the call
 * is never retried.
 */

const TRANSIENT_WINDOWS_FS_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EPERM",
]);
// Five attempts over about 2 s.
const WINDOWS_FS_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000];

interface WindowsFsRetryOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

function sleep(ms: number): Promise<void> {
  return sleepFor(ms);
}

function isTransientWindowsFsError(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_WINDOWS_FS_CODES.has(code);
}

/**
 * Runs `operation`, and on Windows runs it again after a short wait while it
 * fails with a transient code. The last error is thrown once the attempts run
 * out, and any other error at once.
 */
async function retryWindowsFs<A>(
  operation: () => Promise<A>,
  options: WindowsFsRetryOptions = {},
): Promise<A> {
  const platform = options.platform ?? process.platform;
  const wait = options.sleep ?? sleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (cause) {
      const delay = WINDOWS_FS_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || delay === undefined || !isTransientWindowsFsError(cause)) {
        throw cause;
      }
      await wait(delay);
    }
  }
}

export { isTransientWindowsFsError, retryWindowsFs, sleep, WINDOWS_FS_RETRY_DELAYS_MS };
export type { WindowsFsRetryOptions };
