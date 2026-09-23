/**
 * Response headers every www response carries. Framing is denied outright —
 * /login/cli approves a never-expiring CLI token and /settings revokes
 * access, so neither may be clickjacked — except the OG card templates,
 * which /design previews in a same-origin iframe.
 */

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const BASE_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`,
  "x-content-type-options": "nosniff",
} as const;

function isSameOriginFramable(pathname: string): boolean {
  return pathname === "/og-card" || pathname.startsWith("/og-card/");
}

function securityHeaders(pathname: string): Record<string, string> {
  const framable = isSameOriginFramable(pathname);

  return {
    ...BASE_HEADERS,
    "content-security-policy": `frame-ancestors ${framable ? "'self'" : "'none'"}`,
    "x-frame-options": framable ? "SAMEORIGIN" : "DENY",
  };
}

/**
 * `response` with the security headers added. Headers a route set itself
 * win; the response is re-wrapped because fetched or cached responses have
 * immutable headers.
 */
function withSecurityHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(new URL(request.url).pathname))) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export { securityHeaders, withSecurityHeaders };
