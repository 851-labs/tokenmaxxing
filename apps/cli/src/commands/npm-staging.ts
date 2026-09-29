import type { Dirent } from "node:fs";
import { access, open, readdir, rm } from "node:fs/promises";
import { win32 } from "node:path";

import { Effect } from "effect";

/**
 * Removes the copies of the CLI that `npm install -g` leaves behind on
 * Windows when it replaces the package while its native exe is running.
 *
 * npm first renames the installed package dir to a staging name,
 * `node_modules\@851-labs\.tokenmaxxing-<hash>`, installs the new version,
 * and then deletes the staging dir. `tokenmaxxing upgrade` runs npm from
 * the exe inside that dir, and Windows never deletes the last link of a
 * running image (it can be renamed, which is how npm moved it aside), so
 * npm's delete fails on the exe, npm only logs a warning, and ~78 MB stays
 * behind. The next npm install reuses the same staging name (the hash is of
 * the package path), so there is one such copy per prefix, not one per
 * upgrade. The exe exits with the upgrade, so any later run can remove it.
 * A staging dir whose exe still runs is left whole: npm may be mid-install
 * and move it back if the install fails.
 *
 * The native package (`tokenmaxxing-windows-*`) is installed inside the main
 * package's own node_modules, so npm retires it with the main package and it
 * never gets a staging dir of its own. bun installs leave nothing behind.
 */

// npm's retire path: `.${basename}-${hash}`, where the hash is a sha1 in
// base64 with everything but [a-zA-Z0-9] stripped, cut to 8 characters
// (@npmcli/arborist lib/retire-path.js).
const NPM_STAGING_DIR_NAME = /^\.tokenmaxxing-[A-Za-z0-9]{8}$/;
const SCOPE_DIR = win32.join("node_modules", "@851-labs");
const LIVE_PACKAGE_DIR_NAME = "tokenmaxxing";
// A path inside the installed package; group 1 is its scope dir.
const INSTALLED_PACKAGE_PATH = /^(.*?\\node_modules\\@851-labs)\\tokenmaxxing(?:\\|$)/i;

interface NpmStagingFs {
  exists: (path: string) => Promise<boolean>;
  /** Whether an exe under `dir` is running (Windows refuses to open it for writing). */
  hasRunningExe: (dir: string) => Promise<boolean>;
  readdir: (path: string) => Promise<Dirent[]>;
  rm: (path: string) => Promise<void>;
}

interface NpmStagingCleanup {
  /** Staging dirs that could not be removed. */
  failed: string[];
  /** Staging dirs left for a later run because an exe in them is running. */
  inUse: string[];
  removed: string[];
}

const nodeFs: NpmStagingFs = {
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  hasRunningExe: async function hasRunningExe(dir: string): Promise<boolean> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = win32.join(dir, entry.name);
      if (entry.isDirectory() && (await hasRunningExe(path))) {
        return true;
      }
      if (entry.isFile() && /\.exe$/i.test(entry.name) && (await openFails(path))) {
        return true;
      }
    }
    return false;
  },
  readdir: (path) => readdir(path, { withFileTypes: true }),
  rm: (path) => rm(path, { force: true, recursive: true }),
};

// A running image (through any of its hard links) cannot be opened for
// writing: EBUSY. Nothing is written; the handle only probes. Any error but
// ENOENT counts as busy, so a dir is only removed when nothing in it is.
async function openFails(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r+");
    await handle.close();
    return false;
  } catch (cause) {
    return (cause as { code?: unknown }).code !== "ENOENT";
  }
}

function isNpmStagingDirName(name: string): boolean {
  return NPM_STAGING_DIR_NAME.test(name);
}

/**
 * The `<prefix>\node_modules\@851-labs` dirs that `paths` point into: a path
 * inside the installed package (the running exe, a resolved bin), or npm's
 * `tokenmaxxing.cmd`/`.ps1` shim, which sits in the prefix itself.
 */
function npmScopeDirsForPaths(paths: readonly (string | null | undefined)[]): string[] {
  const scopes = new Map<string, string>();

  for (const path of paths) {
    if (path === undefined || path === null || !win32.isAbsolute(path)) {
      continue;
    }
    const normalized = win32.normalize(path);
    const scope =
      INSTALLED_PACKAGE_PATH.exec(normalized)?.[1] ??
      win32.join(win32.dirname(normalized), SCOPE_DIR);
    scopes.set(scope.toLowerCase(), scope);
  }

  return [...scopes.values()];
}

/**
 * Removes npm's leftover staging dirs next to the npm installs `paths` point
 * into. Windows only; never fails. A scope dir is only touched when the live
 * package dir sits in it, only real directories with npm's staging name are
 * removed (never the live `tokenmaxxing` dir, never a link), and a dir whose
 * exe is still running is left for a later run.
 */
function removeNpmStagingDirs(
  paths: readonly (string | null | undefined)[],
  platform: NodeJS.Platform = process.platform,
  fs: NpmStagingFs = nodeFs,
): Effect.Effect<NpmStagingCleanup, never> {
  if (platform !== "win32") {
    return Effect.succeed(emptyCleanup());
  }

  return Effect.tryPromise({
    try: async () => {
      const cleanup = emptyCleanup();
      for (const scope of npmScopeDirsForPaths(paths)) {
        if (!(await fs.exists(win32.join(scope, LIVE_PACKAGE_DIR_NAME, "package.json")))) {
          continue;
        }
        const entries = await fs.readdir(scope).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory() || !isNpmStagingDirName(entry.name)) {
            continue;
          }
          const stagingDir = win32.join(scope, entry.name);
          if (await fs.hasRunningExe(stagingDir)) {
            cleanup.inUse.push(stagingDir);
            continue;
          }
          try {
            await fs.rm(stagingDir);
            cleanup.removed.push(stagingDir);
          } catch {
            cleanup.failed.push(stagingDir);
          }
        }
      }
      return cleanup;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(emptyCleanup())));
}

function emptyCleanup(): NpmStagingCleanup {
  return { failed: [], inUse: [], removed: [] };
}

export { isNpmStagingDirName, npmScopeDirsForPaths, removeNpmStagingDirs };
export type { NpmStagingCleanup, NpmStagingFs };
