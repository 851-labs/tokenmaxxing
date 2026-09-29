import type { Dirent } from "node:fs";

import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  isNpmStagingDirName,
  npmScopeDirsForPaths,
  type NpmStagingFs,
  removeNpmStagingDirs,
} from "./npm-staging";

const prefix = "C:\\Users\\Zoë O'Neil\\AppData\\Roaming\\npm";
const scope = `${prefix}\\node_modules\\@851-labs`;
const liveExe = `${scope}\\tokenmaxxing\\bin\\tokenmaxxing.exe`;

type Entry = { kind: "dir" | "file" | "link"; name: string };

// A Windows filesystem: directory listings, the files that exist, the
// staging dirs with a running exe, and the ones whose delete fails.
function fakeFs(options: {
  dirs: Record<string, Entry[]>;
  files?: string[];
  readdirFails?: boolean;
  rmFails?: string[];
  running?: string[];
}) {
  const calls = { exists: [] as string[], readdir: [] as string[], rm: [] as string[] };
  const fs: NpmStagingFs = {
    exists: async (path) => {
      calls.exists.push(path);
      return options.files?.includes(path) ?? false;
    },
    hasRunningExe: async (dir) => options.running?.includes(dir) ?? false,
    readdir: async (path) => {
      calls.readdir.push(path);
      const entries = options.dirs[path];
      if (options.readdirFails || entries === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return entries.map(
        (entry) =>
          ({
            isDirectory: () => entry.kind === "dir",
            name: entry.name,
          }) as Dirent,
      );
    },
    rm: async (path) => {
      calls.rm.push(path);
      if (options.rmFails?.includes(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${path}'`), {
          code: "EPERM",
        });
      }
    },
  };
  return { calls, fs };
}

describe("isNpmStagingDirName", () => {
  it("matches npm's retire name for the package dir", () => {
    // Seen on Windows 11 after `tokenmaxxing upgrade`.
    expect(isNpmStagingDirName(".tokenmaxxing-9vyC6HBb")).toBe(true);
    expect(isNpmStagingDirName(".tokenmaxxing-FkQlRMWz")).toBe(true);
    expect(isNpmStagingDirName(".tokenmaxxing-00000000")).toBe(true);
  });

  it("never matches the live package dirs or anything else", () => {
    for (const name of [
      "tokenmaxxing",
      "tokenmaxxing-windows-arm64",
      "tokenmaxxing-9vyC6HBb",
      ".tokenmaxxing",
      ".tokenmaxxing-",
      ".tokenmaxxing-9vyC6HB",
      ".tokenmaxxing-9vyC6HBbX",
      ".tokenmaxxing-9vyC+HBb",
      ".tokenmaxxing-windows-arm64",
      ".tokenmaxxing-windows-arm64-9vyC6HBb",
      ".Tokenmaxxing-9vyC6HBb",
      ".tokenmaxxing-9vyC6HBb\\bin",
      ".other-9vyC6HBb",
      ".bin",
    ]) {
      expect(isNpmStagingDirName(name), name).toBe(false);
    }
  });
});

describe("npmScopeDirsForPaths", () => {
  it("finds the scope dir from npm's shim in the prefix and from the running exe", () => {
    expect(npmScopeDirsForPaths([`${prefix}\\tokenmaxxing.cmd`])).toEqual([scope]);
    expect(npmScopeDirsForPaths([liveExe])).toEqual([scope]);
    expect(
      npmScopeDirsForPaths([
        `${scope}\\tokenmaxxing\\node_modules\\@851-labs\\tokenmaxxing-windows-arm64\\bin\\tokenmaxxing.exe`,
      ]),
    ).toEqual([scope]);
    expect(
      npmScopeDirsForPaths(["C:/tmx/npm/node_modules/@851-labs/tokenmaxxing/bin/x.exe"]),
    ).toEqual(["C:\\tmx\\npm\\node_modules\\@851-labs"]);
  });

  it("lists each scope dir once, whatever the casing", () => {
    expect(
      npmScopeDirsForPaths([
        `${prefix}\\tokenmaxxing.ps1`,
        liveExe,
        liveExe.toUpperCase(),
        `${prefix}\\TOKENMAXXING.CMD`,
      ]),
    ).toEqual([scope]);
  });

  it("does not take a sibling package for the CLI's own dir", () => {
    expect(
      npmScopeDirsForPaths([`${scope}\\tokenmaxxing-windows-arm64\\bin\\tokenmaxxing.exe`]),
    ).toEqual([`${scope}\\tokenmaxxing-windows-arm64\\bin\\node_modules\\@851-labs`]);
  });

  it("skips missing and relative paths", () => {
    expect(npmScopeDirsForPaths([undefined, null, "", "tokenmaxxing.cmd", "bin\\x.exe"])).toEqual(
      [],
    );
  });
});

