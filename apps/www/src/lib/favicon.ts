const DEFAULT_APPLE_TOUCH_ICON_URL = "/apple-touch-icon.png";
const DEFAULT_FAVICON_URL = "/favicon.svg";

interface FaviconProfile {
  avatarUrl: string | null;
  login: string;
}

function profileFaviconUrl(profile: FaviconProfile): string {
  if (profile.avatarUrl === null) {
    return DEFAULT_FAVICON_URL;
  }

  return `/favicon/${encodeURIComponent(profile.login)}.svg?v=${stableHash(profile.avatarUrl)}`;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0).toString(36);
}

export { DEFAULT_APPLE_TOUCH_ICON_URL, DEFAULT_FAVICON_URL, profileFaviconUrl };

export type { FaviconProfile };
