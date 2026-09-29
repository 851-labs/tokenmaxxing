import { existsSync, readlinkSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * The `PATH` a service install bakes into the scheduled wrapper, made the same
 * from any terminal on the machine. The scheduled runner only uses it to find
 * `bun` (and `npx`/`node` as the fallback, plus `node` for ccusage's
 * `#!/usr/bin/env node`), but the captured value used to differ per shell:
 * fnm puts a per-shell symlink first, agent apps add session directories, and
 * package-manager scripts add `node_modules/.bin`. Every refresh then rewrote
 * the wrapper, which is the executable macOS Background Task Management tracks.
 */

type PathModule = typeof posix;

interface StableServicePathOptions {
  env?: Record<string, string | undefined> | undefined;
  exists?: ((path: string) => boolean) | undefined;
  platform?: NodeJS.Platform | undefined;
  readLink?: ((path: string) => string) | undefined;
}

// Version-manager install directories that a shell (or the manager's own exec)
// puts on PATH for one version, and the manager's shims that resolve the default
// version from anywhere. The install dir stays when there are no shims.
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
  const tempDirs = temporaryDirectories(options.env ?? process.env, platform);
  const seen = new Set<string>();
  const entries: string[] = [];

  for (const raw of value.split(path.delimiter)) {
    let entry = trimTrailingSeparators(raw, path);
    if (entry === "" || !path.isAbsolute(entry)) {
      continue;
    }

    const fnm = /^(.*[\\/]fnm_multishells[\\/][^\\/]+)(.*)$/.exec(entry);
    if (fnm !== null) {
      const resolved = resolveFnmMultishell(fnm[1]!, { exists, path, readLink });
      if (resolved === null) {
        continue;
      }
      entry = trimTrailingSeparators(path.join(resolved, fnm[2]!), path);
    }

    if (isVolatilePathEntry(entry, tempDirs, platform)) {
      continue;
    }
    entry = durableVersionManagerEntry(entry, { exists, path });

    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }

  return entries.length > 0 ? entries.join(path.delimiter) : defaultServicePath(platform);
}

// fnm's per-shell directory is a symlink to `<fnm dir>/aliases/default` or to
// the version the shell selected (`<fnm dir>/node-versions/<v>/installation`).
// The default alias is what any new shell starts with, so it wins when it exists.
// A per-shell directory that is gone was only ever useful to that shell.
function resolveFnmMultishell(
  multishellDir: string,
  {
    exists,
    path,
    readLink,
  }: {
    exists: (path: string) => boolean;
    path: PathModule;
    readLink: (path: string) => string;
  },
): string | null {
  let target: string;
  try {
    target = path.resolve(path.dirname(multishellDir), readLink(multishellDir));
  } catch {
    return null;
  }

  const fnmDir = /^(.*)[\\/](?:aliases|node-versions)[\\/]/.exec(target)?.[1];
  const defaultAlias = fnmDir === undefined ? null : path.join(fnmDir, "aliases", "default");

  return defaultAlias !== null && exists(defaultAlias) ? defaultAlias : target;
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