describe("removeNpmStagingDirs", () => {
  const live = [`${scope}\\tokenmaxxing\\package.json`];

  it("removes only npm's staging dirs next to the live package", async () => {
    const { calls, fs } = fakeFs({
      dirs: {
        [scope]: [
          { kind: "dir", name: ".tokenmaxxing-9vyC6HBb" },
          { kind: "dir", name: "tokenmaxxing" },
          { kind: "dir", name: "tokenmaxxing-windows-arm64" },
          { kind: "dir", name: ".tokenmaxxing-windows-arm64" },
          { kind: "file", name: ".tokenmaxxing-AbCdEf12" },
          // A junction or symlink is never followed or removed.
          { kind: "link", name: ".tokenmaxxing-Zz9Yy8Xx" },
          { kind: "dir", name: ".tokenmaxxing-pth6Tsaq" },
        ],
      },
      files: live,
    });

    const cleanup = await Effect.runPromise(
      removeNpmStagingDirs([`${prefix}\\tokenmaxxing.cmd`, liveExe], "win32", fs),
    );

    expect(cleanup).toEqual({
      failed: [],
      inUse: [],
      removed: [`${scope}\\.tokenmaxxing-9vyC6HBb`, `${scope}\\.tokenmaxxing-pth6Tsaq`],
    });
    expect(calls.rm).toEqual(cleanup.removed);
    expect(calls.readdir).toEqual([scope]);
  });

  it("leaves a staging dir whose exe is still running whole, for a later run", async () => {
    // The upgrade that just ran from it, or one whose npm is still installing
    // (npm moves it back if the install fails).
    const running = `${scope}\\.tokenmaxxing-9vyC6HBb`;
    const { calls, fs } = fakeFs({
      dirs: {
        [scope]: [
          { kind: "dir", name: ".tokenmaxxing-9vyC6HBb" },
          { kind: "dir", name: ".tokenmaxxing-pth6Tsaq" },
        ],
      },
      files: live,
      running: [running],
    });

    const cleanup = await Effect.runPromise(removeNpmStagingDirs([liveExe], "win32", fs));

    expect(cleanup).toEqual({
      failed: [],
      inUse: [running],
      removed: [`${scope}\\.tokenmaxxing-pth6Tsaq`],
    });
    expect(calls.rm).toEqual([`${scope}\\.tokenmaxxing-pth6Tsaq`]);
  });

  it("reports a staging dir it could not delete and carries on", async () => {
    const stuck = `${scope}\\.tokenmaxxing-9vyC6HBb`;
    const { fs } = fakeFs({
      dirs: {
        [scope]: [
          { kind: "dir", name: ".tokenmaxxing-9vyC6HBb" },
          { kind: "dir", name: ".tokenmaxxing-pth6Tsaq" },
        ],
      },
      files: live,
      rmFails: [stuck],
    });

    const cleanup = await Effect.runPromise(removeNpmStagingDirs([liveExe], "win32", fs));

    expect(cleanup).toEqual({
      failed: [stuck],
      inUse: [],
      removed: [`${scope}\\.tokenmaxxing-pth6Tsaq`],
    });
  });

  it("never touches a dir that holds no npm install of the CLI", async () => {
    const bunBin = "C:\\Users\\tmx\\.bun\\bin";
    const runner = "C:\\Users\\tmx\\.config\\tokenmaxxing\\service-runners\\0.7.0";
    const { calls, fs } = fakeFs({
      dirs: {
        [`${bunBin}\\node_modules\\@851-labs`]: [{ kind: "dir", name: ".tokenmaxxing-9vyC6HBb" }],
        [`${runner}\\node_modules\\@851-labs`]: [{ kind: "dir", name: ".tokenmaxxing-9vyC6HBb" }],
      },
    });

    const cleanup = await Effect.runPromise(
      removeNpmStagingDirs(
        [`${bunBin}\\tokenmaxxing.exe`, `${runner}\\tokenmaxxing.exe`],
        "win32",
        fs,
      ),
    );

    expect(cleanup).toEqual({ failed: [], inUse: [], removed: [] });
    expect(calls.readdir).toEqual([]);
    expect(calls.rm).toEqual([]);
  });

  it("does nothing outside Windows", async () => {
    const { calls, fs } = fakeFs({
      dirs: { [scope]: [{ kind: "dir", name: ".tokenmaxxing-9vyC6HBb" }] },
      files: live,
    });

    for (const platform of ["darwin", "linux"] as const) {
      const cleanup = await Effect.runPromise(removeNpmStagingDirs([liveExe], platform, fs));
      expect(cleanup).toEqual({ failed: [], inUse: [], removed: [] });
    }
    expect(calls).toEqual({ exists: [], readdir: [], rm: [] });
  });

  it("never fails", async () => {
    const unreadable = fakeFs({ dirs: {}, files: live, readdirFails: true });
    expect(
      await Effect.runPromise(removeNpmStagingDirs([liveExe], "win32", unreadable.fs)),
    ).toEqual({ failed: [], inUse: [], removed: [] });

    const throwing: NpmStagingFs = {
      exists: async () => {
        throw new Error("boom");
      },
      hasRunningExe: async () => false,
      readdir: async () => [],
      rm: async () => {},
    };
    expect(await Effect.runPromise(removeNpmStagingDirs([liveExe], "win32", throwing))).toEqual({
      failed: [],
      inUse: [],
      removed: [],
    });
  });
});
