import { describe, expect, it } from "vite-plus/test";
import { Forbidden, Unauthorized, UserNotFound } from "@tokenmaxxing/api-contract";

import { isApiError, isRetryableApiError } from "./api";

describe("API error classification", () => {
  it("never retries deliberate contract failures", () => {
    expect(isRetryableApiError(new Unauthorized({ message: "no session" }))).toBe(false);
    expect(isRetryableApiError(new Forbidden({ message: "admins only" }))).toBe(false);
    expect(isRetryableApiError(new UserNotFound({ login: "ghost" }))).toBe(false);
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
