import { describe, expect, it } from "vite-plus/test";

import { securityHeaders, withSecurityHeaders } from "./security-headers";

describe("securityHeaders", () => {
  it.each(["/", "/login/cli", "/settings", "/stats"])("denies framing %s", (path) => {
    expect(securityHeaders(path)).toMatchObject({
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    });
  });

  it("lets /design frame the OG card templates from the same origin", () => {
    expect(securityHeaders("/og-card/pondorasti")).toMatchObject({
      "content-security-policy": "frame-ancestors 'self'",
      "x-frame-options": "SAMEORIGIN",
    });
    expect(securityHeaders("/og-cardigan")["x-frame-options"]).toBe("DENY");
  });

  it("sets HSTS, nosniff and a referrer policy everywhere", () => {
    expect(securityHeaders("/")).toMatchObject({
      "referrer-policy": "strict-origin-when-cross-origin",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
    });
  });
});

describe("withSecurityHeaders", () => {
  it("adds headers to immutable responses and keeps the ones a route set", async () => {
    const original = Response.redirect("https://tokenmaxxing.sh/login", 302);
    expect(() => original.headers.set("x-test", "1")).toThrow();

    const response = withSecurityHeaders(
      new Request("https://tokenmaxxing.sh/settings"),
      new Response("ok", {
        headers: { "content-type": "text/plain", "x-frame-options": "SAMEORIGIN" },
        status: 201,
      }),
    );
    const redirected = withSecurityHeaders(new Request("https://tokenmaxxing.sh/"), original);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("https://tokenmaxxing.sh/login");
    expect(redirected.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
