import { Cause, Context, Effect, Logger, Option } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it } from "vite-plus/test";

import { AccountLinkConflict, AuthService, type OAuthProfile } from "../../auth/service";
import { AppConfig } from "../../config";
import { makeGitHubProvider } from "../../oauth/github";
import { OAuthStatusError } from "../../oauth/provider";
import { OAuthProviders } from "../../oauth/registry";
import { makeTestLogger } from "../../testing/logger";
import { TokensService, type TokensServiceShape } from "../../tokens/service";
import {
  defaultOAuthRedirectPath,
  encodeOAuthState,
  oauthErrorLocation,
  OAuthRoutesLive,
  redirectPathFromOAuthState,
  sanitizeOAuthRedirectPath,
} from "./oauth";
import { UserId } from "@tokenmaxxing/api-contract";

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

describe("sanitizeOAuthRedirectPath dot-segment bypasses", () => {
  it.each([
    "/.//evil.com",
    "/a/..//evil.com",
    "/..//evil.com",
    "/%2e//evil.com",
    "/.\\/evil.com",
    "/./\\evil.com",
    "/\\evil.com",
  ])("rejects %s, which normalises to a protocol-relative path", (value) => {
    expect(sanitizeOAuthRedirectPath(value)).toBeNull();
  });

  it("still normalises harmless dot segments", () => {
    expect(sanitizeOAuthRedirectPath("/a/../settings")).toBe("/settings");
  });

  it("rejects dot-segment bypasses smuggled through oauth state", () => {
    expect(redirectPathFromOAuthState(encodeOAuthState("nonce", "/a/..//evil.com"))).toBeNull();
  });
});

