import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * The `PATH` a service install bakes into the scheduled wrapper, made the same
 * from any terminal on the machine. The scheduled runner only uses it to find
 * `bun` (and `npx`/`node` as the fallback, plus `node` for ccusage's
 * `#!/usr/bin/env node`), but the captured value used to differ per shell:
 * fnm puts a per-shell symlink first, agent apps add session directories, and
 * package-manager scripts add `node_modules/.bin`. Every refresh then rewrote
 * the wrapper, which is the executable macOS Background Task Management tracks.
 *
 * asdf, mise and nodenv shims pick a Node version from the working directory's
 * `.tool-versions`/`mise.toml`/`.node-version`, which a scheduled job (cwd `/`
 * under launchd, `~` under systemd) usually does not have: a node set only for
 * a project fails there with "No version is set for command node". So their
 * entries become the newest installed Node's own bin directory, ahead of the
 * shims, whether the shell put the shims or a version's directory on PATH.
 */

type PathModule = typeof posix;

interface StableServicePathOptions {
  env?: Record<string, string | undefined> | undefined;
  exists?: ((path: string) => boolean) | undefined;
  platform?: NodeJS.Platform | undefined;
  readDir?: ((path: string) => string[]) | undefined;
  readLink?: ((path: string) => string) | undefined;
}

/** A Node version manager on PATH: `root` holds its shims and installed versions. */
interface NodeVersionManagerEntry {
  /** `shims` is where the manager's node goes on PATH; `exec` entries are dropped. */
  kind: "exec" | "install" | "shims";
  root: string;
}

// Version-manager install directories that a shell (or the manager's own exec)
// puts on PATH for one version, and the manager's shims that resolve the default
// version from anywhere. The install dir stays when there are no shims. For
// asdf and mise this only applies without an installed Node (see nodeBinDir).
const VERSION_MANAGER_SHIMS: ReadonlyArray<{ durable: string; pattern: RegExp }> = [
  { durable: "bin", pattern: /^(.*[\\/]\.?volta)[\\/]tools[\\/]image[\\/]/i },
  { durable: "shims", pattern: /^(.*[\\/]\.asdf)[\\/]installs[\\/]/ },
  { durable: "shims", pattern: /^(.*[\\/]mise)[\\/]installs[\\/]/ },
];

function stableServicePath(value: string, options: StableServicePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const exists = options.exists ?? existsSync;
  const readLink = options.readLink ?? readlinkSync;
  const readDir = options.readDir ?? readDirOrEmpty;
  const env = options.env ?? process.env;
  const tempDirs = temporaryDirectories(env, platform);
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const raw of value.split(path.delimiter)) {
    let entry = trimTrailingSeparators(raw, path);
    if (entry === "" || !path.isAbsolute(entry)) {
      continue;
    }

    const fnm = /^(.*[\\/]fnm_multishells[\\/][^\\/]+)(.*)$/.exec(entry);
    if (fnm !== null) {
      const resolved = resolveFnmMultishell(fnm[1]!, { env, exists, path, platform, readLink });
      if (resolved === null) {
        continue;
      }
      entry = trimTrailingSeparators(path.join(resolved, fnm[2]!), path);
    }

    if (!isVolatilePathEntry(entry, tempDirs, platform)) {
      kept.push(entry);
    }
  }

  // A manager's node goes where its shims are on PATH, so a shell that runs node
  // through `asdf exec` (which prepends the version's dir) and one that does not
  // give the same PATH; without its shims on PATH, where its first entry was.
  const managers = new Map<string, string[] | null>();
  const managerEntries = kept.map((entry) => nodeVersionManagerEntry(entry, path));
  const nodeDirs = (root: string) => {
    if (!managers.has(root)) {
      const bin = nodeBinDir(root, { exists, path, platform, readDir });
      const shims = path.join(root, "shims");
      managers.set(root, bin === null ? null : exists(shims) ? [bin, shims] : [bin]);
    }
    return managers.get(root)!;
  };
  const anchors = new Map<string, number>();
  managerEntries.forEach((manager, index) => {
    if (manager === null || nodeDirs(manager.root) === null) {
      return;
    }
    const anchor = anchors.get(manager.root);
    if (
      anchor === undefined ||
      (manager.kind === "shims" && managerEntries[anchor]?.kind !== "shims")
    ) {
      anchors.set(manager.root, index);
    }
  });

  const entries: string[] = [];
  const add = (entry: string) => {
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  };
  kept.forEach((entry, index) => {
    const manager = managerEntries[index];
    const dirs = manager === null || manager === undefined ? null : nodeDirs(manager.root);
    if (manager === null || manager === undefined || dirs === null) {
      add(durableVersionManagerEntry(entry, { exists, path }));
    } else if (anchors.get(manager.root) === index) {
      dirs.forEach(add);
    }
  });

  return entries.length > 0 ? entries.join(path.delimiter) : defaultServicePath(platform);
}

