import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  cookie,
  cookieScopeFor,
  readCookie,
  SESSION_COOKIE,
  sessionTokenFrom,
  STATE_COOKIE,
} from "../../auth/cookies";
import { generateToken } from "../../auth/crypto";
import {
  AuthService,
  type AuthServiceShape,
  type CurrentUser,
  type OAuthProfile,
  type OAuthProviderId,
} from "../../auth/service";
import { AppConfig, type AppConfigShape } from "../../config";
import { buildAuthorizeUrl, GitHubClient } from "../../github/client";
import { buildGoogleAuthorizeUrl, GoogleClient } from "../../google/client";

/**
 * Routes that cannot live in the HttpApi contract: the OAuth browser flow
 * (302 redirects + Set-Cookie). They register as raw router routes and share
 * the router's global middleware (CORS, request ids) with the contract
 * endpoints.
 */

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
      const scope = cookieScopeFor(request.headers["host"] ?? "");
      const url = new URL(request.url, "http://localhost");
      const redirectPath = sanitizeOAuthRedirectPath(url.searchParams.get("redirect"));
      const state = encodeOAuthState(generateToken(), redirectPath);

      return HttpServerResponse.empty({ status: 302 }).pipe(
        HttpServerResponse.setHeaders({
          location: buildProviderAuthorizeUrl(
            provider,
            config,
            `${scope.apiOrigin}/auth/${provider}/callback`,
            state,
          ),
          "set-cookie": cookie(scope, STATE_COOKIE, state, 600),
        }),
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
      const scope = cookieScopeFor(request.headers["host"] ?? "");
      const url = new URL(request.url, "http://localhost");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expectedState = readCookie(request, STATE_COOKIE);
      if (code === null || state === null || expectedState === null || state !== expectedState) {
        return HttpServerResponse.jsonUnsafe(
          { error: { code: "oauth_state_mismatch", message: "Sign-in expired; try again." } },
          { status: 400 },
        );
      }
      const redirectPath = redirectPathFromOAuthState(state);

      const auth = yield* AuthService;
      const result = yield* Effect.gen(function* () {
        const currentUser = yield* currentUserFromRequest(request, auth);
        const profile = yield* fetchProviderProfile(
          provider,
          code,
          `${scope.apiOrigin}/auth/${provider}/callback`,
        ).pipe(Effect.orDie);
        // Provider access tokens are dropped here on purpose — identity is all
        // this product needs after sign-in/linking.
        const options = currentUser === null ? undefined : { currentUser };
        const signedIn = yield* auth.signInWithProvider(profile, options);
        return { _tag: "success" as const, ...signedIn };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(`${provider} oauth callback failed`, String(cause).slice(0, 500));
            return { _tag: "failed" as const };
          }),
        ),
      );

      switch (result._tag) {
        case "failed":
          return HttpServerResponse.jsonUnsafe(
            {
              error: {
                code: "oauth_failed",
                message: `${providerLabel(provider)} sign-in failed; try again.`,
              },
            },
            { status: 502 },
          );
        case "success":
          return HttpServerResponse.empty({ status: 302 }).pipe(
            HttpServerResponse.setHeaders({
              location: `${scope.wwwOrigin}${redirectPath ?? defaultOAuthRedirectPath(result.user.login)}`,
              "set-cookie": cookie(scope, SESSION_COOKIE, result.token, 30 * 24 * 60 * 60),
            }),
          );
      }
    }),
  );
}

// Clears the cookie even for expired sessions, so it stays outside the
// Authorization middleware.
const signoutRoute = HttpRouter.add(
  "POST",
  "/auth/signout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = cookieScopeFor(request.headers["host"] ?? "");
    const token = sessionTokenFrom(request);
    if (token !== null) {
      const auth = yield* AuthService;
      yield* auth.signOut(token).pipe(Effect.ignore);
    }

    return HttpServerResponse.jsonUnsafe({ ok: true }).pipe(
      HttpServerResponse.setHeader("set-cookie", cookie(scope, SESSION_COOKIE, "", 0)),
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
): string {
  switch (provider) {
    case "github":
      return buildAuthorizeUrl(config.github, redirectUri, state);
    case "google":
      return buildGoogleAuthorizeUrl(config.google, redirectUri, state);
  }
}

function fetchProviderProfile(
  provider: OAuthProviderId,
  code: string,
  redirectUri: string,
): Effect.Effect<OAuthProfile, unknown, GitHubClient | GoogleClient> {
  switch (provider) {
    case "github":
      return Effect.gen(function* () {
        const github = yield* GitHubClient;
        const accessToken = yield* github.exchangeCode(code, redirectUri);
        return yield* github.fetchUser(accessToken);
      });
    case "google":
      return Effect.gen(function* () {
        const google = yield* GoogleClient;
        const accessToken = yield* google.exchangeCode(code, redirectUri);
        return yield* google.fetchUser(accessToken);
      });
  }
}

function currentUserFromRequest(
  request: HttpServerRequest.HttpServerRequest,
  auth: AuthServiceShape,
): Effect.Effect<CurrentUser | null, never, any> {
  const token = sessionTokenFrom(request);
  if (token === null) {
    return Effect.succeed(null);
  }

  return auth.resolveSession(token).pipe(
    Effect.map((user) => (Option.isSome(user) ? user.value : null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
}

function providerLabel(provider: OAuthProviderId): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "google":
      return "Google";
  }
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

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function encodeOAuthState(nonce: string, redirectPath: string | null): string {
  if (redirectPath === null) {
    return nonce;
  }

  return `${nonce}.${base64UrlEncode(redirectPath)}`;
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

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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
  oauthRoutesLayer,
  redirectPathFromOAuthState,
  sanitizeOAuthRedirectPath,
};
