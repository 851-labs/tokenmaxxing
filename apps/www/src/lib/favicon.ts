const DEFAULT_APPLE_TOUCH_ICON_URL = "/apple-touch-icon.png";
const DEFAULT_FAVICON_URL = "/favicon.png";
const PROFILE_FAVICON_LAYOUT_VERSION = "9";

interface FaviconProfile {
  avatarUrl: string | null;
  login: string;
}

interface FaviconRouteMatch {
  loaderData?: unknown;
  routeId: string;
}

function profileFaviconUrl(profile: FaviconProfile): string {
  return profile.avatarUrl === null
    ? DEFAULT_FAVICON_URL
    : `/favicon/${encodeURIComponent(profile.login)}.svg?v=${PROFILE_FAVICON_LAYOUT_VERSION}`;
}

function faviconMimeType(href: string): "image/png" | "image/svg+xml" {
  return href === DEFAULT_FAVICON_URL ? "image/png" : "image/svg+xml";
}

function faviconUrlFromMatches(matches: readonly FaviconRouteMatch[]): string {
  const match = matches.find((candidate) => candidate.routeId === "/$user");
  const profile = faviconProfileFromLoaderData(match?.loaderData);
  return profile === null ? DEFAULT_FAVICON_URL : profileFaviconUrl(profile);
}

function faviconProfileFromLoaderData(value: unknown): FaviconProfile | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const profile = (value as { profile?: unknown }).profile;
  if (typeof profile !== "object" || profile === null) {
    return null;
  }

  const user = (profile as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) {
    return null;
  }

  const { avatarUrl, login } = user as { avatarUrl?: unknown; login?: unknown };
  return typeof login === "string" && (typeof avatarUrl === "string" || avatarUrl === null)
    ? { avatarUrl, login }
    : null;
}

export {
  DEFAULT_APPLE_TOUCH_ICON_URL,
  DEFAULT_FAVICON_URL,
  PROFILE_FAVICON_LAYOUT_VERSION,
  faviconMimeType,
  faviconUrlFromMatches,
  profileFaviconUrl,
};

export type { FaviconProfile, FaviconRouteMatch };
