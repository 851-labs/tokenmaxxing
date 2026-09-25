import { Data, Effect } from "effect";

/**
 * Version precedence and release-channel selection shared by
 * `tokenmaxxing upgrade` and the service auto-updater.
 *
 * Precedence follows semver 2.0: major.minor.patch compare numerically, a
 * release outranks its prereleases, and prerelease identifiers compare
 * left to right (numeric < alphanumeric, numeric by value, alphanumeric in
 * ASCII order, a shorter prefix sorts first). Build metadata is ignored.
 *
 * A prerelease user (`0.7.0-alpha.3`) follows its channel's dist-tag
 * (`alpha`) and `latest`; a stable user follows `latest` only. An update is
 * only ever a strictly greater version, so nothing here can downgrade.
 */

type DistTags = Readonly<Record<string, string>>;

interface DistTagVersion {
  distTag: string;
  version: string;
}

interface UpdateResolution {
  /** Highest well-formed version across the dist-tags the current version follows. */
  newest: DistTagVersion | null;
  /** `newest` when it is strictly greater than the current version, otherwise null. */
  update: DistTagVersion | null;
}

interface SemVer {
  major: string;
  minor: string;
  patch: string;
  prerelease: readonly string[];
}

class CliVersionCheckError extends Data.TaggedError("CliVersionCheckError")<{
  readonly cause: unknown;
}> {}

const LATEST_DIST_TAG = "latest";
const NPM_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@851-labs%2Ftokenmaxxing/dist-tags";
const DIST_TAGS_TIMEOUT_MS = 15 * 1000;

const NUMERIC_IDENTIFIER = "0|[1-9]\\d*";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN = new RegExp(
  `^v?(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    `(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function parseSemVer(version: string): SemVer | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (match === null) {
    return null;
  }

  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease: match[4]?.split(".") ?? [],
  };
}

/** Sign of `left - right` by semver precedence; null when either side is malformed. */
function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const leftVersion = parseSemVer(left);
  const rightVersion = parseSemVer(right);
  if (leftVersion === null || rightVersion === null) {
    return null;
  }

  return (
    compareNumericIdentifiers(leftVersion.major, rightVersion.major) ||
    compareNumericIdentifiers(leftVersion.minor, rightVersion.minor) ||
    compareNumericIdentifiers(leftVersion.patch, rightVersion.patch) ||
    comparePrerelease(leftVersion.prerelease, rightVersion.prerelease)
  );
}

function isNewerVersion(currentVersion: string, candidateVersion: string): boolean {
  return compareVersions(currentVersion, candidateVersion) === -1;
}

/** The npm dist-tag a version is published under: its first prerelease identifier, or `latest`. */
function releaseChannel(version: string): string {
  const channel = parseSemVer(version)?.prerelease[0];
  return channel === undefined || isNumericIdentifier(channel) ? LATEST_DIST_TAG : channel;
}

/** Dist-tags to consider for updates, channel first so `latest` wins ties. */
function followedDistTags(currentVersion: string): readonly string[] {
  const channel = releaseChannel(currentVersion);
  return channel === LATEST_DIST_TAG ? [LATEST_DIST_TAG] : [channel, LATEST_DIST_TAG];
}

function resolveUpdate(currentVersion: string, distTags: DistTags): UpdateResolution {
  let newest: DistTagVersion | null = null;
  for (const distTag of followedDistTags(currentVersion)) {
    const version = distTags[distTag];
    if (version === undefined || parseSemVer(version) === null) {
      continue;
    }
    if (newest === null || compareVersions(newest.version, version)! <= 0) {
      newest = { distTag, version };
    }
  }

  return {
    newest,
    update: newest !== null && isNewerVersion(currentVersion, newest.version) ? newest : null,
  };
}

function distTagsFromRegistry(body: unknown): DistTags | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const distTags: Record<string, string> = {};
  for (const [distTag, version] of Object.entries(body)) {
    if (typeof version === "string" && version.length > 0) {
      distTags[distTag] = version;
    }
  }

  return distTags;
}

function fetchDistTags(
  timeoutMs: number = DIST_TAGS_TIMEOUT_MS,
): Effect.Effect<DistTags, CliVersionCheckError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(NPM_DIST_TAGS_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new CliVersionCheckError({ cause: `registry returned ${response.status}` });
      }

      const distTags = distTagsFromRegistry(await response.json());
      if (distTags === null) {
        throw new CliVersionCheckError({ cause: "registry response missing dist-tags" });
      }

      return distTags;
    },
    catch: (cause) =>
      cause instanceof CliVersionCheckError ? cause : new CliVersionCheckError({ cause }),
  });
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  if (left.length === 0 || right.length === 0) {
    // A release (no prerelease) outranks any prerelease of the same core.
    return sign(right.length - left.length);
  }

  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = comparePrereleaseIdentifier(left[index]!, right[index]!);
    if (difference !== 0) {
      return difference;
    }
  }

  return sign(left.length - right.length);
}

function comparePrereleaseIdentifier(left: string, right: string): -1 | 0 | 1 {
  const leftNumeric = isNumericIdentifier(left);
  const rightNumeric = isNumericIdentifier(right);
  if (leftNumeric && rightNumeric) {
    return compareNumericIdentifiers(left, right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

// Numeric identifiers carry no leading zeros (the pattern rejects them), so
// comparing by length and then lexically orders them by value without
// overflowing Number for arbitrarily long versions.
function compareNumericIdentifiers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) {
    return sign(left.length - right.length);
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

function isNumericIdentifier(identifier: string): boolean {
  return /^\d+$/.test(identifier);
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

export {
  CliVersionCheckError,
  compareVersions,
  distTagsFromRegistry,
  fetchDistTags,
  followedDistTags,
  isNewerVersion,
  LATEST_DIST_TAG,
  parseSemVer,
  releaseChannel,
  resolveUpdate,
};
export type { DistTags, DistTagVersion, SemVer, UpdateResolution };
