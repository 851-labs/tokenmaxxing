import { describe, expect, it } from "vite-plus/test";

import { loginErrorMessage, loginSearchSchema, sanitizeLoginRedirectPath } from "./login";

describe("sanitizeLoginRedirectPath", () => {
  it("keeps same-site paths including query strings", () => {
    expect(sanitizeLoginRedirectPath("/login/cli?code=ABCD-1234")).toBe(
      "/login/cli?code=ABCD-1234",
    );
    expect(sanitizeLoginRedirectPath("/a/../settings")).toBe("/settings");
  });

  it("rejects external and protocol-relative redirects", () => {
    expect(sanitizeLoginRedirectPath("https://evil.example/login")).toBeUndefined();
    expect(sanitizeLoginRedirectPath("//evil.example/login")).toBeUndefined();
    expect(sanitizeLoginRedirectPath("settings")).toBeUndefined();
  });

  it.each([
    "/.//evil.com",
    "/a/..//evil.com",
    "/..//evil.com",
    "/%2e//evil.com",
    "/.\\/evil.com",
    "/\\evil.com",
  ])("rejects %s, which normalises to a protocol-relative path", (value) => {
    expect(sanitizeLoginRedirectPath(value)).toBeUndefined();
  });
});

describe("login search", () => {
  it("parses the OAuth callback error and drops unknown values", () => {
    expect(
      loginSearchSchema.parse({
        error: "oauth_account_conflict",
        provider: "google",
        redirect: "/.//evil.com",
      }),
    ).toEqual({ error: "oauth_account_conflict", provider: "google", redirect: undefined });
    expect(loginSearchSchema.parse({ error: "<script>", provider: "evil" })).toEqual({
      error: undefined,
      provider: undefined,
      redirect: undefined,
    });
  });

  it("renders provider-specific callback errors", () => {
    expect(loginErrorMessage("oauth_account_conflict", "google")).toBe(
      "That Google account is already connected to another tokenmaxxing profile.",
    );
    expect(loginErrorMessage("oauth_failed", "github")).toBe("GitHub sign-in failed; try again.");
    expect(loginErrorMessage("oauth_state_mismatch")).toBe("Sign-in expired; try again.");
  });
});
