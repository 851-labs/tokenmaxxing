import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { Forbidden, OAuthProviderId } from "@tokenmaxxing/api-contract";

import {
  cookieOptions,
  PKCE_COOKIE,
  readCookie,
  SESSION_COOKIE,
  sessionTokenFrom,
  STATE_COOKIE,
} from "../../auth/cookies";
import { generateToken, pkceChallenge, toBase64Url } from "../../auth/crypto";
import { AuthService, SESSION_TTL_MS } from "../../auth/service";
import { type Deployment, deploymentForHost } from "../../config";
import { OAuthProviders } from "../../oauth/registry";
import { resolveViewer } from "../viewer";

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

type OAuthCallbackError =
  | "oauth_account_conflict"
  | "oauth_cancelled"
  | "oauth_failed"
  | "oauth_state_mismatch";

const OAUTH_ROUNDTRIP_MAX_AGE_SECONDS = 600;

function oauthStartRoute(providerId: OAuthProviderId) {
  return HttpRouter.add(
    "GET",
    oauthStartPath(providerId),
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const provider = (yield* OAuthProviders)[providerId];
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
          provider.authorizeUrl(callbackUrl(deployment, providerId), state, codeChallenge),
        ),
        HttpServerResponse.setCookiesUnsafe([
          [STATE_COOKIE, state, roundtrip],
          [PKCE_COOKIE, codeVerifier, roundtrip],
        ]),
      );
    }),
  );
}

function oauthCallbackRoute(providerId: OAuthProviderId) {
  return HttpRouter.add(
    "GET",
    oauthCallbackPath(providerId),
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const provider = (yield* OAuthProviders)[providerId];
      const deployment = deploymentForHost(request.headers["host"] ?? "");
      const url = new URL(request.url, "http://localhost");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expectedState = readCookie(request, STATE_COOKIE);
      const codeVerifier = readCookie(request, PKCE_COOKIE);
      // Only trust the redirect embedded in OUR cookie copy of the state.
      const redirectPath =
        expectedState === null ? null : redirectPathFromOAuthState(expectedState);
      // The provider redirects back with `error` (and no code) when the user
      // declines or it cannot authorize; that is not a stale sign-in.
      const providerError = url.searchParams.get("error");
      if (providerError !== null) {
        return oauthErrorRedirect(
          deployment,
          providerError === "access_denied" ? "oauth_cancelled" : "oauth_failed",
          providerId,
          redirectPath,
        );
      }
      if (
        code === null ||
        state === null ||
        expectedState === null ||
        codeVerifier === null ||
        state !== expectedState
      ) {
        return oauthErrorRedirect(deployment, "oauth_state_mismatch", providerId, redirectPath);
      }

      const auth = yield* AuthService;
      // Browser round trip: only the cookie session counts (never a bearer).
      const priorSessionToken = readCookie(request, SESSION_COOKIE);
      const result = yield* Effect.gen(function* () {
        const currentUser = Option.getOrUndefined(
          yield* resolveViewer(priorSessionToken, { allowCliToken: false }),
        );
        const accessToken = yield* provider.exchangeCode(
          code,
          callbackUrl(deployment, providerId),
          codeVerifier,
        );
        // The provider access token is dropped after this read on purpose —
        // identity is all this product needs after sign-in/linking.
        const profile = yield* provider.fetchProfile(accessToken);
        const signedIn = yield* auth.signInWithProvider(profile, { currentUser });
        return { _tag: "success" as const, ...signedIn };
      }).pipe(
        Effect.catchTag("AccountLinkConflict", () => Effect.succeed({ _tag: "conflict" as const })),
        Effect.catchCause((cause) =>
          Effect.logError(`${providerId} oauth callback failed`, cause).pipe(
            Effect.as({ _tag: "failed" as const }),
          ),
        ),
      );

      switch (result._tag) {
        case "conflict":
          return oauthErrorRedirect(deployment, "oauth_account_conflict", providerId, redirectPath);
        case "failed":
          return oauthErrorRedirect(deployment, "oauth_failed", providerId, redirectPath);
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

const SIGNOUT_PATH = "/auth/signout";

/**
 * Clears the cookie even for expired sessions, so it stays outside the
 * Authorization middleware.
 *
 * CSRF: a cross-site page can POST here without a preflight (a form post or
 * a no-cors fetch is a CORS "simple request"), and the response's cookie
 * clear applies even when the Lax session cookie was not sent. Browsers send
 * `Origin` on every cross-origin POST, so only the serving deployment's www
 * (and the API itself) may sign out; www's
 * `fetch(..., { credentials: "include" })` qualifies as is.
 */
const signoutRoute = HttpRouter.add(
  "POST",
  SIGNOUT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const deployment = deploymentForHost(request.headers["host"] ?? "");
    if (isCrossSiteRequest(request, [deployment.wwwOrigin, deployment.apiOrigin])) {
      const error = new Forbidden({ message: "Cross-site sign-out is not allowed." });
      return HttpServerResponse.jsonUnsafe(
        { _tag: error._tag, message: error.message },
        { status: 403 },
      );
    }

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

/**
 * A browser request from a page outside `trustedOrigins`. Without `Origin`,
 * fall back to Fetch Metadata; a request carrying neither did not come from
 * a browser page, so there is no ambient session to forge.
 */
function isCrossSiteRequest(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlyArray<string>,
): boolean {
  const origin = request.headers["origin"];
  if (origin !== undefined) {
    return !trustedOrigins.includes(origin);
  }

  return request.headers["sec-fetch-site"] === "cross-site";
}

const OAuthRoutesLive = Layer.mergeAll(
  signoutRoute,
  ...OAuthProviderId.literals.flatMap((providerId) => [
    oauthStartRoute(providerId),
    oauthCallbackRoute(providerId),
  ]),
);

/** Every route above, for the router's 405 table (see layer.ts). */
const OAUTH_ROUTES = [
  { method: "POST", path: SIGNOUT_PATH },
  ...OAuthProviderId.literals.flatMap((providerId) => [
    { method: "GET", path: oauthStartPath(providerId) },
    { method: "GET", path: oauthCallbackPath(providerId) },
  ]),
];

function oauthStartPath(providerId: OAuthProviderId) {
  return `/auth/${providerId}/start` as const;
}

function oauthCallbackPath(providerId: OAuthProviderId) {
  return `/auth/${providerId}/callback` as const;
}

function callbackUrl(deployment: Deployment, providerId: OAuthProviderId): string {
  return `${deployment.apiOrigin}${oauthCallbackPath(providerId)}`;
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
  OAUTH_ROUTES,
  OAuthRoutesLive,
  redirectPathFromOAuthState,
  sanitizeOAuthRedirectPath,
};
