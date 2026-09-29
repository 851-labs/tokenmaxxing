import { Data, Effect } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { TooManyRequests } from "@tokenmaxxing/api-contract";

/**
 * Time limits for API calls and the wording for failures a user can act on:
 * a server that never answers, and a rate limit (a typed `TooManyRequests`,
 * or any other 429, e.g. from Cloudflare in front of an endpoint that does
 * not declare one).
 */

/** `/me`: a small read; anything slower is a hung connection. */
const ME_TIMEOUT_MS = 15_000;
/** One `/usage/ingest` attempt, foreground or scheduled (see SERVICE_UPLOAD_RETRY_POLICY). */
const USAGE_UPLOAD_TIMEOUT_MS = 60_000;

class ApiTimeoutError extends Data.TaggedError("ApiTimeoutError")<{
  readonly timeoutMs: number;
}> {
  override get message() {
    return `the tokenmaxxing API did not answer within ${formatSeconds(this.timeoutMs)}`;
  }
}

function withApiTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | ApiTimeoutError, R> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: `${Math.max(1, timeoutMs)} millis`,
      orElse: () => Effect.fail(new ApiTimeoutError({ timeoutMs })),
    }),
  );
}

/**
 * For a rate-limited request, the seconds it says to wait (null when it does
 * not say); undefined when `cause` is not a rate limit at all.
 */
function rateLimitRetryAfterSeconds(
  cause: unknown,
  now: () => number = Date.now,
): number | null | undefined {
  if (cause instanceof TooManyRequests) {
    return cause.retryAfterSeconds;
  }
  if (!HttpClientError.isHttpClientError(cause) || cause.response?.status !== 429) {
    return undefined;
  }

  const header = cause.response.headers["retry-after"]?.trim();
  if (header === undefined || header === "") {
    return null;
  }
  if (/^\d+$/.test(header)) {
    return Number(header);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now()) / 1000));
}

/**
 * `error: <summary>` plus a hint, naming a timeout or rate limit when that is
 * what `cause` is, and `fallbackHint` otherwise.
 */
function apiFailureMessage(summary: string, cause: unknown, fallbackHint: string): string {
  const retryAfterSeconds = rateLimitRetryAfterSeconds(cause);
  if (retryAfterSeconds !== undefined) {
    return `error: ${summary}; the tokenmaxxing API is rate limiting requests\nhint: ${
      retryAfterSeconds === null
        ? "try again in a minute"
        : `try again in ${formatSeconds(retryAfterSeconds * 1000)}`
    }`;
  }
  if (cause instanceof ApiTimeoutError) {
    return `error: ${summary}; ${cause.message}\nhint: check your network, then try again`;
  }

  return `error: ${summary}\nhint: ${fallbackHint}`;
}

function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

export {
  apiFailureMessage,
  ApiTimeoutError,
  ME_TIMEOUT_MS,
  rateLimitRetryAfterSeconds,
  USAGE_UPLOAD_TIMEOUT_MS,
  withApiTimeout,
};
