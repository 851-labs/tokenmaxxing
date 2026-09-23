/**
 * Logins never minted for a user, because tokenmaxxing.sh/<login> is the
 * profile URL and these first path segments already belong to the site: www
 * routes (and their file-extension siblings like /og.png), static files, and
 * a few names kept back for future pages. apps/www checks that every
 * top-level route and public file stays covered here.
 */
const RESERVED_LOGINS: ReadonlySet<string> = new Set([
  // www routes and static files
  "apple-touch-icon",
  "assets",
  "design",
  "favicon",
  "internal",
  "llms",
  "login",
  "og",
  "og-card",
  "privacy",
  "robots",
  "settings",
  "sitemap",
  "stats",
  "terms",
  // kept back for future pages
  "about",
  "admin",
  "api",
  "auth",
  "blog",
  "cli",
  "docs",
  "help",
  "leaderboard",
  "logout",
  "me",
  "new",
  "signin",
  "signout",
  "signup",
  "static",
  "user",
  "users",
  "www",
]);

/** Whether `login` would collide with a site path (compared case-insensitively). */
function isReservedLogin(login: string): boolean {
  return RESERVED_LOGINS.has(login.toLowerCase());
}

export { isReservedLogin, RESERVED_LOGINS };
