const DEFAULT_FAVICON_URL = "https://avatars.githubusercontent.com/u/149856362?v=4";

function profileFaviconUrl(avatarUrl: string | null): string {
  return avatarUrl ?? DEFAULT_FAVICON_URL;
}

export { DEFAULT_FAVICON_URL, profileFaviconUrl };
