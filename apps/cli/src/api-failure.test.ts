import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import {
  Forbidden,
  InternalServerError,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
} from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

import {
  apiFailureMessage,
  type ApiRetryPolicy,
  ApiRetryError,
  ApiTimeoutError,
  describeApiFailure,
  formatApiFailureDetail,
  isTransientApiFailure,
  ME_RETRY_POLICY,
  rateLimitRetryAfterSeconds,
  SCHEDULED_ME_RETRY_POLICY,
  withApiRetry,
  withApiTimeout,
} from "./api-failure";
import { ClockService } from "./services";

const request = HttpClientRequest.get("https://api.tokenmaxxing.example/me").pipe(
  HttpClientRequest.setHeader("authorization", "Bearer tmx_secret"),
);

function statusError(status: number, headers: Record<string, string> = {}) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response(null, { headers, status })),
    }),
  });
}

/** How the contract client fails a response it cannot read. */
function decodeError(status: number) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response("<html>", { status })),
    }),
  });
}

/** A fetch that never got an answer, shaped like Bun's (`code` on the error) or Node's (on its cause). */
function transportError(cause: unknown) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ cause, request }),
  });
}

function fetchError(code: string, runtime: "bun" | "node") {
  return runtime === "bun"
    ? Object.assign(new TypeError("Unable to connect"), { code })
    : new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

describe("withApiTimeout", () => {
  it("fails with ApiTimeoutError when the call never answers", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(withApiTimeout(Effect.never, 15_000)));
        yield* TestClock.adjust("15 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(error).toBeInstanceOf(ApiTimeoutError);
    expect((error as ApiTimeoutError).message).toBe(
      "the tokenmaxxing API did not answer within 15 s",
    );
  });

  it("passes a timely answer through", async () => {
    await expect(Effect.runPromise(withApiTimeout(Effect.succeed(1), 15_000))).resolves.toBe(1);
  });
});

describe("rateLimitRetryAfterSeconds", () => {
  it("reads a typed TooManyRequests", () => {
    expect(rateLimitRetryAfterSeconds(new TooManyRequests({ retryAfterSeconds: 42 }))).toBe(42);
  });

  it("reads Retry-After from any 429, in seconds or as an HTTP date", () => {
    expect(rateLimitRetryAfterSeconds(statusError(429, { "retry-after": "60" }))).toBe(60);
    expect(
      rateLimitRetryAfterSeconds(
        statusError(429, { "retry-after": "Tue, 29 Sep 2026 04:12:45 GMT" }),
        () => Date.parse("Tue, 29 Sep 2026 04:11:45 GMT"),
      ),
    ).toBe(60);
    expect(rateLimitRetryAfterSeconds(statusError(429))).toBeNull();
    expect(rateLimitRetryAfterSeconds(statusError(429, { "retry-after": "soon" }))).toBeNull();
  });

  it("is undefined for anything that is not a rate limit", () => {
    expect(rateLimitRetryAfterSeconds(statusError(503, { "retry-after": "60" }))).toBeUndefined();
    expect(rateLimitRetryAfterSeconds(new Error("network"))).toBeUndefined();
  });
});

describe("apiFailureMessage", () => {
  it("says how long to wait when rate limited", () => {
    expect(
      apiFailureMessage(
        "failed to push usage to tokenmaxxing",
        statusError(429, { "retry-after": "60" }),
        "check your network",
      ),
    ).toBe(
      "error: failed to push usage to tokenmaxxing; the tokenmaxxing API is rate limiting requests\nhint: try again in 60 s",
    );
    expect(apiFailureMessage("failed", statusError(429), "x")).toBe(
      "error: failed; the tokenmaxxing API is rate limiting requests\nhint: try again in a minute",
    );
  });

  it("names a timeout", () => {
    expect(apiFailureMessage("failed", new ApiTimeoutError({ timeoutMs: 60_000 }), "x")).toBe(
      "error: failed; the tokenmaxxing API did not answer within 60 s\nhint: check your network, then try again",
    );
  });

  it("says a server error (5xx) is not the network", () => {
    expect(apiFailureMessage("failed", statusError(502), "check your network")).toBe(
      "error: failed; the tokenmaxxing API had a server error (HTTP 502)\nhint: the problem is on the tokenmaxxing side; try again later",
    );
    expect(apiFailureMessage("failed", new InternalServerError({}), "x")).toContain("(HTTP 500)");
    expect(apiFailureMessage("failed", new ServiceUnavailable({}), "x")).toContain("(HTTP 503)");
    expect(apiFailureMessage("failed", statusError(404), "check your network")).toBe(
      "error: failed; the tokenmaxxing API answered HTTP 404\nhint: check your network",
    );
  });

  it("falls back to the caller's hint", () => {
    expect(apiFailureMessage("failed", new Error("boom"), "check your network")).toBe(
      "error: failed\nhint: check your network",
    );
  });
});

