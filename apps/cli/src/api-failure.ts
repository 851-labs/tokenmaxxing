import { Cause, Data, Effect, Schema, SchemaAST } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  type ApiError,
  ApiErrors,
  InternalServerError,
  ServiceUnavailable,
  TooManyRequests,
} from "@tokenmaxxing/api-contract";

import { ClockService } from "./services";

/**
 * Time limits and retries for API calls, what a failed call was, and the
 * wording for failures a user can act on: a server that never answers, a
 * rate limit (a typed `TooManyRequests`, or any other 429, e.g. from
 * Cloudflare in front of an endpoint that does not declare one), a server
 * error (5xx), which no network change fixes, and a network that is down.
 */

/** `/me`: a small read; anything slower is a hung connection. */
const ME_TIMEOUT_MS = 15_000;
/** One login start or poll request; the poll loop has its own overall budget. */
const LOGIN_REQUEST_TIMEOUT_MS = 15_000;
/** One `/usage/ingest` attempt, foreground or scheduled (see SERVICE_UPLOAD_RETRY_POLICY). */
const USAGE_UPLOAD_TIMEOUT_MS = 60_000;
/** The longest Retry-After a retry waits out unless its policy says otherwise. */
const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Network codes that mean there is no usable network at all (DNS down, no
 * route), as on a Mac waking from sleep, rather than a server that dropped
 * the connection. Node puts the code on the fetch error's `cause`, Bun (the
 * service runner) on the error itself; `FailedToOpenSocket` is Bun's own.
 */
const NETWORK_UNAVAILABLE_CODES = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "FailedToOpenSocket",
]);

/**
 * What a failed API call was, for logs, `--json` and error messages. Only
 * codes, statuses and tags: never the request, its URL or its headers (the
 * bearer token lives there).
 */
type ApiFailureDetail =
  | { kind: "decode"; status?: number | undefined }
  | {
      kind: "http";
      /** For a 429: the seconds it said to wait (null when it did not say). */
      retryAfterSeconds?: number | null | undefined;
      status: number;
      /** The decoded wire error's `_tag`, when the body was one. */
      tag?: string | undefined;
    }
  | { kind: "network"; code?: string | undefined }
  | { kind: "timeout"; timeoutMs?: number | undefined }
  | { kind: "unknown"; name?: string | undefined };

interface ApiRetryPolicy {
  attempts: number;
  /** The wait after attempt n is `backoffMs[n - 1]` (the last entry repeats). */
  backoffMs: readonly number[];
  jitterRatio: number;
  random?: (() => number) | undefined;
  /**
   * The longest Retry-After worth waiting out (default 60 s); a longer one
   * ends the retries, and the next run tries again.
   */
  retryAfterMaxMs?: number | undefined;
  /** Which failures get another attempt; every failure when unset. */
  retryable?: ((cause: unknown) => boolean) | undefined;
  timeoutMs: number;
}

class ApiTimeoutError extends Data.TaggedError("ApiTimeoutError")<{
  readonly timeoutMs: number;
}> {
  override get message() {
    return `the tokenmaxxing API did not answer within ${formatSeconds(this.timeoutMs)}`;
  }
}

/** A call `withApiRetry` gave up on after `attempts` tries; `cause` is the last failure. */
class ApiRetryError extends Data.TaggedError("ApiRetryError")<{
  readonly attempts: number;
  readonly cause: unknown;
}> {}

/**
 * Interactive `/me` (sync, whoami): one quick retry for a blip. Not after a
 * timeout, which already kept the user waiting 15 s.
 */
const ME_RETRY_POLICY: ApiRetryPolicy = {
  attempts: 2,
  backoffMs: [500],
  jitterRatio: 0,
  retryAfterMaxMs: 2_000,
  retryable: (cause) => !(cause instanceof ApiTimeoutError) && isTransientApiFailure(cause),
  timeoutMs: ME_TIMEOUT_MS,
};

/**
 * Scheduled `/me`: nobody is waiting, and a run can start while the network
 * is still coming up (a Mac's DarkWake), so back off and try again. Worst
 * case, three timeouts and both backoffs, is about 51 s.
 */
