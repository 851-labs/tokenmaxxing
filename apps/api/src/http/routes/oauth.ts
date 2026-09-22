import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { AuthUser, OAuthProviderId } from "@tokenmaxxing/api-contract";

import {
  cookieOptions,
  PKCE_COOKIE,
  readCookie,
  SESSION_COOKIE,
  sessionTokenFrom,
  STATE_COOKIE,
} from "../../auth/cookies";
import { generateToken, pkceChallenge, toBase64Url } from "../../auth/crypto";
import {
  AuthService,
  type AuthServiceShape,
  type OAuthProfile,
  SESSION_TTL_MS,
} from "../../auth/service";
import { AppConfig, type AppConfigShape, type Deployment, deploymentForHost } from "../../config";
import { buildAuthorizeUrl, GitHubClient } from "../../github/client";
import { buildGoogleAuthorizeUrl, GoogleClient } from "../../google/client";

/**
 * Routes that cannot live in the HttpApi contract: the OAuth browser flow
 * (302 redirects + Set-Cookie). They register as raw router routes and share
 * the router's global middleware (CORS, request ids) with the contract
 * endpoints.
 *
 * The round trip is bound to the browser by two short-lived cookies: the
 * `state` (CSRF) and the PKCE code verifier. Both are cleared on every
 * callback outcome. Callback failures redirect back to www's /login with an
 * `error` code instead of stranding the user on a raw JSON body.
 */

type OAuthCallbackError = "oauth_account_conflict" | "oauth_failed" | "oauth_state_mismatch";

const OAUTH_ROUNDTRIP_MAX_AGE_SECONDS = 600;

const githubOAuthStartRoute = oauthStartRoute("github");
const googleOAuthStartRoute = oauthStartRoute("google");
const githubOAuthCallbackRoute = oauthCallbackRoute("github");
const googleOAuthCallbackRoute = oauthCallbackRoute("google");

function oauthStartRoute(provider: OAuthProviderId) {
  return HttpRouter.add(
    "GET",
    `/auth/${provider}/start`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* AppConfig;
      const deployment = deploymentForHost(request.headers["host"] ?? "");
      const url = new URL(request.url, "http://localhost");
      const redirectPath = sanitizeOAuthRedirectPath(url.searchParams.get("redirect"));
      const state = encodeOAuthState(generateToken(), redirectPath);
      const codeVerifier = generateToken();
      const codeChallenge = yield* pkceChallenge(codeVerifier);
      const roundtrip = cookieOptions(deployment, OAUTH_ROUNDTRIP_MAX_AGE_SECONDS);

      return HttpServerResponse.empty({ status: 302 }).pipe(
        HttpServerResponse.setHeader(
          "location",
          buildProviderAuthorizeUrl(
            provider,
            config,
            `${deployment.apiOrigin}/auth/${provider}/callback`,
            state,
            codeChallenge,
          ),
        ),
        HttpServerResponse.setCookiesUnsafe([
          [STATE_COOKIE, state, roundtrip],
          [PKCE_COOKIE, codeVerifier, roundtrip],
        ]),
      );
    }),
  );
}

function oauthCallbackRoute(provider: OAuthProviderId) {
  return HttpRouter.add(
    "GET",
    `/auth/${provider}/callback`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const deployment = deploymentForHost(request.headers["host"] ?? "");
      const url = new URL(request.url, "http://localhost");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expectedState = readCookie(request, STATE_COOKIE);
      const codeVerifier = readCookie(request, PKCE_COOKIE);
      // Only trust the redirect embedded in OUR cookie copy of the state.
      const redirectPath =
        expectedState === null ? null : redirectPathFromOAuthState(expectedState);
      if (
        code === null ||
        state === null ||
        expectedState === null ||
        codeVerifier === null ||
        state !== expectedState
      ) {
        return oauthErrorRedirect(deployment, "oauth_state_mismatch", provider, redirectPath);
      }

      const auth = yield* AuthService;
      // Browser round trip: only the cookie session counts (never a bearer).
      const priorSessionToken = readCookie(request, SESSION_COOKIE);
      const result = yield* Effect.gen(function* () {
        const currentUser = yield* currentUserFromSessionToken(priorSessionToken, auth);
        const profile = yield* fetchProviderProfile(
          provider,
          code,
          `${deployment.apiOrigin}/auth/${provider}/callback`,
          codeVerifier,
        ).pipe(Effect.orDie);
        // Provider access tokens are dropped here on purpose — identity is all
        // this product needs after sign-in/linking.
        const options = currentUser === null ? undefined : { currentUser };
        const signedIn = yield* auth.signInWithProvider(profile, options);
        return { _tag: "success" as const, ...signedIn };
      }).pipe(
        Effect.catchTag("AccountLinkConflict", () =>
          Effect.succeed({ _tag: "conflict" as const, provider }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError(`${provider} oauth callback failed`, cause).pipe(
            Effect.as({ _tag: "failed" as const }),
          ),
        ),
      );

      switch (result._tag) {
        case "conflict":
          return oauthErrorRedirect(deployment, "oauth_account_conflict", provider, redirectPath);
        case "failed":
          return oauthErrorRedirect(deployment, "oauth_failed", provider, redirectPath);
        case "success": {
          // Signing in again replaces the browser's session: drop the old row
          // so it cannot outlive the cookie it was issued for.
          if (priorSessionToken !== null && priorSessionToken !== result.token) {
            yield* auth.signOut(priorSessionToken).pipe(Effect.ignoreCause);
          }

          return HttpServerResponse.empty({ status: 302 }).pipe(
            HttpServerResponse.setHeader(
              "location",
              `${deployment.wwwOrigin}${redirectPath ?? defaultOAuthRedirectPath(result.user.login)}`,
            ),
            HttpServerResponse.setCookiesUnsafe([
              ...clearedRoundtripCookies(deployment),
              [SESSION_COOKIE, result.token, cookieOptions(deployment, SESSION_TTL_MS / 1000)],
            ]),
          );
        }
      }
    }),
  );
}

