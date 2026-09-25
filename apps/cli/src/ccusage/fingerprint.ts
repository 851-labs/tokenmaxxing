import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import type { UsageSource } from "@tokenmaxxing/api-contract";

/**
 * Cheap change detection for a source's agent logs, so a scheduled sync can
 * skip re-parsing a corpus that has not changed since it was last uploaded.
 *
 * The roots mirror where ccusage v20 looks (rust/adapters/<source>/src/paths.rs
 * upstream), including the env overrides it honors. A fingerprint covers
 * every matching file's path, size, and mtime. It deliberately does not look
 * at dates: any change (append, new file, deletion, archive move) produces a
 * new fingerprint, and a false "changed" only costs one extra ccusage run.
 * When ccusage could read logs from somewhere this module cannot see (a
 * ccusage config file can point pi at other stores), the source has no
 * fingerprint and always runs.
 */

type Env = Record<string, string | undefined>;

type LogRoot =
  /** One file; missing is recorded as missing. */
  | { kind: "file"; path: string }
  /** Direct children of `path` whose names match. */
  | { kind: "children"; match: (name: string) => boolean; path: string }
  /** Every file under `path` (recursively) with one of `extensions`. */
  | { extensions: readonly string[]; kind: "tree"; path: string };

interface LogRootOptions {
  cwd?: string | undefined;
  env?: Env | undefined;
  home?: string | undefined;
}

interface SourceFingerprint {
  bytes: number;
  digest: string;
  files: number;
}

async function sourceLogRoots(
  source: UsageSource,
  options: LogRootOptions = {},
): Promise<LogRoot[] | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configFiles = ccusageConfigFiles(env, home, options.cwd ?? process.cwd());

  switch (source) {
    case "claude":
      return [...claudeProjectDirs(env, home).map((path) => tree(path, ["jsonl"])), ...configFiles];
    case "codex":
      return [
        ...(await codexUsageDirs(env, home)).map((path) => tree(path, ["jsonl"])),
        ...configFiles,
      ];
    case "copilot": {
      const root = nonEmpty(env.COPILOT_HOME) ?? join(home, ".copilot");
      const exporter = nonEmpty(env.COPILOT_OTEL_FILE_EXPORTER_PATH);
      return [
        tree(join(root, "otel"), ["jsonl"]),
        tree(join(root, "session-state"), ["jsonl"]),
        ...(exporter === undefined ? [] : [file(exporter)]),
        ...configFiles,
      ];
    }
    case "gemini":
      return [
        ...envPaths(env.GEMINI_DATA_DIR, [join(home, ".gemini", "tmp")]).map((path) =>
          tree(path, ["json", "jsonl"]),
        ),
        ...configFiles,
      ];
    case "hermes":
      return [
        ...envPaths(env.HERMES_HOME, [join(home, ".hermes")]).map((path) => ({
          kind: "children" as const,
          match: (name: string) => /^state\.db(?:-wal|-journal)?$/.test(name),
          path,
        })),
        ...configFiles,
      ];
    case "opencode":
      return [
        ...opencodeDataDirs(env, home).flatMap((path) => [
          tree(join(path, "storage", "message"), ["json"]),
          {
            kind: "children" as const,
            match: (name: string) => /^opencode(?:-[^/]*)?\.db(?:-wal|-journal)?$/.test(name),
            path,
          },
        ]),
        ...configFiles,
      ];
    case "pi":
      // ccusage.json can add pi paths and named stores this module does not parse.
      if (await anyFileExists(configFiles.map((root) => root.path))) {
        return null;
      }
      return envPaths(env.PI_AGENT_DIR, [join(home, ".pi", "agent", "sessions")]).map((path) =>
        tree(path, ["jsonl"]),
      );
  }
}

async function fingerprintSource(
  source: UsageSource,
  options: LogRootOptions = {},
): Promise<SourceFingerprint | null> {
  const roots = await sourceLogRoots(source, options);
  return roots === null ? null : fingerprintRoots(roots);
}

/**
 * Hashes `path size mtime` for every file the roots match. Missing roots are
 * part of the digest too, so a log directory appearing is a change.
 */
