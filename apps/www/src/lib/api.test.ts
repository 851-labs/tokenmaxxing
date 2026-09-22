import { describe, expect, it } from "vite-plus/test";
import * as Contract from "@tokenmaxxing/api-contract";
import { Forbidden, Unauthorized, UserNotFound } from "@tokenmaxxing/api-contract";

import { isApiError, isRetryableApiError } from "./api";

describe("API error classification", () => {
  it("never retries deliberate contract failures", () => {
    expect(isRetryableApiError(new Unauthorized({ message: "no session" }))).toBe(false);
    expect(isRetryableApiError(new Forbidden({ message: "admins only" }))).toBe(false);
    expect(isRetryableApiError(new UserNotFound({ login: "ghost" }))).toBe(false);
  });

  it("covers every error class the contract exports", () => {
    const errorClasses = Object.entries(Contract).filter(
      ([, value]) => typeof value === "function" && value.prototype instanceof Error,
    );

    expect(errorClasses.length).toBeGreaterThan(0);
    for (const [name, ErrorClass] of errorClasses) {
      const instance = Object.create((ErrorClass as { prototype: object }).prototype) as unknown;
      expect({ name, retryable: isRetryableApiError(instance) }).toEqual({
        name,
        retryable: false,
      });
    }
  });

  it("retries transport and unexpected failures", () => {
    expect(isRetryableApiError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableApiError(new Error("500"))).toBe(true);
  });

  it("matches contract errors by tag", () => {
    expect(isApiError(new UserNotFound({ login: "ghost" }), "UserNotFound")).toBe(true);
    expect(isApiError(new UserNotFound({ login: "ghost" }), "Forbidden")).toBe(false);
  });
});
