import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

/**
 * Builds the environment each ccusage child process runs with. Foreground
 * `sync` and the scheduled service both go through here, so a source root
 * resolves the same way whichever path ran it; the service wrapper only has to
 * carry the user's explicit roots (see `capturedServiceEnv`).
 *
 * Hermes Agent keeps named profiles under `~/.hermes/profiles/<name>/state.db`,
 * but ccusage only reads `~/.hermes` unless `HERMES_HOME` lists roots
 * (comma-separated). When `HERMES_HOME` is unset we discover the default root
 * and every profile with a readable state database.
 */

type CcusageEnv = Record<string, string | undefined>;

interface HermesDiscoveryFs {
  access: (path: string, mode: number) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile: () => boolean }>;
}

const nodeHermesDiscoveryFs: HermesDiscoveryFs = {
  access,
  readdir: (path) => readdir(path),
  realpath,
  stat,
};

async function ccusageSourceEnv(
  source: string,
  env: CcusageEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: HermesDiscoveryFs = nodeHermesDiscoveryFs,
): Promise<CcusageEnv> {
  if (source !== "hermes") {
    return env;
  }

  const hermesHomes = await discoverHermesHomes(env, platform, fs);
  return hermesHomes === undefined ? env : { ...env, HERMES_HOME: hermesHomes };
}

/**
 * Returns the comma-joined Hermes roots to hand ccusage, or undefined to leave
 * the environment alone: an explicit `HERMES_HOME` always wins, and any
 * discovery failure degrades to ccusage's own default so other sources (and
 * the default Hermes root) keep syncing.
 */
async function discoverHermesHomes(
  env: CcusageEnv,
  platform: NodeJS.Platform = process.platform,
  fs: HermesDiscoveryFs = nodeHermesDiscoveryFs,
): Promise<string | undefined> {
  const explicit = env["HERMES_HOME"];
  if (explicit !== undefined && explicit !== "") {
    return undefined;
  }

  const home = platform === "win32" ? env["USERPROFILE"] : env["HOME"];
  if (home === undefined || home === "") {
    return undefined;
  }

  const path = platform === "win32" ? win32 : posix;
  // Windows paths compare case-insensitively; POSIX paths compare exactly.
  const pathKey = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const hermesRoot = path.join(home, ".hermes");

  try {
    const realRoot = await fs.realpath(hermesRoot);
    const realRootKey = pathKey(realRoot);
    const insideRoot = (key: string) => key.startsWith(`${realRootKey}${path.sep}`);
    const roots: string[] = [];
    const seen = new Set<string>();

    const addRoot = async (candidate: string) => {
      // Canonical paths dedupe profile aliases: ccusage dedupes by literal
      // path, so a symlinked alias would otherwise double-count usage.
      const resolved = await fs.realpath(candidate);
      const resolvedKey = pathKey(resolved);
      if (resolvedKey !== realRootKey && !insideRoot(resolvedKey)) {
        return;
      }

      const state = await fs.realpath(path.join(resolved, "state.db"));
      if (!insideRoot(pathKey(state)) || !(await fs.stat(state)).isFile()) {
        return;
      }

      await fs.access(state, constants.R_OK);
      // ccusage splits HERMES_HOME on commas and trims each entry, so those
      // paths cannot round-trip.
      if (resolved.includes(",") || resolved.trim() !== resolved) {
        return;
      }

      if (!seen.has(resolvedKey)) {
        seen.add(resolvedKey);
        roots.push(resolved);
      }
    };

    await addRoot(hermesRoot).catch(() => undefined);
    const profilesRoot = path.join(hermesRoot, "profiles");
    const profiles = await fs.readdir(profilesRoot).catch(() => [] as string[]);
    for (const profile of profiles.toSorted(compareCodeUnits)) {
      await addRoot(path.join(profilesRoot, profile)).catch(() => undefined);
    }

    // Only the default root means ccusage's default already covers it.
    if (roots.length === 0 || (roots.length === 1 && roots[0] === realRoot)) {
      return undefined;
    }

    return roots.join(",");
  } catch {
    return undefined;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export { ccusageSourceEnv, discoverHermesHomes };

export type { CcusageEnv, HermesDiscoveryFs };
