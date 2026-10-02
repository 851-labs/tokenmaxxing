import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { retryWindowsFs, sleep } from "./windows-fs-retry";

/**
 * Removes the service runners dir (`<config dir>\service-runners`) on
 * uninstall, including when a runner in it is still running.
 *
 * Windows never deletes the image of a running process, so an uninstall run
 * by the runner exe itself (or while a scheduled sync is still running) could
 * delete everything but that exe. Windows does let a running image be renamed,
 * and with it the dir it sits in, which is how npm moves a running package
 * aside. So on Windows a runners dir that will not go away is renamed to a
 * retired name next to it: the service is fully uninstalled at once, and a
 * later install writes a fresh runners dir. A hidden wscript.exe waits for the
 * exe to exit and deletes the retired dir, and every later install, uninstall
 * and scheduled run sweeps any retired dir that is still there.
 *
 * Both the delete and the rename can also fail for a moment while antivirus,
 * the indexer or a child that just exited still holds a handle in the dir, so
 * they are retried for about 2 s (windows-fs-retry.ts). A dir that still will
 * not go (a handle held for longer, without the share-delete flag) gets the
 * same hidden cleanup, deleting it where it is: the uninstall still leaves
 * nothing behind once the handle goes. That cleanup is pending under a
 * `service-runners.pending-<id>` marker, and an install that would write into
 * the dir first claims it (deletes the marker and waits for the script to see
 * that), so the cleanup never deletes a reinstalled runner.
 */

const RETIRED_RUNNERS_PREFIX = "service-runners.retired-";
const RETIRED_RUNNERS_NAME = /^service-runners\.retired-[0-9a-f]{8}$/;
const CLEANUP_SCRIPT_EXTENSION = ".vbs";
// How long the cleanup script keeps retrying: a scheduled sync that was
// running during the uninstall can take a few minutes to finish.
const CLEANUP_ATTEMPTS = 300;
const CLEANUP_INTERVAL_MS = 1000;
// A cleanup of the runners dir in place: the marker `service-runners.pending-<id>`
// keeps it going, and its script is the marker's name plus `.vbs`.
const PENDING_RUNNERS_PREFIX = "service-runners.pending-";
const PENDING_RUNNERS_NAME = /^service-runners\.pending-[0-9a-f]{8}$/;
// An install waits this long for a pending cleanup to see its marker is gone;
// the script checks once a second, so only a dead script runs it out.
const CLAIM_WAIT_MS = 3000;
const CLAIM_POLL_MS = 100;

interface RunnerRemovalFs {
  exists: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<Dirent[]>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  /** Waits between retries of a delete or rename Windows refused for a moment. */
  sleep: (ms: number) => Promise<void>;
  /** Starts the detached, hidden cleanup script. Never throws. */
  startCleanup: (scriptPath: string) => void;
  writeFile: (path: string, content: string) => Promise<void>;
}

type RunnersRemoval =
  | { readonly _tag: "removed" }
  /** Retired aside because a runner in it is running; deleted once it exits. */
  | { readonly _tag: "retired"; readonly path: string }
  /**
   * Windows refused both the delete and the rename aside, after retries. The
   * dir stays where it is and the hidden cleanup deletes it once whatever
   * holds it lets go, unless an install claims it first.
   */
  | { readonly _tag: "deferred"; readonly path: string; readonly cause: unknown }
  /**
   * As `deferred`, but the cleanup could not be started either. The dir stays
   * where it is; the next install or uninstall deals with it.
   */
  | { readonly _tag: "left"; readonly path: string; readonly cause: unknown };