describe("describeApiFailure", () => {
  it("names a timeout and how long it waited", () => {
    const timeout = describeApiFailure(new ApiTimeoutError({ timeoutMs: 15_000 }));
    expect(timeout).toEqual({ kind: "timeout", timeoutMs: 15_000 });
    expect(formatApiFailureDetail(timeout)).toBe("timed out after 15 s");
    expect(describeApiFailure(new Cause.TimeoutError())).toEqual({ kind: "timeout" });
  });

  it.each(["bun", "node"] as const)("reads the network error code from %s's fetch", (runtime) => {
    const offline = describeApiFailure(transportError(fetchError("ENOTFOUND", runtime)));
    expect(offline).toEqual({ code: "ENOTFOUND", kind: "network" });
    expect(formatApiFailureDetail(offline)).toBe("network unavailable (ENOTFOUND)");

    const reset = describeApiFailure(transportError(fetchError("ECONNRESET", runtime)));
    expect(formatApiFailureDetail(reset)).toBe("network error (ECONNRESET)");
  });

  it("still calls a transport failure without a code a network error", () => {
    const detail = describeApiFailure(transportError(new TypeError("fetch failed")));
    expect(detail).toEqual({ kind: "network" });
    expect(formatApiFailureDetail(detail)).toBe("network error");
  });

  it("reports the status and the typed _tag of an HTTP error", () => {
    expect(describeApiFailure(statusError(502))).toEqual({ kind: "http", status: 502 });
    // An undeclared status fails as a DecodeError; it is still an HTTP error.
    expect(describeApiFailure(decodeError(403))).toEqual({ kind: "http", status: 403 });
    const typed = describeApiFailure(new ServiceUnavailable({}));
    expect(typed).toEqual({ kind: "http", status: 503, tag: "ServiceUnavailable" });
    expect(formatApiFailureDetail(typed)).toBe(
      "the tokenmaxxing API answered HTTP 503 ServiceUnavailable",
    );
    expect(describeApiFailure(new Unauthorized({}))).toEqual({
      kind: "http",
      status: 401,
      tag: "Unauthorized",
    });
    expect(describeApiFailure(new TooManyRequests({ retryAfterSeconds: 5 }))).toEqual({
      kind: "http",
      retryAfterSeconds: 5,
      status: 429,
      tag: "TooManyRequests",
    });
    expect(describeApiFailure(statusError(429))).toEqual({
      kind: "http",
      retryAfterSeconds: null,
      status: 429,
    });
  });

  it("calls a 2xx the CLI could not read a decode failure", () => {
    const detail = describeApiFailure(decodeError(200));
    expect(detail).toEqual({ kind: "decode", status: 200 });
    expect(formatApiFailureDetail(detail)).toBe(
      "the tokenmaxxing API sent a response the CLI could not read (HTTP 200)",
    );
    const schemaError = Schema.decodeUnknownExit(Schema.String)(1);
    const cause = Exit.isFailure(schemaError)
      ? Option.getOrUndefined(Cause.findErrorOption(schemaError.cause))
      : undefined;
    expect(describeApiFailure(cause)).toEqual({ kind: "decode" });
  });

  it("names anything else by its error name only", () => {
    expect(describeApiFailure(new RangeError("tmx_secret"))).toEqual({
      kind: "unknown",
      name: "RangeError",
    });
    expect(describeApiFailure("boom")).toEqual({ kind: "unknown" });
  });

  it("never carries the request or its headers", () => {
    for (const cause of [statusError(502), decodeError(200), transportError(new Error("x"))]) {
      expect(JSON.stringify(describeApiFailure(cause))).not.toContain("tmx_secret");
      expect(apiFailureMessage("failed", cause, "hint")).not.toContain("tmx_secret");
    }
  });

  it("unwraps a retried call's last failure", () => {
    expect(describeApiFailure(new ApiRetryError({ attempts: 3, cause: statusError(503) }))).toEqual(
      { kind: "http", status: 503 },
    );
  });
});

