import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { describe, expect, it } from "vite-plus/test";
import * as Contract from "@tokenmaxxing/api-contract";
import {
  BadRequest,
  DeviceId,
  DeviceNotFound,
  Forbidden,
  InternalServerError,
  LoginCodeExpired,
  ServiceUnavailable,
  Unauthorized,
  TokenmaxxingApi,
  UserNotFound,
} from "@tokenmaxxing/api-contract";

import {
  errorMessage,
  hasSessionCookie,
  isApiError,
  isNotFoundApiError,
  isRetryableApiError,
} from "./api";

describe("API error classification", () => {
  it("never retries deliberate contract failures", () => {
    expect(isRetryableApiError(new Unauthorized({ message: "no session" }))).toBe(false);
    expect(isRetryableApiError(new Forbidden({ message: "admins only" }))).toBe(false);
    expect(isRetryableApiError(new UserNotFound({ login: "ghost" }))).toBe(false);
  });

  it("covers every error class the contract exports: only 5xx are retried", () => {
    const errorClasses = Object.entries(Contract).filter(
      ([, value]) => typeof value === "function" && value.prototype instanceof Error,
    );

    expect(errorClasses.length).toBeGreaterThan(0);
    for (const [name, ErrorClass] of errorClasses) {
      const instance = Object.create((ErrorClass as { prototype: object }).prototype) as unknown;
      expect({ name, retryable: isRetryableApiError(instance) }).toEqual({
        name,
        retryable: name === "InternalServerError" || name === "ServiceUnavailable",
      });
    }
  });

  it("retries server-side contract failures", () => {
    expect(isRetryableApiError(new ServiceUnavailable())).toBe(true);
    expect(isRetryableApiError(new InternalServerError())).toBe(true);
    expect(isRetryableApiError(new BadRequest())).toBe(false);
  });

  it("retries transport and unexpected failures", () => {
    expect(isRetryableApiError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableApiError(new Error("500"))).toBe(true);
  });

  it("matches contract errors by tag", () => {
    const error: unknown = new UserNotFound({ login: "ghost" });

    expect(isApiError(error, "UserNotFound")).toBe(true);
    expect(isApiError(error, "Forbidden")).toBe(false);
    if (isApiError(error, "UserNotFound")) {
      expect(error.login).toBe("ghost");
    }
  });
});

describe("isNotFoundApiError", () => {
  /** What the derived client rejects with when the API answers `response`. */
  async function profileFailure(response: Response): Promise<unknown> {
    const program = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(TokenmaxxingApi, {
        baseUrl: "https://api.tokenmaxxing.sh",
      });
      return yield* client.profiles.get({ params: { login: "a".repeat(101) } });
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        FetchHttpClient.Fetch,
        (async () => response) as unknown as typeof fetch,
      ),
    );

    return Effect.runPromise(program).then(
      () => {
        throw new Error("expected the call to fail");
      },
      (error: unknown) => error,
    );
  }

  it("recognises a typed UserNotFound", async () => {
    const error = await profileFailure(
      Response.json(
        { _tag: "UserNotFound", login: "ghost", message: "User not found." },
        { status: 404 },
      ),
    );

    expect(isApiError(error, "UserNotFound")).toBe(true);
    expect(isNotFoundApiError(error)).toBe(true);
  });

  it("recognises the router's RouteNotFound 404 and never retries it", async () => {
    // Effect's router caps params at 100 chars; the API answers longer logins
    // with the RouteNotFound envelope, which the profile endpoints declare.
    const error = await profileFailure(
      Response.json({ _tag: "RouteNotFound", message: "No such endpoint." }, { status: 404 }),
    );

    expect(isApiError(error, "RouteNotFound")).toBe(true);
    expect(isNotFoundApiError(error)).toBe(true);
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("leaves other failures alone", async () => {
    const error = await profileFailure(
      Response.json({ _tag: "InternalServerError", message: "Boom." }, { status: 500 }),
    );

    expect(isNotFoundApiError(error)).toBe(false);
    expect(isRetryableApiError(error)).toBe(true);
    expect(isNotFoundApiError(new TypeError("fetch failed"))).toBe(false);
  });
});

describe("errorMessage", () => {
  it("surfaces the default message every contract error carries", () => {
    expect(errorMessage(new DeviceNotFound({ id: DeviceId.make("device_1") }), "fallback")).toBe(
      "Device not found or already deleted.",
    );
    expect(errorMessage(new LoginCodeExpired({ code: "ABCD-1234" }), "fallback")).toBe(
      "Login code expired; run `tokenmaxxing login` again.",
    );
  });

  it("prefers a call-site message over the default", () => {
    expect(errorMessage(new Unauthorized({ message: "Session expired." }), "fallback")).toBe(
      "Session expired.",
    );
  });

  it("falls back for anything that is not a contract error", () => {
    expect(errorMessage(new Error("socket hang up"), "fallback")).toBe("fallback");
    expect(errorMessage({ _tag: "UserNotFound", message: "spoofed" }, "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
  });
});

describe("hasSessionCookie", () => {
  it("finds the API session cookie among others", () => {
    expect(hasSessionCookie("theme=dark; tmx_session=abc; other=1")).toBe(true);
    expect(hasSessionCookie("tmx_session=abc")).toBe(true);
  });

  it("is false without it, including for look-alike names", () => {
    expect(hasSessionCookie(undefined)).toBe(false);
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie("tmx_oauth_state=x; not_tmx_session=y")).toBe(false);
  });
});
