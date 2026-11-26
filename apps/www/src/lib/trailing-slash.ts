/**
 * No URL on this site ends in a slash. The router already sends `/stats/` to
 * `/stats`, but as a 307, which tells a crawler the slashed URL is the one to
 * keep. This answers first, with a 301, so the two spellings count as one
 * page.
 *
 * Only the path is normalized here. The router's other redirect, dropping a
 * search param that equals its default (`?range=all`), stays temporary: a
 * default can change, and a cached permanent redirect would outlive it.
 */

/** A 301 to the same URL without its trailing slashes, or null when it has none. */
function trailingSlashRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  if (url.pathname === "/" || !url.pathname.endsWith("/")) {
    return null;
  }

  // A path of only slashes is the home page. The target is an absolute URL
  // on the request's own origin, so `//host/` cannot point it elsewhere.
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname === "" ? "/" : pathname;

  return new Response(null, { headers: { location: url.toString() }, status: 301 });
}

export { trailingSlashRedirect };
