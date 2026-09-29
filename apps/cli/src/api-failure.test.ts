import { Cause, Effect, Exit, Fiber, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import {
  InternalServerError,
  ServiceUnavailable,
  TooManyRequests,
} from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

import {
  apiFailureMessage,
  ApiTimeoutError,
  rateLimitRetryAfterSeconds,
  withApiTimeout,
} from "./api-failure";

function statusError(status: number, headers: Record<string, string> = {}) {
  const request = HttpClientRequest.get("https://api.tokenmaxxing.example/me");
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response(null, { headers, status })),
    }),
  });
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
      "error: failed\nhint: check your network",
    );
  });

  it("falls back to the caller's hint", () => {
    expect(apiFailureMessage("failed", new Error("boom"), "check your network")).toBe(
      "error: failed\nhint: check your network",
    );
  });
});
