import { describe, expect, it } from "vite-plus/test";

import {
  defaultOAuthRedirectPath,
  encodeOAuthState,
  redirectPathFromOAuthState,
  sanitizeOAuthRedirectPath,
} from "./oauth";

describe("sanitizeOAuthRedirectPath", () => {
  it("keeps same-site paths including query strings", () => {
    expect(sanitizeOAuthRedirectPath("/login/cli?code=ABCD-1234")).toBe(
      "/login/cli?code=ABCD-1234",
    );
  });

  it("falls back for missing or external redirects", () => {
    expect(sanitizeOAuthRedirectPath(null)).toBeNull();
    expect(sanitizeOAuthRedirectPath("https://evil.example/login/cli")).toBeNull();
    expect(sanitizeOAuthRedirectPath("//evil.example/login/cli")).toBeNull();
  });
});

describe("redirectPathFromOAuthState", () => {
  it("round-trips the redirect embedded in oauth state", () => {
    const state = encodeOAuthState("nonce", "/login/cli?code=ABCD-1234");

    expect(redirectPathFromOAuthState(state)).toBe("/login/cli?code=ABCD-1234");
  });

  it("falls back for malformed state", () => {
    expect(redirectPathFromOAuthState("nonce")).toBeNull();
    expect(redirectPathFromOAuthState("nonce.not-base64-url")).toBeNull();
  });

  it("round-trips oauth state without a redirect", () => {
    const state = encodeOAuthState("nonce", null);

    expect(state).toBe("nonce");
    expect(redirectPathFromOAuthState(state)).toBeNull();
  });
});

describe("defaultOAuthRedirectPath", () => {
  it("uses the signed-in user's profile path", () => {
    expect(defaultOAuthRedirectPath("pondorasti")).toBe("/pondorasti");
    expect(defaultOAuthRedirectPath("name/with/slashes")).toBe("/name%2Fwith%2Fslashes");
  });
});
