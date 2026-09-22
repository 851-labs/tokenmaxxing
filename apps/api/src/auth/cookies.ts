import { Duration } from "effect";
import type { Cookies, HttpServerRequest } from "effect/unstable/http";

import type { Deployment } from "../config";

/**
 * Session/state cookie plumbing for the browser auth flow. Cookie attributes
 * derive from the request's deployment (see deploymentForHost), so one
 * deploy serves dev and prod without environment plumbing.
 */

const SESSION_COOKIE = "tmx_session";
const STATE_COOKIE = "tmx_oauth_state";
/** PKCE code verifier for the in-flight OAuth round trip; paired with STATE_COOKIE. */
const PKCE_COOKIE = "tmx_oauth_pkce";

type CookieOptions = NonNullable<Cookies.Cookie["options"]>;

/** Attributes for every auth cookie; `maxAgeSeconds: 0` clears it. */
function cookieOptions(deployment: Deployment, maxAgeSeconds: number): CookieOptions {
  return {
    domain: deployment.cookieDomain,
    httpOnly: true,
    maxAge: Duration.seconds(maxAgeSeconds),
    path: "/",
    sameSite: "lax",
    secure: deployment.secure,
  };
}

function readCookie(request: HttpServerRequest.HttpServerRequest, name: string): string | null {
  return request.cookies[name] ?? null;
}

/** The `Authorization: Bearer …` credential, if present. */
function bearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const authorization = request.headers["authorization"];

  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

/** Bearer header (non-browser clients) or the session cookie. */
function sessionTokenFrom(request: HttpServerRequest.HttpServerRequest): string | null {
  return bearerToken(request) ?? readCookie(request, SESSION_COOKIE);
}

export {
  bearerToken,
  cookieOptions,
  PKCE_COOKIE,
  readCookie,
  SESSION_COOKIE,
  sessionTokenFrom,
  STATE_COOKIE,
};

export type { CookieOptions };
