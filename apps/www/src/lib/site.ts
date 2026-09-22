/**
 * Canonical site identity and outbound links. Every page, feed, and structured
 * data block reads from here so a link can't drift between surfaces.
 */

const SITE_ORIGIN = "https://tokenmaxxing.sh";
const SITE_NAME = "tokenmaxxing.sh";
const SITE_DESCRIPTION = "The best place to track token usage.";

const GITHUB_REPO = "851-labs/tokenmaxxing";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
const CHANGELOG_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
const DISCORD_URL = "https://discord.gg/WzX6BpfaRH";
const X_URL = "https://x.com/pondorasti";
const CCUSAGE_URL = "https://ccusage.com/";

const NPM_PACKAGE = "@851-labs/tokenmaxxing";
const NPM_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;
const NPM_INSTALL_COMMAND = `npm install -g ${NPM_PACKAGE}@latest`;

/** Absolute URL for a site path, e.g. `siteUrl("/privacy")`. */
function siteUrl(path: string): string {
  return new URL(path, SITE_ORIGIN).toString();
}

export {
  CCUSAGE_URL,
  CHANGELOG_URL,
  DISCORD_URL,
  GITHUB_REPO,
  GITHUB_URL,
  NPM_INSTALL_COMMAND,
  NPM_PACKAGE,
  NPM_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  siteUrl,
  X_URL,
};
