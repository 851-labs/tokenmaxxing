import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  isRetiredRunnersName,
  removeRetiredServiceRunners,
  removeServiceRunnersDir,
  renderRunnerCleanupScript,
  retiredRunnersPath,
  type RunnerRemovalFs,
} from "./service-runner-removal";

// Built with the host's join, as servicePaths builds them.
const configDir = join("C:", "Users", "Zoë O'Neil (Work) & Co 100%", ".config", "tokenmaxxing");
const runnersDir = join(configDir, "service-runners");

const busy = (path: string) =>
  Object.assign(new Error(`EPERM: operation not permitted, unlink '${path}'`), { code: "EPERM" });

// A Windows filesystem where the paths in `running` keep a running runner:
// deleting them removes everything else but never the dir itself. A rename
// fails always (`renameFails: true`) or only the first few times, the way a
// handle antivirus holds in the dir goes away.
function fakeFs(options: {
  entries?: { kind: "dir" | "file"; name: string }[];
  existing?: string[];
  renameFails?: boolean | number;
  running?: string[];
  writeFails?: boolean;
}) {
  const existing = new Set(options.existing ?? [runnersDir]);
  const running = new Set(options.running ?? []);
  const calls = {
    rename: [] as [string, string][],
    rm: [] as string[],
    sleep: [] as number[],
    startCleanup: [] as string[],
    writeFile: [] as [string, string][],
  };
  let renameFailuresLeft =
    options.renameFails === true ? Number.POSITIVE_INFINITY : Number(options.renameFails ?? 0);
  const fs: RunnerRemovalFs = {
    exists: async (path) => existing.has(path),
    readdir: async () =>
      (options.entries ?? []).map(
        (entry) =>
          ({
            isDirectory: () => entry.kind === "dir",
            isFile: () => entry.kind === "file",
            name: entry.name,
          }) as Dirent,
      ),
    rename: async (from, to) => {
      calls.rename.push([from, to]);
      if (renameFailuresLeft > 0) {
        renameFailuresLeft--;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), {
          code: "EBUSY",
        });
      }
      existing.delete(from);
      existing.add(to);
      if (running.delete(from)) {
        running.add(to);
      }
    },
    rm: async (path) => {
      calls.rm.push(path);
      if (running.has(path)) {
        throw busy(path);
      }
      existing.delete(path);
    },
    sleep: async (ms) => {
      calls.sleep.push(ms);
    },
    startCleanup: (scriptPath) => {
      calls.startCleanup.push(scriptPath);
    },
    writeFile: async (path, content) => {
      calls.writeFile.push([path, content]);
      if (options.writeFails) {
        throw busy(path);
      }
      existing.add(path);
    },
  };
  return { calls, existing, fs };
}

describe("removeServiceRunnersDir", () => {
  it("deletes a runners dir that nothing is running from", async () => {
    const { calls, existing, fs } = fakeFs({});

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", fs));

    expect(removal).toEqual({ _tag: "removed" });
    expect(calls.rename).toEqual([]);
    expect(calls.startCleanup).toEqual([]);
    expect(existing.has(runnersDir)).toBe(false);
  });

  it("retires a runners dir whose runner is running and hands it to the hidden cleanup", async () => {
    const { calls, existing, fs } = fakeFs({ running: [runnersDir] });

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", fs));

    expect(removal._tag).toBe("retired");
    const retired = removal._tag === "retired" ? removal.path : "";
    expect(dirname(retired)).toBe(configDir);
    expect(isRetiredRunnersName(basename(retired))).toBe(true);
    expect(calls.rename).toEqual([[runnersDir, retired]]);
    // The live name is free at once, so a reinstall never meets the old runner.
    expect(existing.has(runnersDir)).toBe(false);
    // Everything but the running image is deleted right away.
    expect(calls.rm).toEqual([runnersDir, retired]);
    expect(calls.writeFile).toEqual([[`${retired}.vbs`, renderRunnerCleanupScript()]]);
    expect(calls.startCleanup).toEqual([`${retired}.vbs`]);
  });

  it("reports a retired dir that empties on the second delete as removed", async () => {
    const { calls, fs } = fakeFs({});
    // The first delete fails (say, a sync was still exiting), the retry clears it.
    let first = true;
    const flaky: RunnerRemovalFs = {
      ...fs,
      rm: async (path) => {
        if (first) {
          first = false;
          throw busy(path);
        }
        return fs.rm(path);
      },
    };

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", flaky));

    expect(removal).toEqual({ _tag: "removed" });
    expect(calls.rename).toHaveLength(1);
    expect(calls.startCleanup).toEqual([]);
  });

  it("still retires the dir when the cleanup script cannot be written", async () => {
    const { calls, fs } = fakeFs({ running: [runnersDir], writeFails: true });

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", fs));

    expect(removal._tag).toBe("retired");
    expect(calls.startCleanup).toEqual([]);
  });

  it("retries a rename that antivirus or a just-exited child holds up for a moment", async () => {
    const { calls, existing, fs } = fakeFs({ renameFails: 2, running: [runnersDir] });

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", fs));

    expect(removal._tag).toBe("retired");
    const retired = removal._tag === "retired" ? removal.path : "";
    // Each attempt tries the delete first, in case whatever blocked it is gone too.
    expect(calls.rename).toEqual([
      [runnersDir, retired],
      [runnersDir, retired],
      [runnersDir, retired],
    ]);
    expect(calls.rm).toEqual([runnersDir, runnersDir, runnersDir, retired]);
    expect(calls.sleep).toEqual([100, 250]);
    expect(existing.has(runnersDir)).toBe(false);
    expect(calls.startCleanup).toEqual([`${retired}.vbs`]);
  });

  it("deletes the dir on a retry once the handle that blocked it is gone", async () => {
    // Nothing runs from the dir; a scanner holds a file in it for the first attempt.
    const { calls, existing, fs } = fakeFs({ renameFails: 1 });
    let scanning = true;
    const scanned: RunnerRemovalFs = {
      ...fs,
      rm: async (path) => {
        if (scanning) {
          scanning = false;
          calls.rm.push(path);
          throw busy(path);
        }
        return fs.rm(path);
      },
    };

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", scanned));

    expect(removal).toEqual({ _tag: "removed" });
    expect(calls.rm).toEqual([runnersDir, runnersDir]);
    expect(calls.rename).toHaveLength(1);
    expect(calls.sleep).toEqual([100]);
    expect(existing.has(runnersDir)).toBe(false);
    expect(calls.startCleanup).toEqual([]);
  });

  it("leaves the dir in place, without failing, when it can be neither deleted nor renamed", async () => {
    const { calls, existing, fs } = fakeFs({ renameFails: true, running: [runnersDir] });

    const removal = await Effect.runPromise(removeServiceRunnersDir(runnersDir, "win32", fs));

    expect(removal._tag).toBe("left");
    expect(removal._tag === "left" ? removal.path : "").toBe(runnersDir);
    expect(JSON.stringify(removal._tag === "left" ? removal.cause : null)).toContain("EBUSY");
    // Five attempts over about 2 s.
    expect(calls.rename).toHaveLength(5);
    expect(calls.sleep).toEqual([100, 250, 500, 1000]);
    expect(existing.has(runnersDir)).toBe(true);
    expect(calls.startCleanup).toEqual([]);
  });

  it("never renames outside Windows, where a running binary does not block the delete", async () => {
    const { calls, fs } = fakeFs({ running: [runnersDir] });

    const exit = await Effect.runPromiseExit(removeServiceRunnersDir(runnersDir, "linux", fs));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.rename).toEqual([]);
  });
});

