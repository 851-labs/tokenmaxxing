/**
 * Old logins. The API resolves a login a user held before a rename to their
 * current profile and answers with the current login, so a response whose
 * login differs from the requested one (beyond case) means the URL used an
 * old login. Those URLs redirect permanently to the current one.
 *
 * The redirect is cached for an hour, not forever: a user may take an old
 * login back (renaming A → B → A on GitHub), and a browser holding a
 * forever-cached A → B hop would then loop between the two.
 */

const LOGIN_REDIRECT_CACHE_CONTROL = "public, max-age=3600";

const LOGIN_REDIRECT_HEADERS = { "cache-control": LOGIN_REDIRECT_CACHE_CONTROL };

/** Whether `requested` reached `current` through an old login (not just other casing). */
function isOldLogin(requested: string, current: string): boolean {
  return requested.toLowerCase() !== current.toLowerCase();
}

/** A 301 to `pathname` on the request's origin, keeping its query string. */
function loginRedirectResponse(request: Request, pathname: string): Response {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.hash = "";

  return new Response(null, {
    headers: { ...LOGIN_REDIRECT_HEADERS, location: url.toString() },
    status: 301,
  });
}

export { isOldLogin, LOGIN_REDIRECT_CACHE_CONTROL, LOGIN_REDIRECT_HEADERS, loginRedirectResponse };