function oauthErrorRedirect(
  deployment: Deployment,
  error: OAuthCallbackError,
  provider: OAuthProviderId,
  redirectPath: string | null,
) {
  return HttpServerResponse.empty({ status: 302 }).pipe(
    HttpServerResponse.setHeader(
      "location",
      oauthErrorLocation(deployment.wwwOrigin, error, provider, redirectPath),
    ),
    HttpServerResponse.setCookiesUnsafe(clearedRoundtripCookies(deployment)),
  );
}

function oauthErrorLocation(
  wwwOrigin: string,
  error: OAuthCallbackError,
  provider: OAuthProviderId,
  redirectPath: string | null,
): string {
  const url = new URL("/login", wwwOrigin);
  url.searchParams.set("error", error);
  url.searchParams.set("provider", provider);
  if (redirectPath !== null) {
    url.searchParams.set("redirect", redirectPath);
  }

  return url.toString();
}

function clearedRoundtripCookies(deployment: Deployment) {
  const expired = cookieOptions(deployment, 0);
  return [
    [STATE_COOKIE, "", expired],
    [PKCE_COOKIE, "", expired],
  ] as const;
}

// Clears the cookie even for expired sessions, so it stays outside the
// Authorization middleware.
const signoutRoute = HttpRouter.add(
  "POST",
  "/auth/signout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const deployment = deploymentForHost(request.headers["host"] ?? "");
    const token = sessionTokenFrom(request);
    if (token !== null) {
      const auth = yield* AuthService;
      // Best effort: the cookie is cleared regardless, and a row that
      // survives a failed delete still expires on its own.
      yield* auth.signOut(token).pipe(Effect.ignoreCause);
    }

    return HttpServerResponse.jsonUnsafe({ ok: true }).pipe(
      HttpServerResponse.setCookiesUnsafe([[SESSION_COOKIE, "", cookieOptions(deployment, 0)]]),
    );
  }),
);

const oauthRoutesLayer = Layer.mergeAll(
  githubOAuthStartRoute,
  githubOAuthCallbackRoute,
  googleOAuthStartRoute,
  googleOAuthCallbackRoute,
  signoutRoute,
);

function buildProviderAuthorizeUrl(
  provider: OAuthProviderId,
  config: AppConfigShape,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  switch (provider) {
    case "github":
      return buildAuthorizeUrl(config.github, redirectUri, state, codeChallenge);
    case "google":
      return buildGoogleAuthorizeUrl(config.google, redirectUri, state, codeChallenge);
  }
}

function fetchProviderProfile(
  provider: OAuthProviderId,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Effect.Effect<OAuthProfile, unknown, GitHubClient | GoogleClient> {
  switch (provider) {
    case "github":
      return Effect.gen(function* () {
        const github = yield* GitHubClient;
        const accessToken = yield* github.exchangeCode(code, redirectUri, codeVerifier);
        return yield* github.fetchUser(accessToken);
      });
    case "google":
      return Effect.gen(function* () {
        const google = yield* GoogleClient;
        const accessToken = yield* google.exchangeCode(code, redirectUri, codeVerifier);
        return yield* google.fetchUser(accessToken);
      });
  }
}

function currentUserFromSessionToken(
  token: string | null,
  auth: AuthServiceShape,
): Effect.Effect<AuthUser | null> {
  if (token === null) {
    return Effect.succeed(null);
  }

  return auth.resolveSession(token).pipe(
    Effect.map((user) => (Option.isSome(user) ? user.value : null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
}

function sanitizeOAuthRedirectPath(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return null;
  }

  try {
    const url = new URL(trimmed, "https://tokenmaxxing.invalid");
    if (url.origin !== "https://tokenmaxxing.invalid") {
      return null;
    }

    // Dot-segment normalisation can collapse "/.//evil.com" or
    // "/a/..//evil.com" into "//evil.com" — protocol-relative once a browser
    // or router resolves it. Judge the normalised output, not the input.
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (path.startsWith("//")) {
      return null;
    }

    return path;
  } catch {
    return null;
  }
}

function encodeOAuthState(nonce: string, redirectPath: string | null): string {
  if (redirectPath === null) {
    return nonce;
  }

  return `${nonce}.${toBase64Url(new TextEncoder().encode(redirectPath))}`;
}

function redirectPathFromOAuthState(state: string): string | null {
  const encodedRedirect = state.split(".", 2)[1];
  if (encodedRedirect === undefined || encodedRedirect.length === 0) {
    return null;
  }

  const redirectPath = base64UrlDecode(encodedRedirect);
  if (redirectPath === null) {
    return null;
  }

  return sanitizeOAuthRedirectPath(redirectPath);
}

function defaultOAuthRedirectPath(login: string): string {
  return `/${encodeURIComponent(login)}`;
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export {
  encodeOAuthState,
  defaultOAuthRedirectPath,
  oauthErrorLocation,
  oauthRoutesLayer,
  redirectPathFromOAuthState,
  sanitizeOAuthRedirectPath,
};
