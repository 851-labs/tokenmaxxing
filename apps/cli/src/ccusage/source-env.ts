import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Builds the environment (and any extra arguments) each ccusage child process
 * runs with. Foreground `sync` and the scheduled service both go through here,
 * so a source root resolves the same way whichever path ran it; the service
 * wrapper only has to carry the user's explicit roots (see `capturedServiceEnv`).
 *
 * Hermes Agent keeps named profiles under `~/.hermes/profiles/<name>/state.db`,
 * but ccusage only reads `~/.hermes` unless `HERMES_HOME` lists roots
 * (comma-separated). When `HERMES_HOME` is unset we discover the default root
 * and every profile with a readable state database.
 *
 * Oh My Pi (OMP) is a Pi fork that writes Pi-format sessions under its own
 * directories, so the `omp` source runs ccusage's `pi` adapter pointed at them
 * (see `ompSessionDirs`). The two sources never read each other's sessions:
 * OMP replaces `PI_AGENT_DIR` with its own directories and also passes them as
 * `--pi-path`, which beats a `pi.defaults.piPath` in ccusage.json (the
 * variable does not); Pi drops any `PI_AGENT_DIR` entry that overlaps OMP's.
 */

type CcusageEnv = Record<string, string | undefined>;

interface SourceDiscoveryFs {
  access: (path: string, mode: number) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile: () => boolean }>;
}

const nodeSourceDiscoveryFs: SourceDiscoveryFs = {
  access,
  readdir: (path) => readdir(path),
  realpath,
  stat,
};

async function ccusageSourceEnv(
  source: string,
  env: CcusageEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: SourceDiscoveryFs = nodeSourceDiscoveryFs,
): Promise<CcusageEnv> {
  switch (source) {
    case "hermes": {
      const hermesHomes = await discoverHermesHomes(env, platform, fs);
      return hermesHomes === undefined ? env : { ...env, HERMES_HOME: hermesHomes };
    }
    case "omp": {
      const { PI_AGENT_DIR: _piAgentDir, ...rest } = env;
      const dirs = await ompSessionDirs(env, platform, fs);
      return dirs.length === 0 ? rest : { ...rest, PI_AGENT_DIR: dirs.join(",") };
    }
    case "pi":
      return withoutOmpPiAgentDirs(env, platform, fs);
    default:
      return env;
  }
}

/**
 * Arguments ccusage needs after the report flags, given the environment
 * `ccusageSourceEnv` built; `null` means the source has nothing ccusage could
 * be pointed at, so it must not run (an empty `--pi-path` would fall back to
 * Pi's own sessions).
 */
function ccusageSourceArgs(source: string, env: CcusageEnv): string[] | null {
  if (source !== "omp") {
    return [];
  }

  const dirs = env["PI_AGENT_DIR"];
  return dirs === undefined || dirs === "" ? null : ["--pi-path", dirs];
}

/**
 * OMP's session directories, mirroring `@oh-my-pi/pi-utils/dirs`: the default
 * `~/.omp/agent/sessions` (always listed, so the result is only empty when no
 * path can be passed to ccusage) plus every named profile's
 * `~/.omp/profiles/<name>/agent/sessions`. `PI_CONFIG_DIR` renames `.omp`; on
 * macOS and Linux an existing `$XDG_DATA_HOME/omp` (or its
 * `profiles/<name>`) holds the sessions instead. `PI_CODING_AGENT_DIR` is not
 * followed: Pi reads the same variable, so it may point at Pi's own sessions.
 */
