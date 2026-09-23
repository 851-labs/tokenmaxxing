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
  UserNotFound,
} from "@tokenmaxxing/api-contract";

import { errorMessage, isApiError, isRetryableApiError } from "./api";

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