const nodeFs: RunnerRemovalFs = {
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  readdir: (path) => readdir(path, { withFileTypes: true }),
  rename,
  rm: (path) => rm(path, { force: true, recursive: true }),
  sleep,
  startCleanup: (scriptPath) => {
    try {
      // wscript.exe is a GUI program, so the detached script opens no console
      // window, and it needs no console program to wait or delete.
      const child = spawn(
        windowsScriptHostPath(process.env),
        ["//B", "//NoLogo", "//E:VBScript", scriptPath],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.on("error", () => {
        // The next install, uninstall or scheduled run sweeps the retired dir.
      });
      child.unref();
    } catch {
      // As above.
    }
  },
  writeFile: (path, content) => writeFile(path, content),
};

// Task Scheduler runs actions from its native (64-bit on x64/arm64) host, so %SystemRoot%\System32
// is always the native wscript.exe there, even if this CLI runs under WOW64 file-system redirection.
function windowsScriptHostPath(env: Record<string, string | undefined> = process.env): string {
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";

  return `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\wscript.exe`;
}

function isRetiredRunnersName(name: string): boolean {
  return RETIRED_RUNNERS_NAME.test(name);
}

function isPendingRunnersName(name: string): boolean {
  return PENDING_RUNNERS_NAME.test(name);
}

function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8);
}

function retiredRunnersPath(runnersDir: string, id: string = randomUUID()): string {
  return join(dirname(runnersDir), `${RETIRED_RUNNERS_PREFIX}${shortId(id)}`);
}

function pendingRunnersMarkerPath(runnersDir: string, id: string = randomUUID()): string {
  return join(dirname(runnersDir), `${PENDING_RUNNERS_PREFIX}${shortId(id)}`);
}

/**
 * The cleanup script for a retired dir sits next to it as `<dir>.vbs`, so the
 * path never travels through a command line. It retries until the dir is
 * gone, then deletes itself. Plain ASCII: wscript reads a script without a
 * byte-order mark in the ANSI code page.
 */
function renderRunnerCleanupScript(): string {
  return `' Generated by tokenmaxxing. Deletes a service runner dir that was still running at uninstall.\r
Option Explicit\r
Dim fso, target, attempt\r
Set fso = CreateObject("Scripting.FileSystemObject")\r
target = Left(WScript.ScriptFullName, Len(WScript.ScriptFullName) - ${CLEANUP_SCRIPT_EXTENSION.length})\r
On Error Resume Next\r
For attempt = 1 To ${CLEANUP_ATTEMPTS}\r
  WScript.Sleep ${CLEANUP_INTERVAL_MS}\r
  If fso.FolderExists(target) Then fso.DeleteFolder target, True\r
  Err.Clear\r
  If Not fso.FolderExists(target) Then Exit For\r
Next\r
If Not fso.FolderExists(target) Then fso.DeleteFile WScript.ScriptFullName, True\r
`;
}

/**
 * The cleanup script for the runners dir itself, which could not be retired
 * aside. It sits next to its marker as `<marker>.vbs` and deletes the dir
 * next to them (`service-runners`) while the marker is there. An install
 * claims the dir by deleting the marker; the script stops at its next check
 * and deletes itself, which is what the install waits for, so a delete it had
 * already begun is over before the install writes a runner. It deletes itself
 * when it stops for any reason, and the marker once the dir is gone.
 */
function renderPendingRunnersCleanupScript(): string {
  return `' Generated by tokenmaxxing. Deletes the service runners dir that was still in use at uninstall, unless an install claims it first.\r
Option Explicit\r
Dim fso, marker, target, attempt\r
Set fso = CreateObject("Scripting.FileSystemObject")\r
marker = Left(WScript.ScriptFullName, Len(WScript.ScriptFullName) - ${CLEANUP_SCRIPT_EXTENSION.length})\r
target = Left(marker, InStrRev(marker, ".pending-") - 1)\r
On Error Resume Next\r
For attempt = 1 To ${CLEANUP_ATTEMPTS}\r
  WScript.Sleep ${CLEANUP_INTERVAL_MS}\r
  If Not fso.FileExists(marker) Then Exit For\r
  If fso.FolderExists(target) Then fso.DeleteFolder target, True\r
  Err.Clear\r
  If Not fso.FolderExists(target) Then Exit For\r
Next\r
If Not fso.FolderExists(target) Then fso.DeleteFile marker, True\r
Err.Clear\r
fso.DeleteFile WScript.ScriptFullName, True\r
`;
}