describe("oauth routes", () => {
  it("binds the start redirect to state and PKCE cookies", async () => {
    const { handler } = oauthHandler();

    const response = await handler(
      new Request("https://api.tokenmaxxing.sh/auth/github/start?redirect=/settings", {
        headers: { host: "api.tokenmaxxing.sh" },
      }),
    );
    const location = new URL(response.headers.get("location") ?? "");
    const cookies = setCookies(response);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = cookieValue(cookies, "tmx_oauth_state");
    const verifier = cookieValue(cookies, "tmx_oauth_pkce");
    expect(location.searchParams.get("state")).toBe(state);
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(location.searchParams.get("code_challenge")).toBe(await s256(verifier!));
    expect(redirectPathFromOAuthState(state!)).toBe("/settings");
  });

  it("exchanges with the PKCE verifier, clears round-trip cookies, and drops the prior session", async () => {
    const { calls, handler } = oauthHandler();
    const state = encodeOAuthState("nonce", "/settings");

    const response = await handler(
      callbackRequest(`code=abc&state=${state}`, {
        tmx_oauth_pkce: "verifier-123",
        tmx_oauth_state: state,
        tmx_session: "old-session",
      }),
    );
    const cookies = setCookies(response);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://tokenmaxxing.sh/settings");
    expect(calls.exchanges).toEqual([{ code: "abc", codeVerifier: "verifier-123" }]);
    expect(calls.signOuts).toEqual(["old-session"]);
    expect(cookieValue(cookies, "tmx_session")).toBe("new-session");
    expectCleared(cookies, "tmx_oauth_state");
    expectCleared(cookies, "tmx_oauth_pkce");
  });

  it("redirects a state mismatch to www login instead of returning json", async () => {
    const { calls, handler } = oauthHandler();
    const state = encodeOAuthState("nonce", "/login/cli?code=ABCD-1234");

    const response = await handler(
      callbackRequest("code=abc&state=forged", {
        tmx_oauth_pkce: "verifier-123",
        tmx_oauth_state: state,
      }),
    );
    const location = new URL(response.headers.get("location") ?? "");
    const cookies = setCookies(response);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://tokenmaxxing.sh/login");
    expect(location.searchParams.get("error")).toBe("oauth_state_mismatch");
    expect(location.searchParams.get("provider")).toBe("github");
    expect(location.searchParams.get("redirect")).toBe("/login/cli?code=ABCD-1234");
    expect(calls.exchanges).toEqual([]);
    expectCleared(cookies, "tmx_oauth_state");
    expectCleared(cookies, "tmx_oauth_pkce");
  });

  it("rejects a callback without the PKCE verifier cookie", async () => {
    const { calls, handler } = oauthHandler();
    const state = encodeOAuthState("nonce", null);

    const response = await handler(
      callbackRequest(`code=abc&state=${state}`, { tmx_oauth_state: state }),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "oauth_state_mismatch",
    );
    expect(calls.exchanges).toEqual([]);
  });

  it("redirects provider failures and link conflicts to www login", async () => {
    const state = encodeOAuthState("nonce", null);
    const cookies = { tmx_oauth_pkce: "verifier-123", tmx_oauth_state: state };

    const failing = oauthHandler({ exchange: "fail" });
    const failed = await failing.handler(callbackRequest(`code=abc&state=${state}`, cookies));
    expect(new URL(failed.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "oauth_failed",
    );
    expect(failing.calls.signOuts).toEqual([]);
    expect(failing.logs.entries).toEqual([
      expect.objectContaining({ level: "Error", message: "github oauth callback failed" }),
    ]);
    expect(failing.logs.entries.map((entry) => Cause.squash(entry.cause))).toEqual([
      expect.any(OAuthStatusError),
    ]);

    const conflicting = oauthHandler({ signIn: "conflict" });
    const conflict = await conflicting.handler(
      callbackRequest(`code=abc&state=${state}`, { ...cookies, tmx_session: "old-session" }),
    );
    expect(new URL(conflict.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "oauth_account_conflict",
    );
    expect(conflicting.calls.signOuts).toEqual([]);
    // A link conflict is an expected outcome, not an incident.
    expect(conflicting.logs.entries).toEqual([]);
  });

  it("fails the callback when the prior session cannot be checked", async () => {
    // Reading a lookup fault as signed out would sign in fresh instead of
    // linking the provider to the signed-in account.
    const state = encodeOAuthState("nonce", null);
    const { calls, handler, logs } = oauthHandler({ resolveSession: "fail" });

    const response = await handler(
      callbackRequest(`code=abc&state=${state}`, {
        tmx_oauth_pkce: "verifier-123",
        tmx_oauth_state: state,
        tmx_session: "old-session",
      }),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "oauth_failed",
    );
    expect(calls.exchanges).toEqual([]);
    expect(logs.entries).toEqual([
      expect.objectContaining({ level: "Error", message: "github oauth callback failed" }),
    ]);
  });
});

describe("sign-out", () => {
  function signout(headers: Record<string, string>) {
    const oauth = oauthHandler();
    const response = oauth.handler(
      new Request("https://api.tokenmaxxing.sh/auth/signout", {
        headers: { cookie: "tmx_session=old-session", host: "api.tokenmaxxing.sh", ...headers },
        method: "POST",
      }),
    );

    return { calls: oauth.calls, response };
  }

  it.each([
    ["www", { origin: "https://tokenmaxxing.sh" }],
    ["the API itself", { origin: "https://api.tokenmaxxing.sh" }],
    ["a same-site request without Origin", { "sec-fetch-site": "same-site" }],
    ["a non-browser client", {}],
  ])("signs out a request from %s", async (_from, headers) => {
    const { calls, response } = signout(headers);
    const signedOut = await response;

    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({ ok: true });
    expectCleared(setCookies(signedOut), "tmx_session");
    expect(calls.signOuts).toEqual(["old-session"]);
  });

  it.each([
    ["another origin", { origin: "https://evil.example" }],
    ["an opaque origin", { origin: "null" }],
    ["a look-alike subdomain", { origin: "https://tokenmaxxing.sh.evil.example" }],
    ["a cross-site request without Origin", { "sec-fetch-site": "cross-site" }],
  ])("refuses a cross-site sign-out from %s", async (_from, headers) => {
    const { calls, response } = signout(headers);
    const refused = await response;

    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toContain("application/json");
    expect(await refused.json()).toEqual({
      _tag: "Forbidden",
      message: "Cross-site sign-out is not allowed.",
    });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(calls.signOuts).toEqual([]);
  });
});

describe("oauthErrorLocation", () => {
  it("points at www login with the error, provider, and sanitized redirect", () => {
    expect(
      oauthErrorLocation("https://tokenmaxxing.sh", "oauth_failed", "google", "/settings"),
    ).toBe("https://tokenmaxxing.sh/login?error=oauth_failed&provider=google&redirect=%2Fsettings");
  });
});

const USER = { avatarUrl: null, id: UserId.make("user_1"), login: "alex", name: null };

const CONFIG = AppConfig.of({
  adminEmails: [],
  apiWorkerName: "tokenmaxxing-api",
  corsOrigins: ["https://tokenmaxxing.sh"],
  github: { clientId: "github-client", clientSecret: "github-secret" },
  google: { clientId: "google-client", clientSecret: "google-secret" },
  productName: "Tokenmaxxing",
});

function oauthHandler(
  options: { exchange?: "fail"; resolveSession?: "fail"; signIn?: "conflict" } = {},
) {
  const calls = {
    exchanges: [] as Array<{ code: string; codeVerifier: string }>,
    signOuts: [] as string[],
  };
  const profile: OAuthProfile = {
    avatarUrl: null,
    email: null,
    emailVerified: false,
    login: "alex",
    name: null,
    provider: "github",
    providerAccountId: "1",
  };
  // The real GitHub provider builds the authorize URL; only the network
  // half (code exchange, profile read) is faked.
  const github = Effect.runSync(
    makeGitHubProvider().pipe(
      Effect.provideService(AppConfig, CONFIG),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  const logs = makeTestLogger();
  const services = Context.empty().pipe(
    Context.add(Logger.CurrentLoggers, new Set([logs.logger])),
    Context.add(AppConfig, CONFIG),
    Context.add(
      AuthService,
      AuthService.of({
        listAccounts: () => Effect.succeed([]),
        resolveSession: (token) =>
          options.resolveSession === "fail"
            ? Effect.die(new Error("D1 down"))
            : Effect.succeed(token === "old-session" ? Option.some(USER) : Option.none()),
        signInWithProvider: () =>
          options.signIn === "conflict"
            ? Effect.fail(new AccountLinkConflict({ provider: "github" }))
            : Effect.succeed({ token: "new-session", user: USER }),
        signOut: (token) => Effect.sync(() => void calls.signOuts.push(token)),
      }),
    ),
    Context.add(OAuthProviders, {
      github: {
        ...github,
        exchangeCode: (code, _redirectUri, codeVerifier) =>
          options.exchange === "fail"
            ? Effect.fail(
                new OAuthStatusError({
                  provider: "github",
                  status: 500,
                  url: "https://github.com/login/oauth/access_token",
                }),
              )
            : Effect.sync(() => {
                calls.exchanges.push({ code, codeVerifier });
                return "access-token";
              }),
        fetchProfile: () => Effect.succeed(profile),
      },
      google: {
        id: "google",
        authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
        exchangeCode: () => Effect.die("unused"),
        fetchProfile: () => Effect.die("unused"),
      },
    }),
    // The callback resolves the prior viewer from the session cookie only.
    Context.add(TokensService, {} as TokensServiceShape),
  );
  const { handler } = HttpRouter.toWebHandler(OAuthRoutesLive, { disableLogger: true });

  return { calls, handler: (request: Request) => handler(request, services), logs };
}

function callbackRequest(query: string, cookies: Record<string, string>): Request {
  return new Request(`https://api.tokenmaxxing.sh/auth/github/callback?${query}`, {
    headers: {
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      host: "api.tokenmaxxing.sh",
    },
  });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const cookie = cookies.find((entry) => entry.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1).split(";")[0];
}

function expectCleared(cookies: string[], name: string) {
  const cookie = cookies.find((entry) => entry.startsWith(`${name}=`));
  expect(cookie).toBeDefined();
  expect(cookie).toContain("Max-Age=0");
  expect(cookie).toContain("Domain=.tokenmaxxing.sh");
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
