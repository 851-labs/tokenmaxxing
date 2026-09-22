import { Duration } from "effect";
import type { Cookies, HttpServerRequest } from "effect/unstable/http";

/**
 * Session/state cookie plumbing for the browser auth flow. Cookie attributes
 * derive from the request host, so one deploy serves dev
 * (api.tokenmaxxing.localhost, http) and prod (api.tokenmaxxing.sh,
 * https) without environment plumbing.
 */

const SESSION_COOKIE = "tmx_session";
const STATE_COOKIE = "tmx_oauth_state";
/** PKCE code verifier for the in-flight OAuth round trip; paired with STATE_COOKIE. */
const PKCE_COOKIE = "tmx_oauth_pkce";

interface CookieScope {
  apiOrigin: string;
  domain: string;
  secure: boolean;
  wwwOrigin: string;
}

function cookieScopeFor(host: string): CookieScope {
  const hostname = host.split(":")[0] ?? host;
  // The local dev provider proxies with a rewritten Host (127.0.0.1:port),
  // so any loopback-ish host means dev; origins are fixed per environment.
  const isDev =
    hostname.endsWith(".tokenmaxxing.localhost") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  if (isDev) {
    return {
      apiOrigin: "http://api.tokenmaxxing.localhost:8788",
      domain: ".tokenmaxxing.localhost",
      secure: false,
      wwwOrigin: "http://tokenmaxxing.localhost:3002",
    };
  }

  return {
    apiOrigin: "https://api.tokenmaxxing.sh",
    domain: ".tokenmaxxing.sh",
    secure: true,
    wwwOrigin: "https://tokenmaxxing.sh",
  };
}

type CookieOptions = NonNullable<Cookies.Cookie["options"]>;

/** Attributes for every auth cookie; `maxAgeSeconds: 0` clears it. */
function cookieOptions(scope: CookieScope, maxAgeSeconds: number): CookieOptions {
  return {
    domain: scope.domain,
    httpOnly: true,
    maxAge: Duration.seconds(maxAgeSeconds),
    path: "/",
    sameSite: "lax",
    secure: scope.secure,
  };
}

function readCookie(request: HttpServerRequest.HttpServerRequest, name: string): string | null {
  return request.cookies[name] ?? null;
}

/** Bearer header (non-browser clients) or the session cookie. */
function sessionTokenFrom(request: HttpServerRequest.HttpServerRequest): string | null {
  const authorization = request.headers["authorization"];
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  return readCookie(request, SESSION_COOKIE);
}

export {
  cookieOptions,
  cookieScopeFor,
  PKCE_COOKIE,
  readCookie,
  SESSION_COOKIE,
  sessionTokenFrom,
  STATE_COOKIE,
};

export type { CookieOptions, CookieScope };