/**
 * Deletes the runners dir. On Windows, a dir that keeps a running runner is
 * renamed aside and handed to the cleanup script instead. Windows can refuse
 * both for a moment (a handle someone else holds in the dir), so the pair is
 * retried; a dir that still cannot be deleted or renamed is handed to the
 * cleanup script where it is, and only reported as left when that script
 * cannot be started either. Elsewhere a running binary never blocks the
 * delete, and a failed delete fails the removal.
 */
async function removeRunnersDir(
  runnersDir: string,
  platform: NodeJS.Platform,
  fs: RunnerRemovalFs,
): Promise<RunnersRemoval> {
  if (platform !== "win32") {
    await fs.rm(runnersDir);
    return { _tag: "removed" };
  }

  const retired = retiredRunnersPath(runnersDir);
  let moved: boolean;
  try {
    moved = await retryWindowsFs(
      async () => {
        try {
          await fs.rm(runnersDir);
          return false;
        } catch {
          // A running runner keeps its image, and so the dir; move it aside.
          await fs.rename(runnersDir, retired);
          return true;
        }
      },
      { platform, sleep: fs.sleep },
    );
  } catch (cause) {
    if (!(await fs.exists(runnersDir))) {
      return removedRunnersDir(runnersDir, fs);
    }
    // Most likely the runner running this uninstall, or antivirus scanning
    // it, for longer than the retries wait. Deleting the dir where it is,
    // once it lets go, leaves the same result as retiring it.
    try {
      const markerPath = pendingRunnersMarkerPath(runnersDir);
      await fs.writeFile(markerPath, "");
      const scriptPath = `${markerPath}${CLEANUP_SCRIPT_EXTENSION}`;
      await fs.writeFile(scriptPath, renderPendingRunnersCleanupScript());
      fs.startCleanup(scriptPath);
    } catch {
      return { _tag: "left", cause, path: runnersDir };
    }
    return { _tag: "deferred", cause, path: runnersDir };
  }
  if (!moved) {
    return removedRunnersDir(runnersDir, fs);
  }
  // Everything but the running image goes now.
  await fs.rm(retired).catch(() => {});
  if (!(await fs.exists(retired))) {
    return removedRunnersDir(runnersDir, fs);
  }
  try {
    const scriptPath = `${retired}${CLEANUP_SCRIPT_EXTENSION}`;
    await fs.writeFile(scriptPath, renderRunnerCleanupScript());
    fs.startCleanup(scriptPath);
  } catch {
    // The next install, uninstall or scheduled run sweeps the retired dir.
  }
  return { _tag: "retired", path: retired };
}

/**
 * With the runners dir gone, a cleanup an earlier uninstall left pending has
 * nothing to delete: its marker and script go too (a script still running
 * stops at its next check).
 */
async function removedRunnersDir(runnersDir: string, fs: RunnerRemovalFs): Promise<RunnersRemoval> {
  const configDir = dirname(runnersDir);
  for (const entry of await fs.readdir(configDir).catch(() => [])) {
    if (entry.isFile() && isPendingRunnersFile(entry.name)) {
      await fs.rm(join(configDir, entry.name)).catch(() => {});
    }
  }
  return { _tag: "removed" };
}

function isPendingRunnersFile(name: string): boolean {
  return (
    isPendingRunnersName(name) ||
    (name.endsWith(CLEANUP_SCRIPT_EXTENSION) &&
      isPendingRunnersName(name.slice(0, -CLEANUP_SCRIPT_EXTENSION.length)))
  );
}

/**
 * Cancels every cleanup of the runners dir an uninstall left pending, before
 * an install writes a runner into it: deletes each marker, then waits for
 * each script to see that and delete itself. A script that never does (its
 * wscript.exe was stopped, say by a restart) is deleted after a few seconds.
 * Returns whether there was anything to cancel. Never fails.
 */
