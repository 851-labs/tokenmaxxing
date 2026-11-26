import {
  ProfileDailyResponse,
  ProfileResponse,
  shiftDayKey,
  utcDayKey,
} from "@tokenmaxxing/api-contract";

import { avatarFetchUrl, responseImageDataUrl } from "./favicon-svg";
import { fetchPublicProfile } from "./public-api";
import { README_CARD_DAYS } from "./readme-card";
import type { ReadmeCardData } from "./readme-card";

/** One budget for the whole card: the API reads and the avatar fetch share it. */
const UPSTREAM_TIMEOUT_MS = 3_000;

interface ReadmeCardIdentity {
  avatarUrl: string | null;
  login: string;
}

interface LoadReadmeCardOptions {
  fetchAvatar?: (url: string, init: RequestInit) => Promise<Response>;
  now?: Date;
}

interface LoadedReadmeCard {
  /**
   * The avatar could not be fetched this time (host slow or down). The card
   * still renders, with a muted square, but must not be cached for long.
   */
  avatarFailed: boolean;
  data: ReadmeCardData;
}

/**
 * The card's data for a profile whose identity is already known: its stats,
 * its last {@link README_CARD_DAYS} days by model, and its avatar as a data
 * URI, all fetched in parallel. Resolves `null` when the profile is unknown
 * or hidden; rejects when the API fails.
 */
async function loadReadmeCardData(
  identity: ReadmeCardIdentity,
  { fetchAvatar = (url, init) => fetch(url, init), now = new Date() }: LoadReadmeCardOptions = {},
): Promise<LoadedReadmeCard | null> {
  // The ingest ceiling is UTC today + 1, so this covers a 30-day window
  // ending on whichever day the API reports as the range's last.
  const since = shiftDayKey(utcDayKey(now), -(README_CARD_DAYS - 1));
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const [profile, daily, avatar] = await Promise.all([
    fetchPublicProfile(identity.login, "", ProfileResponse, { signal }),
    fetchPublicProfile(
      identity.login,
      `/daily?groupBy=model&since=${since}`,
      ProfileDailyResponse,
      {
        signal,
      },
    ),
    loadAvatar(identity.avatarUrl, fetchAvatar, signal),
  ]);
  if (profile === null || daily === null) {
    return null;
  }

  return {
    avatarFailed: avatar.failed,
    data: { avatarDataUri: avatar.dataUri, daily, profile },
  };
}

/** Never rejects: a missing avatar must not cost the card. */
async function loadAvatar(
  avatarUrl: string | null,
  fetchAvatar: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<{ dataUri: string | null; failed: boolean }> {
  // No avatar, or one on a host the allowlist rejects: nothing to retry.
  const url = avatarUrl === null ? null : avatarFetchUrl(avatarUrl);
  if (url === null) {
    return { dataUri: null, failed: false };
  }

  try {
    const response = await fetchAvatar(url, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "manual",
      signal,
    });
    const dataUri = await responseImageDataUrl(response);
    return { dataUri, failed: dataUri === null };
  } catch {
    return { dataUri: null, failed: true };
  }
}

export { loadReadmeCardData };

export type { LoadedReadmeCard, LoadReadmeCardOptions, ReadmeCardIdentity };
