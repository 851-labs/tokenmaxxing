import { createIsomorphicFn } from "@tanstack/react-start";

/**
 * Edge caching for public, non-personalized HTML. The Nav SSRs authenticated
 * UI whenever a session cookie rides along, so any request carrying the
 * session cookie MUST NOT be edge-cached — otherwise one user's authed HTML
 * could be served to anonymous visitors (or vice versa).
 *
 * `headers()` route options run during SSR on the server but receive no
 * request object, so we read the inbound cookie the same way `lib/api.ts`
 * does: via `getRequestHeader` behind `createIsomorphicFn` (a no-op on the
 * client). When a session cookie is present we fall back to `private,
 * no-store` and add `Vary: Cookie`.
 */

const SESSION_COOKIE = "tmx_session";

const PRIVATE_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};

const sessionCookiePresent = createIsomorphicFn()
  .client(() => false)
  .server(async () => {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    const cookie = getRequestHeader("cookie");
    if (cookie === undefined) {
      return false;
    }

    // Match the cookie name at a boundary so e.g. `tmx_session_other` cannot
    // false-positive, and a present-but-empty value (cleared on sign-out) does
    // not count as a session.
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`).exec(cookie);
    return match !== null && match[1] !== "";
  });

/**
 * Resolve cache headers for a public HTML route: shared edge caching for
 * anonymous requests, `private, no-store` for any request with a session.
 */
async function publicHtmlCacheHeaders(publicCacheControl: string): Promise<Record<string, string>> {
  if (await sessionCookiePresent()) {
    return PRIVATE_CACHE_HEADERS;
  }

  return { "Cache-Control": publicCacheControl };
}

export { PRIVATE_CACHE_HEADERS, publicHtmlCacheHeaders, SESSION_COOKIE };
