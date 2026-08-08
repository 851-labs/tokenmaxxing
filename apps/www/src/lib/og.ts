import type { ProfileResponse } from "@tokenmaxxing/api-contract";

type Profile = typeof ProfileResponse.Type;

const SITE_ORIGIN = "https://tokenmaxxing.sh";
const OG_IMAGE_HEIGHT = 630;
const OG_IMAGE_STYLE_VERSION = 4;
const OG_IMAGE_WIDTH = 1200;

function profileOgTitle(profile: Profile): string {
  return `${profile.user.login} on tokenmaxxing.sh`;
}

function profileOgDescription(profile: Profile): string {
  const { stats } = profile;
  if (stats.activeDays === 0) {
    return `${profile.user.login} has not synced usage yet.`;
  }

  return `${profile.user.login} has spent ${formatOgUsd(stats.totalSpendUsd)} across ${formatOgNumber(
    stats.activeDays,
  )} active days and ${formatOgTokens(stats.totalTokens)} tokens.`;
}

function profileOgVersion(profile: Profile): string {
  return [
    profile.stats.lastDate ?? "none",
    Math.round(profile.stats.totalSpendUsd * 100),
    Math.round(profile.stats.totalTokens),
    profile.stats.activeDays,
    profile.badges.join(".") || "no-badges",
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

const compactFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const usdFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

function formatOgNumber(value: number): string {
  return integerFormatter.format(value);
}

function formatOgTokens(value: number): string {
  return compactFormatter.format(value);
}

function formatOgUsd(value: number): string {
  return usdFormatter.format(value);
}

export {
  formatOgNumber,
  formatOgTokens,
  formatOgUsd,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_STYLE_VERSION,
  OG_IMAGE_WIDTH,
  profileOgDescription,
  profileOgImagePath,
  profileOgImageUrl,
  profileOgTitle,
  profileOgVersion,
  profileUrl,
  SITE_ORIGIN,
};