async function ompSessionDirs(
  env: CcusageEnv,
  platform: NodeJS.Platform = process.platform,
  fs: SourceDiscoveryFs = nodeSourceDiscoveryFs,
): Promise<string[]> {
  const path = platform === "win32" ? win32 : posix;
  const home = nonEmpty(platform === "win32" ? env["USERPROFILE"] : env["HOME"]) ?? homedir();
  const configRoot = path.join(home, nonEmpty(env["PI_CONFIG_DIR"]) ?? ".omp");
  const xdgData = nonEmpty(env["XDG_DATA_HOME"]);
  const xdgRoot =
    (platform === "darwin" || platform === "linux") &&
    xdgData !== undefined &&
    path.isAbsolute(xdgData)
      ? path.join(xdgData, "omp")
      : undefined;
  const exists = (candidate: string) =>
    fs.realpath(candidate).then(
      () => true,
      () => false,
    );
  const sessionsDir = async (xdgDir: string | undefined, agentDir: string) =>
    xdgDir !== undefined && (await exists(xdgDir))
      ? path.join(xdgDir, "sessions")
      : path.join(agentDir, "sessions");

  const candidates = [await sessionsDir(xdgRoot, path.join(configRoot, "agent"))];
  const profileRoots = [configRoot, ...(xdgRoot === undefined ? [] : [xdgRoot])];
  const listed = await Promise.all(
    profileRoots.map((root) => fs.readdir(path.join(root, "profiles")).catch(() => [])),
  );
  const profiles = [...new Set(listed.flat())].filter(isOmpProfileName).toSorted(compareCodeUnits);
  for (const profile of profiles) {
    candidates.push(
      await sessionsDir(
        xdgRoot === undefined ? undefined : path.join(xdgRoot, "profiles", profile),
        path.join(configRoot, "profiles", profile, "agent"),
      ),
    );
  }

  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Canonical paths dedupe aliases: ccusage dedupes by literal path.
    const dir = await canonicalPath(candidate, platform, fs);
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (isPassablePath(dir, platform) && !seen.has(key)) {
      seen.add(key);
      dirs.push(dir);
    }
  }

  return dirs;
}

/**
 * Drops `PI_AGENT_DIR` entries that are, contain, or sit inside an OMP
 * session directory, so syncing both sources never counts OMP twice (setting
 * `PI_AGENT_DIR` to OMP's sessions was the workaround before OMP was its own
 * source). With nothing left, ccusage falls back to `~/.pi/agent/sessions`.
 */
async function withoutOmpPiAgentDirs(
  env: CcusageEnv,
  platform: NodeJS.Platform = process.platform,
  fs: SourceDiscoveryFs = nodeSourceDiscoveryFs,
): Promise<CcusageEnv> {
  const configured = env["PI_AGENT_DIR"];
  if (configured === undefined || configured.trim() === "") {
    return env;
  }

  const path = platform === "win32" ? win32 : posix;
  const canonical = async (dir: string) => {
    const resolved = await canonicalPath(dir, platform, fs);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const overlaps = (left: string, right: string) =>
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`);
  const ompDirs = await Promise.all((await ompSessionDirs(env, platform, fs)).map(canonical));
  const entries = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const kept: string[] = [];
  for (const entry of entries) {
    const key = await canonical(entry);
    if (!ompDirs.some((ompDir) => overlaps(key, ompDir))) {
      kept.push(entry);
    }
  }

  if (kept.length === entries.length) {
    return env;
  }

  const { PI_AGENT_DIR: _piAgentDir, ...rest } = env;
  return kept.length === 0 ? rest : { ...rest, PI_AGENT_DIR: kept.join(",") };
}

/**
 * `realpath` through the deepest ancestor that exists, so a sessions dir OMP
 * has not created yet still canonicalizes under a symlinked profile.
 */
async function canonicalPath(
  candidate: string,
  platform: NodeJS.Platform,
  fs: SourceDiscoveryFs,
): Promise<string> {
  const path = platform === "win32" ? win32 : posix;
  const resolved = path.resolve(candidate);
  try {
    return await fs.realpath(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved
      ? resolved
      : path.join(await canonicalPath(parent, platform, fs), path.basename(resolved));
  }
}

/** OMP's own profile-name rule; other entries under `profiles/` are not profiles. */
function isOmpProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !name.endsWith(".");
}

/**
 * Whether ccusage gets `path` back intact: it splits `--pi-path` on commas and
 * trims each entry, and on Windows the npx fallback runs through `cmd.exe`,
 * which expands `%` even inside quotes.
 */
function isPassablePath(path: string, platform: NodeJS.Platform): boolean {
  return (
    !path.includes(",") && path.trim() === path && (platform !== "win32" || !/["%]/.test(path))
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
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
  fs: SourceDiscoveryFs = nodeSourceDiscoveryFs,
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

export { ccusageSourceArgs, ccusageSourceEnv, discoverHermesHomes, ompSessionDirs };

export type { CcusageEnv, SourceDiscoveryFs };