async function claimRunnersDir(runnersDir: string, fs: RunnerRemovalFs): Promise<boolean> {
  const configDir = dirname(runnersDir);
  const entries = await fs.readdir(configDir).catch(() => []);
  const markers = entries
    .filter((entry) => entry.isFile() && isPendingRunnersName(entry.name))
    .map((entry) => join(configDir, entry.name));
  const scripts = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(CLEANUP_SCRIPT_EXTENSION) &&
        isPendingRunnersName(entry.name.slice(0, -CLEANUP_SCRIPT_EXTENSION.length)),
    )
    .map((entry) => join(configDir, entry.name));
  if (markers.length === 0 && scripts.length === 0) {
    return false;
  }

  for (const marker of markers) {
    await fs.rm(marker).catch(() => {});
  }
  for (let waited = 0; waited < CLAIM_WAIT_MS; waited += CLAIM_POLL_MS) {
    if (!(await anyExists(scripts, fs))) {
      return true;
    }
    await fs.sleep(CLAIM_POLL_MS);
  }
  for (const script of scripts) {
    await fs.rm(script).catch(() => {});
  }
  return true;
}

async function anyExists(paths: readonly string[], fs: RunnerRemovalFs): Promise<boolean> {
  for (const path of paths) {
    if (await fs.exists(path)) {
      return true;
    }
  }
  return false;
}

/**
 * Deletes the retired runner dirs in `configDir`, then the cleanup scripts
 * whose dir is gone (their wscript.exe was stopped before it finished). A dir
 * whose runner is still running stays for a later run. Never fails.
 */
async function sweepRetiredRunners(configDir: string, fs: RunnerRemovalFs): Promise<void> {
  const entries = await fs.readdir(configDir).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && isRetiredRunnersName(entry.name)) {
      await fs.rm(join(configDir, entry.name)).catch(() => {});
    }
  }
  for (const entry of entries) {
    const dirName = entry.name.slice(0, -CLEANUP_SCRIPT_EXTENSION.length);
    if (
      entry.isFile() &&
      entry.name.endsWith(CLEANUP_SCRIPT_EXTENSION) &&
      isRetiredRunnersName(dirName) &&
      !(await fs.exists(join(configDir, dirName)))
    ) {
      await fs.rm(join(configDir, entry.name)).catch(() => {});
    }
  }
}

function removeServiceRunnersDir(
  runnersDir: string,
  platform: NodeJS.Platform = process.platform,
  fs: RunnerRemovalFs = nodeFs,
): Effect.Effect<RunnersRemoval, unknown> {
  return Effect.tryPromise({
    try: () => removeRunnersDir(runnersDir, platform, fs),
    catch: (cause) => cause,
  });
}

function removeRetiredServiceRunners(
  runnersDir: string,
  platform: NodeJS.Platform = process.platform,
  fs: RunnerRemovalFs = nodeFs,
): Effect.Effect<void, never> {
  if (platform !== "win32") {
    return Effect.void;
  }

  return Effect.tryPromise({
    try: () => sweepRetiredRunners(dirname(runnersDir), fs),
    catch: (cause) => cause,
  }).pipe(Effect.ignore);
}

function claimServiceRunnersDir(
  runnersDir: string,
  platform: NodeJS.Platform = process.platform,
  fs: RunnerRemovalFs = nodeFs,
): Effect.Effect<boolean, never> {
  if (platform !== "win32") {
    return Effect.succeed(false);
  }

  return Effect.tryPromise({
    try: () => claimRunnersDir(runnersDir, fs),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

export {
  claimServiceRunnersDir,
  isPendingRunnersName,
  isRetiredRunnersName,
  removeRetiredServiceRunners,
  pendingRunnersMarkerPath,
  removeServiceRunnersDir,
  renderPendingRunnersCleanupScript,
  renderRunnerCleanupScript,
  retiredRunnersPath,
  windowsScriptHostPath,
};
export type { RunnerRemovalFs, RunnersRemoval };