describe("removeRetiredServiceRunners", () => {
  it("deletes retired dirs and their scripts, keeping one whose runner still runs", async () => {
    const gone = join(configDir, "service-runners.retired-0a1b2c3d");
    const stillRunning = join(configDir, "service-runners.retired-99887766");
    const orphanScript = join(configDir, "service-runners.retired-feedface.vbs");
    const { calls, fs } = fakeFs({
      entries: [
        { kind: "dir", name: "service-runners" },
        { kind: "dir", name: "service-runners.retired-0a1b2c3d" },
        { kind: "file", name: "service-runners.retired-0a1b2c3d.vbs" },
        { kind: "dir", name: "service-runners.retired-99887766" },
        { kind: "file", name: "service-runners.retired-99887766.vbs" },
        { kind: "file", name: "service-runners.retired-feedface.vbs" },
        { kind: "dir", name: "service-runners.retired-not-ours" },
        { kind: "file", name: "service-sync.vbs" },
      ],
      existing: [
        runnersDir,
        gone,
        `${gone}.vbs`,
        stillRunning,
        `${stillRunning}.vbs`,
        orphanScript,
      ],
      running: [stillRunning],
    });

    await Effect.runPromise(removeRetiredServiceRunners(runnersDir, "win32", fs));

    expect(calls.rm).toEqual([gone, stillRunning, `${gone}.vbs`, orphanScript]);
  });

  it("does nothing outside Windows", async () => {
    const { calls, fs } = fakeFs({
      entries: [{ kind: "dir", name: "service-runners.retired-0a1b2c3d" }],
    });

    await Effect.runPromise(removeRetiredServiceRunners(runnersDir, "linux", fs));

    expect(calls.rm).toEqual([]);
  });

  it("sweeps a real config dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-retired-runners-"));
    try {
      const live = join(dir, "service-runners");
      const retired = retiredRunnersPath(live);
      await mkdir(join(live, "0.7.0", "darwin-arm64"), { recursive: true });
      await mkdir(join(retired, "0.7.0", "darwin-arm64"), { recursive: true });
      await writeFile(join(retired, "0.7.0", "darwin-arm64", "tokenmaxxing"), "runner");
      await writeFile(`${retired}.vbs`, renderRunnerCleanupScript());

      await Effect.runPromise(removeRetiredServiceRunners(live, "win32"));

      expect(await readdir(dir)).toEqual(["service-runners"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("renderRunnerCleanupScript", () => {
  it("is plain ASCII with CRLF line endings, and finds its dir from its own name", () => {
    const script = renderRunnerCleanupScript();

    expect(/^[\x20-\x7e\r\n]*$/.test(script)).toBe(true);
    expect(script.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
    expect(script).toContain("Left(WScript.ScriptFullName, Len(WScript.ScriptFullName) - 4)");
    expect(script).toContain("fso.DeleteFolder target, True");
  });
});