const SCHEDULED_ME_RETRY_POLICY: ApiRetryPolicy = {
  attempts: 3,
  backoffMs: [1_000, 4_000],
  jitterRatio: 0.2,
  retryAfterMaxMs: 10_000,
  retryable: isTransientApiFailure,
  timeoutMs: ME_TIMEOUT_MS,
};

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
 * Runs `call` up to `policy.attempts` times, each attempt bounded by
 * `policy.timeoutMs`, backing off between attempts. A 429 says when to come
 * back: wait that long when it is short, and stop hammering when it is not.
 */
function withApiRetry<A, E, R>(
  call: () => Effect.Effect<A, E, R>,
  policy: ApiRetryPolicy,
): Effect.Effect<A, ApiRetryError, R | ClockService> {
  return Effect.gen(function* () {
    const clock = yield* Effect.service(ClockService);
    const attempts = Math.max(1, Math.floor(policy.attempts));
    const retryAfterMaxMs = policy.retryAfterMaxMs ?? RETRY_AFTER_MAX_MS;

    for (let attempt = 1; ; attempt += 1) {
      const result = yield* withApiTimeout(call(), policy.timeoutMs).pipe(
        Effect.match({
          onFailure: (cause) => ({ cause, _tag: "failure" as const }),
          onSuccess: (value) => ({ value, _tag: "success" as const }),
        }),
      );
      if (result._tag === "success") {
        return result.value;
      }

      const retryAfterSeconds = rateLimitRetryAfterSeconds(result.cause);
      if (
        attempt >= attempts ||
        (policy.retryable !== undefined && !policy.retryable(result.cause)) ||
        (typeof retryAfterSeconds === "number" && retryAfterSeconds * 1000 > retryAfterMaxMs)
      ) {
        return yield* Effect.fail(new ApiRetryError({ attempts: attempt, cause: result.cause }));
      }

      const backoffMs =
        typeof retryAfterSeconds === "number"
          ? Math.max(retryAfterSeconds * 1000, retryBackoffMs(policy, attempt))
          : retryBackoffMs(policy, attempt);
      if (backoffMs > 0) {
        yield* clock.sleep(backoffMs).pipe(Effect.catch(() => Effect.void));
      }
    }
  });
}