/**
 * Which part of an asdf, mise or nodenv install `entry` is: its `shims`, a
 * version's directory (`installs/<tool>/<v>/…`, `versions/<v>/bin`), or what
 * `asdf exec`/`nodenv exec` add for one command (`plugins/<p>/shims`,
 * `plugins/<p>/bin`, `libexec`). Only a root with a Node installed counts
 * (nodeBinDir), so rbenv or pyenv directories are left alone.
 */
function nodeVersionManagerEntry(entry: string, path: PathModule): NodeVersionManagerEntry | null {
  const patterns: ReadonlyArray<[NodeVersionManagerEntry["kind"], RegExp]> = [
    ["exec", /^(.+)[\\/]plugins[\\/][^\\/]+[\\/](?:shims|bin)$/],
    ["exec", /^(.+)[\\/]libexec$/],
    ["shims", /^(.+)[\\/]shims$/],
    ["install", /^(.+)[\\/]installs[\\/][^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/],
    ["install", /^(.+)[\\/]versions[\\/][^\\/]+[\\/]bin$/],
  ];
  for (const [kind, pattern] of patterns) {
    const root = pattern.exec(entry)?.[1];
    if (root !== undefined && path.isAbsolute(root)) {
      return { kind, root };
    }
  }

  return null;
}

/**
 * The bin directory of the newest Node that asdf (`installs/nodejs/<v>`), mise
 * (`installs/node/<v>`) or nodenv (`versions/<v>`) has installed under `root`,
 * or null without one. The newest, not the one the shell selected: that depends
 * on the directory the CLI ran in, and the wrapper must not. Aliases such as
 * mise's `lts` or `22` → `22.21.0` are skipped for the version they name.
 */
function nodeBinDir(
  root: string,
  {
    exists,
    path,
    platform,
    readDir,
  }: {
    exists: (path: string) => boolean;
    path: PathModule;
    platform: NodeJS.Platform;
    readDir: (path: string) => string[];
  },
): string | null {
  const versions = [
    path.join(root, "installs", "nodejs"),
    path.join(root, "installs", "node"),
    path.join(root, "versions"),
  ].flatMap((dir) =>
    readDir(dir).flatMap((name) => {
      const match = /^v?(\d+(?:\.\d+)*)$/.exec(name);
      return match === null
        ? []
        : [{ dir: path.join(dir, name), parts: match[1]!.split(".").map(Number) }];
    }),
  );
  versions.sort((a, b) => compareVersionParts(b.parts, a.parts));
  for (const { dir } of versions) {
    // mise on Windows keeps node.exe in the version's own directory.
    const bin = platform === "win32" ? dir : path.join(dir, "bin");
    if (exists(path.join(bin, platform === "win32" ? "node.exe" : "node"))) {
      return bin;
    }
  }

  return null;
}

// Newer first, then the full version over a shorter alias of it (22.21.0 over 22).
function compareVersionParts(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function readDirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// fnm's per-shell directory is a symlink to `<fnm dir>/aliases/default` or to
// the version the shell selected (`<fnm dir>/node-versions/<v>/installation`).
// The default alias is what any new shell starts with, so it wins when it exists.
// A per-shell directory that is gone (they live on tmpfs under /run/user on
// Linux, so a reboot removes them) still means "fnm's node": it resolves to
// the default alias in fnm's usual data dirs, and is dropped only without one.
function resolveFnmMultishell(
  multishellDir: string,
  {
    env,
    exists,
    path,
    platform,
    readLink,
  }: {
    env: Record<string, string | undefined>;
    exists: (path: string) => boolean;
    path: PathModule;
    platform: NodeJS.Platform;
    readLink: (path: string) => string;
  },
): string | null {
  let target: string;
  try {
    target = path.resolve(path.dirname(multishellDir), readLink(multishellDir));
  } catch {
    return (
      fnmDataDirs(env, platform, path)
        .map((dir) => path.join(dir, "aliases", "default"))
        .find((alias) => exists(alias)) ?? null
    );
  }

  const fnmDir = /^(.*)[\\/](?:aliases|node-versions)[\\/]/.exec(target)?.[1];
  const defaultAlias = fnmDir === undefined ? null : path.join(fnmDir, "aliases", "default");

  return defaultAlias !== null && exists(defaultAlias) ? defaultAlias : target;
}

// Where fnm keeps its versions and aliases: FNM_DIR, else its XDG data dir,
// the macOS application-support dir, %APPDATA%\fnm on Windows, or the legacy
// ~/.fnm. A service wrapper never exports FNM_DIR, so a repair that finds the
// per-shell junction gone relies on these defaults.
function fnmDataDirs(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  path: PathModule,
): string[] {
  const home = env["HOME"] ?? env["USERPROFILE"];
  const dirs = [
    env["FNM_DIR"],
    env["XDG_DATA_HOME"] === undefined ? undefined : path.join(env["XDG_DATA_HOME"], "fnm"),
    home === undefined ? undefined : path.join(home, ".local", "share", "fnm"),
    home === undefined || platform !== "darwin"
      ? undefined
      : path.join(home, "Library", "Application Support", "fnm"),
    platform !== "win32" || env["APPDATA"] === undefined
      ? undefined
      : path.join(env["APPDATA"], "fnm"),
    home === undefined ? undefined : path.join(home, ".fnm"),
  ];

  return dirs.filter(
    (dir): dir is string => dir !== undefined && dir !== "" && path.isAbsolute(dir),
  );
}

function isVolatilePathEntry(
  entry: string,
  tempDirs: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const normalized = entry.replaceAll("\\", "/");
  const comparable = platform === "win32" ? normalized.toLowerCase() : normalized;

  return (
    tempDirs.some((dir) => isSameOrChild(comparable, dir)) ||
    // Package-manager scripts (npm/pnpm/yarn/bun run) prepend the project's bins.
    /\/node_modules\/\.bin(\/|$)/.test(comparable) ||
    /\/node-gyp-bin(\/|$)/.test(comparable) ||
    // Agent apps put per-session tool directories on PATH, for example
    // ~/Library/Application Support/Claude/local-agent-mode-sessions/<id>/bin.
    /\/Library\/Application Support\/.*session/i.test(normalized) ||
    // App bundles (a terminal's own Contents/MacOS, an editor's CLI) differ per
    // terminal and never hold bun or node.
    (platform === "darwin" && /\.app\/Contents(\/|$)/.test(normalized))
  );
}

function durableVersionManagerEntry(
  entry: string,
  { exists, path }: { exists: (path: string) => boolean; path: PathModule },
): string {
  for (const { durable, pattern } of VERSION_MANAGER_SHIMS) {
    const root = pattern.exec(entry)?.[1];
    if (root !== undefined) {
      const shims = path.join(root, durable);
      return exists(shims) ? shims : entry;
    }
  }

  return entry;
}

function temporaryDirectories(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  const path = platform === "win32" ? win32 : posix;
  const fromEnv = (platform === "win32" ? [env["TEMP"], env["TMP"]] : [env["TMPDIR"]]).filter(
    (dir): dir is string => dir !== undefined && dir !== "" && path.isAbsolute(dir),
  );
  const fixed =
    platform === "win32" ? [] : ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

  return [...fromEnv, ...fixed].map((dir) => {
    const normalized = trimTrailingSeparators(dir, path).replaceAll("\\", "/");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  });
}

function isSameOrChild(entry: string, dir: string): boolean {
  return entry === dir || entry.startsWith(`${dir}/`);
}

function trimTrailingSeparators(entry: string, path: PathModule): string {
  const root = path.parse(entry).root;
  const separator = path === win32 ? /[\\/]$/ : /\/$/;
  let trimmed = entry;
  while (trimmed.length > root.length && separator.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

function defaultServicePath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows"
    : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

export { defaultServicePath, stableServicePath };

export type { StableServicePathOptions };