describe("isTransientApiFailure", () => {
  it("is true for no answer, a server error or a rate limit", () => {
    for (const cause of [
      new ApiTimeoutError({ timeoutMs: 15_000 }),
      transportError(fetchError("ENOTFOUND", "bun")),
      statusError(502),
      new InternalServerError({}),
      new ServiceUnavailable({}),
      statusError(429),
      new TooManyRequests({ retryAfterSeconds: 1 }),
    ]) {
      expect(isTransientApiFailure(cause)).toBe(true);
    }
  });

  it("is false for a bad token, other 4xx and unreadable answers", () => {
    for (const cause of [
      new Unauthorized({}),
      statusError(401),
      new Forbidden({}),
      decodeError(404),
      decodeError(200),
      new Error("boom"),
    ]) {
      expect(isTransientApiFailure(cause)).toBe(false);
    }
  });
});

describe("withApiRetry", () => {
  const policy: ApiRetryPolicy = {
    attempts: 3,
    backoffMs: [1_000, 4_000],
    jitterRatio: 0,
    retryAfterMaxMs: 10_000,
    retryable: isTransientApiFailure,
    timeoutMs: 15_000,
  };

  /** Fails with each of `failures` in turn, then succeeds. */
  async function run(failures: unknown[], retryPolicy: ApiRetryPolicy = policy) {
    const sleeps: number[] = [];
    let calls = 0;
    const exit = await Effect.runPromiseExit(
      withApiRetry(() => {
        const failure = failures[calls];
        calls += 1;
        return failure === undefined ? Effect.succeed("ok") : Effect.fail(failure);
      }, retryPolicy).pipe(
        Effect.provide(
          Layer.succeed(ClockService)({
            sleep: (ms) => Effect.sync(() => void sleeps.push(ms)),
          }),
        ),
      ),
    );
    const error = Exit.isFailure(exit)
      ? (Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as ApiRetryError)
      : undefined;
    return { calls, error, exit, sleeps };
  }

  it("retries transient failures with backoff until one succeeds", async () => {
    const offline = transportError(fetchError("ENOTFOUND", "bun"));
    const { calls, exit, sleeps } = await run([offline, statusError(503)]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 4_000]);
  });

  it("gives up after the last attempt with its failure and the attempt count", async () => {
    const { calls, error, sleeps } = await run([
      statusError(502),
      statusError(502),
      new ApiTimeoutError({ timeoutMs: 15_000 }),
    ]);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 4_000]);
    expect(error).toBeInstanceOf(ApiRetryError);
    expect(error?.attempts).toBe(3);
    expect(error?.cause).toBeInstanceOf(ApiTimeoutError);
  });

  it("never retries a decoded Unauthorized or another final failure", async () => {
    for (const failure of [new Unauthorized({}), new Forbidden({}), decodeError(200)]) {
      const { calls, error, sleeps } = await run([failure, failure]);
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
      expect(error?.attempts).toBe(1);
      expect(error?.cause).toBe(failure);
    }
  });

  it("waits out a short Retry-After instead of the backoff", async () => {
    const { calls, exit, sleeps } = await run([statusError(429, { "retry-after": "7" })]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([7_000]);

    // Never shorter than the backoff.
    const typed = await run([new TooManyRequests({ retryAfterSeconds: 0 })]);
    expect(typed.sleeps).toEqual([1_000]);
  });

  it("stops at a Retry-After longer than the policy waits out", async () => {
    const { calls, error, sleeps } = await run([statusError(429, { "retry-after": "60" })]);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(error?.attempts).toBe(1);
  });

  it("times out an attempt that never answers, then retries it", async () => {
    let calls = 0;
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            withApiRetry(
              () => {
                calls += 1;
                return calls === 1 ? Effect.never : Effect.succeed("ok");
              },
              { ...policy, backoffMs: [0] },
            ),
          ),
        );
        yield* TestClock.adjust("15 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Layer.merge(TestClock.layer(), Layer.succeed(ClockService)({ sleep: () => Effect.void })),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries a scheduled /me three times, 1 s then 4 s apart (with jitter)", async () => {
    const offline = transportError(fetchError("ENETUNREACH", "node"));
    const { calls, sleeps } = await run([offline, offline, offline], {
      ...SCHEDULED_ME_RETRY_POLICY,
      random: () => 0.5,
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 4_000]);

    const jittered = await run([offline, offline, offline], {
      ...SCHEDULED_ME_RETRY_POLICY,
      random: () => 0,
    });
    expect(jittered.sleeps).toEqual([800, 3_200]);
  });

  it("retries an interactive /me once, quickly, but not after a timeout", async () => {
    const quick = await run([statusError(503), statusError(503)], ME_RETRY_POLICY);
    expect(quick.calls).toBe(2);
    expect(quick.sleeps).toEqual([500]);
    expect(quick.error?.attempts).toBe(2);

    const timedOut = await run([new ApiTimeoutError({ timeoutMs: 15_000 })], ME_RETRY_POLICY);
    expect(timedOut.calls).toBe(1);
  });
});