function retryBackoffMs(policy: ApiRetryPolicy, attempt: number): number {
  const base = policy.backoffMs[Math.max(0, attempt - 1)] ?? policy.backoffMs.at(-1) ?? 0;
  const jitterRatio = Math.max(0, policy.jitterRatio);
  const random = policy.random ?? Math.random;
  const jitter = jitterRatio === 0 ? 1 : 1 - jitterRatio + random() * jitterRatio * 2;

  return Math.max(0, Math.round(base * jitter));
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

/** The HTTP status of a server error (5xx), typed or not; undefined for anything else. */
function serverErrorStatus(cause: unknown): number | undefined {
  if (cause instanceof InternalServerError) {
    return 500;
  }
  if (cause instanceof ServiceUnavailable) {
    return 503;
  }
  const status = HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined;
  return status !== undefined && status >= 500 && status <= 599 ? status : undefined;
}

/** Classifies a failed API call (see `ApiFailureDetail`). */
function describeApiFailure(cause: unknown): ApiFailureDetail {
  if (cause instanceof ApiRetryError) {
    return describeApiFailure(cause.cause);
  }
  if (cause instanceof ApiTimeoutError) {
    return { kind: "timeout", timeoutMs: cause.timeoutMs };
  }
  if (Cause.isTimeoutError(cause)) {
    return { kind: "timeout" };
  }

  const typed = ApiErrors.find((ErrorClass) => cause instanceof ErrorClass);
  // Every wire error class carries its status as an `httpApiStatus` annotation.
  const typedStatus = typed === undefined ? undefined : SchemaAST.resolve(typed.ast)?.httpApiStatus;
  if (typeof typedStatus === "number") {
    return httpFailureDetail(typedStatus, cause, (cause as ApiError)._tag);
  }

  if (HttpClientError.isHttpClientError(cause)) {
    if (cause.reason._tag === "TransportError") {
      const code = networkErrorCode(cause.reason.cause);
      return code === undefined ? { kind: "network" } : { code, kind: "network" };
    }
    const status = cause.response?.status;
    if (status === undefined) {
      return { kind: "unknown", name: cause.reason._tag };
    }
    // The client also fails a status the endpoint does not declare (a
    // proxy's 403 or 502) as a DecodeError; only a 2xx is an unreadable answer.
    return status >= 200 && status <= 299
      ? { kind: "decode", status }
      : httpFailureDetail(status, cause);
  }

  if (Schema.isSchemaError(cause)) {
    return { kind: "decode" };
  }

  return cause instanceof Error ? { kind: "unknown", name: cause.name } : { kind: "unknown" };
}

function httpFailureDetail(status: number, cause: unknown, tag?: string): ApiFailureDetail {
  const retryAfterSeconds = status === 429 ? rateLimitRetryAfterSeconds(cause) : undefined;
  return {
    kind: "http",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    status,
    ...(tag === undefined ? {} : { tag }),
  };
}

/** The first string `code` down a fetch error's cause chain (ENOTFOUND, ECONNRESET, ...). */
function networkErrorCode(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * Whether a later attempt can succeed where this one failed: no answer
 * (timeout, network), a server error (5xx) or a rate limit (429). A decoded
 * `Unauthorized` (401), any other 4xx and an unreadable answer are final.
 */
function isTransientApiFailure(cause: unknown): boolean {
  const detail = describeApiFailure(cause);
  switch (detail.kind) {
    case "network":
    case "timeout":
      return true;
    case "http":
      return detail.status === 429 || detail.status >= 500;
    case "decode":
    case "unknown":
      return false;
  }
}

/** A short phrase, e.g. "network unavailable (ENOTFOUND)" or "HTTP 403 Forbidden". */
function formatApiFailureDetail(detail: ApiFailureDetail): string {
  switch (detail.kind) {
    case "decode":
      return `the tokenmaxxing API sent a response the CLI could not read${
        detail.status === undefined ? "" : ` (HTTP ${detail.status})`
      }`;
    case "http":
      return `the tokenmaxxing API answered HTTP ${detail.status}${
        detail.tag === undefined ? "" : ` ${detail.tag}`
      }`;
    case "network":
      if (detail.code === undefined) {
        return "network error";
      }
      return NETWORK_UNAVAILABLE_CODES.has(detail.code)
        ? `network unavailable (${detail.code})`
        : `network error (${detail.code})`;
    case "timeout":
      return detail.timeoutMs === undefined
        ? "timed out"
        : `timed out after ${formatSeconds(detail.timeoutMs)}`;
    case "unknown":
      return detail.name === undefined ? "unexpected error" : `unexpected error (${detail.name})`;
  }
}

/** Whether `apiFailureMessage` has specific wording and a specific hint for `cause`. */
function isKnownApiFailure(cause: unknown): boolean {
  return (
    rateLimitRetryAfterSeconds(cause) !== undefined ||
    cause instanceof ApiTimeoutError ||
    serverErrorStatus(cause) !== undefined
  );
}

/**
 * `error: <summary>` plus a hint, naming a timeout, rate limit or server
 * error when that is what `cause` is. Otherwise the hint is `fallbackHint`,
 * after what the failure was (a network error code, an HTTP status) when
 * that is known.
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
  const status = serverErrorStatus(cause);
  if (status !== undefined) {
    return `error: ${summary}; the tokenmaxxing API had a server error (HTTP ${status})\nhint: the problem is on the tokenmaxxing side; try again later`;
  }

  const detail = describeApiFailure(cause);
  return detail.kind === "unknown"
    ? `error: ${summary}\nhint: ${fallbackHint}`
    : `error: ${summary}; ${formatApiFailureDetail(detail)}\nhint: ${fallbackHint}`;
}

function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

export {
  apiFailureMessage,
  ApiRetryError,
  ApiTimeoutError,
  describeApiFailure,
  formatApiFailureDetail,
  isKnownApiFailure,
  isTransientApiFailure,
  LOGIN_REQUEST_TIMEOUT_MS,
  ME_RETRY_POLICY,
  ME_TIMEOUT_MS,
  rateLimitRetryAfterSeconds,
  SCHEDULED_ME_RETRY_POLICY,
  USAGE_UPLOAD_TIMEOUT_MS,
  withApiRetry,
  withApiTimeout,
};
export type { ApiFailureDetail, ApiRetryPolicy };
