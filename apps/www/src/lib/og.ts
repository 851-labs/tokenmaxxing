import type { ProfileResponse } from "@tokenmaxxing/api-contract";

import { formatInteger, formatTokens, formatUsd } from "./format";
import { SITE_ORIGIN } from "./site";

type Profile = typeof ProfileResponse.Type;

const OG_IMAGE_HEIGHT = 630;
/** Bump when the card's rendering changes so versioned image URLs refresh. */
const OG_IMAGE_STYLE_VERSION = 4;
const OG_IMAGE_WIDTH = 1200;

/** The site-wide card (`/og-card`), used by every page without its own image. */
const SITE_OG_VERSION = `site-s${OG_IMAGE_STYLE_VERSION}`;
const SITE_OG_IMAGE_PATH = `/og.png?${new URLSearchParams({ v: SITE_OG_VERSION }).toString()}`;
const SITE_OG_IMAGE_URL = new URL(SITE_OG_IMAGE_PATH, SITE_ORIGIN).toString();

function profileOgTitle(profile: Profile): string {
  return `${profile.user.login} on tokenmaxxing.sh`;
}

function profileOgDescription(profile: Profile): string {
  const { stats } = profile;
  if (stats.activeDays === 0) {
    return `${profile.user.login} has not synced usage yet.`;
  }

  return `${profile.user.login} has spent ${formatUsd(stats.totalSpendUsd)} across ${formatInteger(
    stats.activeDays,
  )} active days and ${formatTokens(stats.totalTokens)} tokens.`;
}

function profileOgVersion(profile: Profile): string {
  return [
    profile.stats.lastDate ?? "none",
    Math.round(profile.stats.totalSpendUsd * 100),
    Math.round(profile.stats.totalTokens),
    profile.stats.activeDays,
    `s${OG_IMAGE_STYLE_VERSION}`,
  ].join("-");
}

function profileOgImagePath(profile: Profile): string {
  const path = `/og/${encodeURIComponent(profile.user.login)}.png`;
  const params = new URLSearchParams({
    v: profileOgVersion(profile),
  });

  return `${path}?${params.toString()}`;
}

function profileOgImageUrl(profile: Profile, origin = SITE_ORIGIN): string {
  return new URL(profileOgImagePath(profile), origin).toString();
}

function profileUrl(profile: Profile, origin = SITE_ORIGIN): string {
  return new URL(`/${encodeURIComponent(profile.user.login)}`, origin).toString();
}

export {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_STYLE_VERSION,
  OG_IMAGE_WIDTH,
  profileOgDescription,
  profileOgImagePath,
  profileOgImageUrl,
  profileOgTitle,
  profileOgVersion,
  profileUrl,
  SITE_OG_IMAGE_PATH,
  SITE_OG_IMAGE_URL,
  SITE_OG_VERSION,
  // Re-exported for routes that still import it from here; prefer lib/site.
  SITE_ORIGIN,
};
