import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { type HermesDiscoveryFs, ccusageSourceEnv, discoverHermesHomes } from "./source-env";

/** In-memory Windows filesystem: `files` and `dirs` are canonical paths. */
function fakeWindowsFs(options: {
  blocked?: readonly string[];
  dirs: Record<string, readonly string[]>;
  files: readonly string[];
  realpath?: (path: string) => string;
}): HermesDiscoveryFs {
  const lower = (path: string) => path.toLowerCase();
  const exists = (path: string) =>
    options.files.some((file) => lower(file) === lower(path)) ||
    Object.keys(options.dirs).some((dir) => lower(dir) === lower(path));

  return {
    access: async (path) => {
      if (options.blocked?.some((blocked) => lower(blocked) === lower(path))) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
    },
    readdir: async (path) => {
      const entry = Object.entries(options.dirs).find(([dir]) => lower(dir) === lower(path));
      if (entry === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return [...entry[1]];
    },
    realpath: async (path) => {
      if (!exists(path)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return options.realpath?.(path) ?? path;
    },
    stat: async (path) => ({
      isFile: () => options.files.some((file) => lower(file) === lower(path)),
    }),
  };
}

describe("discoverHermesHomes (POSIX)", () => {
  let home: string;
  let hermesRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tokenmaxxing-hermes-"));
    hermesRoot = join(home, ".hermes");
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  async function hermesState(...segments: string[]) {
    const dir = join(hermesRoot, ...segments);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.db"), "state");
    return dir;
  }

  it("lists the default root then profiles in code-unit order", async () => {
    await hermesState();
    await hermesState("profiles", "zeta");
    await hermesState("profiles", "Beta");
    await hermesState("profiles", "alpha");
    const root = await realpath(hermesRoot);

    await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBe(
      ["", "Beta", "alpha", "zeta"]
        .map((profile) => (profile === "" ? root : join(root, "profiles", profile)))
        .join(","),
    );
  });

  it("includes profiles even when the default root has no state", async () => {
    await hermesState("profiles", "work");
    const root = await realpath(hermesRoot);

    await expect(discoverHermesHomes({ HOME: home }, "darwin")).resolves.toBe(
      join(root, "profiles", "work"),
    );
  });

  it("leaves the environment alone when only the default root has state", async () => {
    await hermesState();
    await mkdir(join(hermesRoot, "profiles", "empty"), { recursive: true });

    await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBeUndefined();
  });

  it("leaves the environment alone when Hermes is not installed", async () => {
    await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBeUndefined();
    await expect(discoverHermesHomes({}, "linux")).resolves.toBeUndefined();
  });

  it("keeps an explicit HERMES_HOME and discovers when it is empty", async () => {
    await hermesState();
    await hermesState("profiles", "work");

    await expect(
      discoverHermesHomes({ HERMES_HOME: "/custom/one,/custom/two", HOME: home }, "linux"),
    ).resolves.toBeUndefined();
    await expect(discoverHermesHomes({ HERMES_HOME: "", HOME: home }, "linux")).resolves.toContain(
      ",",
    );
  });

  it("dedupes profile aliases and ignores symlinks that escape the Hermes root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "tokenmaxxing-hermes-outside-"));
    try {
      const real = await hermesState("profiles", "real");
      await writeFile(join(outside, "state.db"), "outside");
      await symlink(real, join(hermesRoot, "profiles", "alias"));
      await symlink(outside, join(hermesRoot, "profiles", "escape"));
      await mkdir(join(hermesRoot, "profiles", "linked-state"));
      await symlink(
        join(outside, "state.db"),
        join(hermesRoot, "profiles", "linked-state", "state.db"),
      );

      await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBe(
        await realpath(real),
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("follows a symlinked Hermes root to its canonical location", async () => {
    const target = await mkdtemp(join(tmpdir(), "tokenmaxxing-hermes-target-"));
    try {
      await mkdir(join(target, "profiles", "work"), { recursive: true });
      await writeFile(join(target, "state.db"), "default");
      await writeFile(join(target, "profiles", "work", "state.db"), "work");
      await symlink(target, hermesRoot);
      const canonical = await realpath(target);

      await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBe(
        `${canonical},${join(canonical, "profiles", "work")}`,
      );
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  });

  it("skips profiles whose paths ccusage cannot split back out", async () => {
    await hermesState("profiles", "a,comma");
    await hermesState("profiles", "trailing ");
    await hermesState("profiles", "with space");
    await hermesState("profiles", "work");
    const root = await realpath(hermesRoot);

    await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBe(
      `${join(root, "profiles", "with space")},${join(root, "profiles", "work")}`,
    );
  });

  it("skips non-file state entries and plain files in the profiles directory", async () => {
    await hermesState("profiles", "work");
    await mkdir(join(hermesRoot, "profiles", "dir-state", "state.db"), { recursive: true });
    await writeFile(join(hermesRoot, "profiles", "notes.txt"), "not a profile");
    const root = await realpath(hermesRoot);

    await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBe(
      join(root, "profiles", "work"),
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips unreadable profile state",
    async () => {
      await hermesState("profiles", "work");
      const blocked = await hermesState("profiles", "blocked");
      await chmod(join(blocked, "state.db"), 0o000);
      const root = await realpath(hermesRoot);

      await expect(discoverHermesHomes({ HOME: home }, "linux")).resolves.toBe(
        join(root, "profiles", "work"),
      );
    },
  );
});

describe("discoverHermesHomes (Windows)", () => {
  const home = "C:\\Users\\alex";

  it("uses USERPROFILE and backslash paths", async () => {
    const fs = fakeWindowsFs({
      dirs: {
        "C:\\Users\\alex\\.hermes": ["profiles", "state.db"],
        "C:\\Users\\alex\\.hermes\\profiles": ["work"],
        "C:\\Users\\alex\\.hermes\\profiles\\work": ["state.db"],
      },
      files: [
        "C:\\Users\\alex\\.hermes\\state.db",
        "C:\\Users\\alex\\.hermes\\profiles\\work\\state.db",
      ],
    });

    await expect(
      discoverHermesHomes({ HOME: "/ignored", USERPROFILE: home }, "win32", fs),
    ).resolves.toBe("C:\\Users\\alex\\.hermes,C:\\Users\\alex\\.hermes\\profiles\\work");
  });

  it("compares containment case-insensitively and dedupes case aliases", async () => {
    const fs = fakeWindowsFs({
      dirs: {
        "C:\\Users\\alex\\.hermes": ["profiles"],
        "C:\\Users\\alex\\.hermes\\profiles": ["WORK", "work"],
        "C:\\Users\\alex\\.hermes\\profiles\\work": ["state.db"],
      },
      files: ["C:\\Users\\alex\\.hermes\\profiles\\work\\state.db"],
      realpath: (path) =>
        path.replace("C:\\Users\\alex", "c:\\users\\ALEX").replace("WORK", "work"),
    });

    await expect(discoverHermesHomes({ USERPROFILE: home }, "win32", fs)).resolves.toBe(
      "c:\\users\\ALEX\\.hermes\\profiles\\work",
    );
  });

  it("skips unreadable state and escapes to another drive", async () => {
    const fs = fakeWindowsFs({
      blocked: ["C:\\Users\\alex\\.hermes\\profiles\\blocked\\state.db"],
      dirs: {
        "C:\\Users\\alex\\.hermes": ["profiles"],
        "C:\\Users\\alex\\.hermes\\profiles": ["blocked", "escape", "work"],
        "C:\\Users\\alex\\.hermes\\profiles\\blocked": ["state.db"],
        "C:\\Users\\alex\\.hermes\\profiles\\escape": ["state.db"],
        "C:\\Users\\alex\\.hermes\\profiles\\work": ["state.db"],
      },
      files: [
        "C:\\Users\\alex\\.hermes\\profiles\\blocked\\state.db",
        "C:\\Users\\alex\\.hermes\\profiles\\escape\\state.db",
        "C:\\Users\\alex\\.hermes\\profiles\\work\\state.db",
      ],
      realpath: (path) =>
        path.replace("C:\\Users\\alex\\.hermes\\profiles\\escape", "D:\\elsewhere"),
    });

    await expect(discoverHermesHomes({ USERPROFILE: home }, "win32", fs)).resolves.toBe(
      "C:\\Users\\alex\\.hermes\\profiles\\work",
    );
  });

  it("degrades to the unchanged environment when discovery throws", async () => {
    const fs: HermesDiscoveryFs = {
      access: async () => undefined,
      readdir: async () => {
        throw new Error("boom");
      },
      realpath: async () => {
        throw new Error("boom");
      },
      stat: async () => ({ isFile: () => true }),
    };

    await expect(discoverHermesHomes({ USERPROFILE: home }, "win32", fs)).resolves.toBeUndefined();
  });
});

describe("ccusageSourceEnv", () => {
  const fs = fakeWindowsFs({
    dirs: {
      "C:\\Users\\alex\\.hermes": [],
      "C:\\Users\\alex\\.hermes\\profiles": ["work"],
      "C:\\Users\\alex\\.hermes\\profiles\\work": ["state.db"],
    },
    files: ["C:\\Users\\alex\\.hermes\\profiles\\work\\state.db"],
  });

  it("adds discovered Hermes roots only for the Hermes source", async () => {
    const env = { CODEX_HOME: "D:\\Codex Logs", USERPROFILE: "C:\\Users\\alex" };

    await expect(ccusageSourceEnv("hermes", env, "win32", fs)).resolves.toEqual({
      ...env,
      HERMES_HOME: "C:\\Users\\alex\\.hermes\\profiles\\work",
    });
    await expect(ccusageSourceEnv("codex", env, "win32", fs)).resolves.toBe(env);
  });
});