async function fingerprintRoots(roots: readonly LogRoot[]): Promise<SourceFingerprint> {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const addFile = (path: string, size: number, mtimeMs: number) => {
    hash.update(`f\0${path}\0${size}\0${mtimeMs}\n`);
    bytes += size;
    files += 1;
  };
  const addFiles = async (paths: readonly string[]) => {
    const infos = await Promise.all(paths.map((path) => stat(path).catch(() => null)));
    infos.forEach((info, index) => {
      if (info?.isFile() === true) {
        addFile(paths[index]!, info.size, info.mtimeMs);
      }
    });
  };

  for (const root of roots) {
    if (root.kind === "file") {
      const info = await stat(root.path).catch(() => null);
      if (info?.isFile() === true) {
        addFile(root.path, info.size, info.mtimeMs);
      } else {
        hash.update(`m\0${root.path}\n`);
      }
      continue;
    }

    const entries = await readSortedDir(root.path);
    if (entries === null) {
      hash.update(`m\0${root.path}\n`);
      continue;
    }

    if (root.kind === "children") {
      await addFiles(
        entries
          .filter((entry) => entry.isFile() && root.match(entry.name))
          .map((entry) => join(root.path, entry.name)),
      );
      continue;
    }

    // Depth-first in sorted order so the digest is stable. Like ccusage, only
    // real files and directories count; symlinks inside a root are ignored.
    const stack: Array<{ dir: string; entries: Dirent[] }> = [{ dir: root.path, entries }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const directories: string[] = [];
      const matched: string[] = [];
      for (const entry of frame.entries) {
        const path = join(frame.dir, entry.name);
        if (entry.isDirectory()) {
          directories.push(path);
        } else if (entry.isFile() && hasExtension(entry.name, root.extensions)) {
          matched.push(path);
        }
      }
      await addFiles(matched);
      for (const dir of directories.reverse()) {
        const children = await readSortedDir(dir);
        if (children !== null) {
          stack.push({ dir, entries: children });
        }
      }
    }
  }

  return { bytes, digest: hash.digest("hex"), files };
}

function claudeProjectDirs(env: Env, home: string): string[] {
  const configured = splitPaths(env.CLAUDE_CONFIG_DIR);
  if (configured !== undefined) {
    return configured.map((raw) => {
      const path = expandHome(raw, home);
      return basename(path) === "projects" ? path : join(path, "projects");
    });
  }

  const xdgConfig = nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config");
  return [join(xdgConfig, "claude", "projects"), join(home, ".claude", "projects")];
}

async function codexUsageDirs(env: Env, home: string): Promise<string[]> {
  const homes = splitPaths(env.CODEX_HOME) ?? [join(home, ".codex")];
  const dirs: string[] = [];
  for (const codexHome of homes) {
    const usageDirs = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
    const existing = await Promise.all(usageDirs.map(isDirectory));
    // ccusage reads the home itself when it has neither usage directory.
    dirs.push(...(existing.some(Boolean) ? usageDirs : [codexHome]));
  }

  return dirs;
}

function opencodeDataDirs(env: Env, home: string): string[] {
  const configured = splitPaths(env.OPENCODE_DATA_DIR);
  if (configured !== undefined) {
    return configured;
  }

  const xdgData = nonEmpty(env.XDG_DATA_HOME);
  const dataHome =
    xdgData !== undefined && isAbsolute(xdgData) ? xdgData : join(home, ".local", "share");
  return [join(dataHome, "opencode")];
}

/** ccusage reads `ccusage.json` from `./.ccusage/` and each Claude config dir. */
function ccusageConfigFiles(env: Env, home: string, cwd: string): LogRoot[] {
  const claudeDirs = splitPaths(env.CLAUDE_CONFIG_DIR) ?? [
    join(home, ".config", "claude"),
    join(home, ".claude"),
  ];

  return [join(cwd, ".ccusage"), ...claudeDirs].map((dir) => file(join(dir, "ccusage.json")));
}

function envPaths(value: string | undefined, fallback: string[]): string[] {
  return splitPaths(value) ?? fallback;
}

/** Comma-separated env paths; `undefined` when the variable is unset. */
function splitPaths(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }

  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function tree(path: string, extensions: readonly string[]): LogRoot {
  return { extensions, kind: "tree", path };
}

function file(path: string): LogRoot {
  return { kind: "file", path };
}

function hasExtension(name: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => name.endsWith(`.${extension}`));
}

async function readSortedDir(path: string): Promise<Dirent[] | null> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  return entries === null
    ? null
    : entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

async function anyFileExists(paths: readonly string[]): Promise<boolean> {
  const found = await Promise.all(
    paths.map(async (path) => (await stat(path).catch(() => null))?.isFile() === true),
  );
  return found.some(Boolean);
}

export { fingerprintRoots, fingerprintSource, sourceLogRoots };

export type { LogRoot, LogRootOptions, SourceFingerprint };
