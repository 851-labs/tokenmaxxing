const CLI_TAG_PREFIX = "cli-v";
const NPM_PACKAGE_NAME = "@851-labs/tokenmaxxing";

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function cliTagVersion(tag: string): string | null {
  if (!tag.startsWith(CLI_TAG_PREFIX)) {
    return null;
  }
  const version = tag.slice(CLI_TAG_PREFIX.length);
  return parseVersion(version) === null ? null : version;
}

function cliTag(version: string): string {
  return `${CLI_TAG_PREFIX}${version}`;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function requireVersion(version: string): ParsedVersion {
  const parsed = parseVersion(version);
  if (parsed === null) {
    throw new Error(`invalid version ${JSON.stringify(version)}`);
  }
  return parsed;
}

// Semver precedence: 0.7.0-alpha.2 < 0.7.0-alpha.10 < 0.7.0 < 0.7.1.
function compareVersions(left: string, right: string): number {
  const a = requireVersion(left);
  const b = requireVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = a.core[index]! - b.core[index]!;
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) {
        return Math.sign(diff);
      }
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function isPrereleaseVersion(version: string): boolean {
  return requireVersion(version).prerelease.length > 0;
}

// Only the highest stable version may be marked Latest, so publishing a 0.6.x
// patch after 0.7.0 (or any prerelease) never takes the badge.
function isLatestStableVersion(version: string, allVersions: readonly string[]): boolean {
  if (isPrereleaseVersion(version)) {
    return false;
  }
  return allVersions
    .filter((other) => parseVersion(other) !== null && !isPrereleaseVersion(other))
    .every((other) => compareVersions(version, other) >= 0);
}

function sortVersions(versions: readonly string[]): string[] {
  return [...versions].sort(compareVersions);
}

function releaseTitle(version: string): string {
  return `tokenmaxxing v${version}`;
}

function npmVersionUrl(version: string): string {
  return `https://www.npmjs.com/package/${NPM_PACKAGE_NAME}/v/${version}`;
}

function releaseBody(notes: string, version: string): string {
  return [
    notes.trim(),
    "",
    "---",
    "",
    "Install:",
    "",
    "```sh",
    `npm install -g ${NPM_PACKAGE_NAME}@${version}`,
    "```",
    "",
    `npm: [${NPM_PACKAGE_NAME}@${version}](${npmVersionUrl(version)})`,
    "",
  ].join("\n");
}

// Used only when no CHANGELOG has a section for the version.
function gitLogNotes(subjects: readonly string[], previousTag: string | undefined): string {
  const limit = 30;
  const shown = subjects.slice(0, limit).map((subject) => `- ${subject}`);
  if (subjects.length > limit) {
    shown.push(`- …and ${subjects.length - limit} more`);
  }
  const range = previousTag === undefined ? "up to this tag" : `since \`${previousTag}\``;
  return [
    `_CHANGELOG.md has no section for this version; these notes list the commits ${range}._`,
    "",
    ...(shown.length === 0 ? ["- No commits."] : shown),
  ].join("\n");
}

export {
  cliTag,
  cliTagVersion,
  compareVersions,
  gitLogNotes,
  isLatestStableVersion,
  isPrereleaseVersion,
  npmVersionUrl,
  releaseBody,
  releaseTitle,
  sortVersions,
};
