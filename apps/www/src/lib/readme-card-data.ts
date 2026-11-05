import { ProfileDailyResponse, ProfileResponse } from "@tokenmaxxing/api-contract";

import { avatarFetchUrl, responseImageDataUrl } from "./favicon-svg";
import { fetchPublicProfile } from "./public-api";
import { addDays } from "./dates";
import { README_CARD_DAYS } from "./readme-card";
import type { ReadmeCardData } from "./readme-card";

const UPSTREAM_TIMEOUT_MS = 3_000;

async function loadReadmeCardData(login: string, now = new Date()): Promise<ReadmeCardData | null> {
  const today = now.toISOString().slice(0, 10);
  const since = addDays(today, -(README_CARD_DAYS - 1));
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const [profile, daily] = await Promise.all([
    fetchPublicProfile(login, "", ProfileResponse, { signal }),
    fetchPublicProfile(login, `/daily?groupBy=model&since=${since}`, ProfileDailyResponse, {
      signal,
    }),
  ]);
  if (profile === null || daily === null) {
    return null;
  }

  return { avatarDataUri: await loadAvatarDataUri(profile.user.avatarUrl), daily, profile };
}

// The card still renders, with a muted square, when the avatar host is slow or down.
async function loadAvatarDataUri(avatarUrl: string | null): Promise<string | null> {
  const url = avatarUrl === null ? null : avatarFetchUrl(avatarUrl);
  if (url === null) {
    return null;
  }

  try {
    const response = await fetch(url, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return await responseImageDataUrl(response);
  } catch {
    return null;
  }
}

export { loadReadmeCardData };
