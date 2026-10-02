import { describe, expect, it } from "vite-plus/test";

import { defaultServicePath, stableServicePath } from "./service-path";

const home = "/Users/alex";
const fnmDir = `${home}/.local/share/fnm`;
const multishells = `${home}/.local/state/fnm_multishells`;

// Symlinks and directories of a machine with fnm installed and a default alias.
function fakeFs(options: { defaultAlias?: boolean; links?: Record<string, string> } = {}) {
  const links: Record<string, string> = {
    [`${multishells}/56795_1790622150209`]: `${fnmDir}/aliases/default`,
    [`${multishells}/76391_1790569014147`]: `${fnmDir}/aliases/default`,
    [`${multishells}/80000_1790600000000`]: `${fnmDir}/node-versions/v20.19.0/installation`,
    ...options.links,
  };
  const dirs = new Set([
    ...(options.defaultAlias === false ? [] : [`${fnmDir}/aliases/default`]),
    `${home}/.volta/bin`,
    `${home}/.asdf/shims`,
  ]);

  return {
    exists: (path: string) => dirs.has(path),
    readLink: (path: string) => {
      const target = links[path];
      if (target === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return target;
    },
  };
}

function darwinPath(entries: string[], env: Record<string, string> = {}, fs = fakeFs()) {
  return stableServicePath(entries.join(":"), {
    env: { TMPDIR: "/var/folders/xy/abc123/T/", ...env },
    platform: "darwin",
    ...fs,
  });
}

describe("stableServicePath", () => {
  it("gives the same PATH from a terminal and from an agent session on one Mac", () => {
    const shared = [
      "/opt/homebrew/opt/openjdk@21/bin",
      `${home}/.rbenv/shims`,
      `${home}/.local/bin`,
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/opt/homebrew/bin",
      `${home}/.bun/bin`,
      `${home}/Library/Android/sdk/emulator/`,
      `${home}/Library/pnpm`,
    ];
    const terminal = darwinPath([
      `${multishells}/56795_1790622150209/bin`,
      ...shared,
      "/Applications/Ghostty.app/Contents/MacOS",
    ]);
    const agentSession = darwinPath([
      `${multishells}/76391_1790569014147/bin`,
      ...shared,
      `${home}/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/81864b89/b02eb026/bin`,
    ]);

    expect(agentSession).toBe(terminal);
    expect(terminal.split(":")).toEqual([
      `${fnmDir}/aliases/default/bin`,
      ...shared.slice(0, -2),
      `${home}/Library/Android/sdk/emulator`,
      `${home}/Library/pnpm`,
    ]);
  });

  it("is stable when a deferred repair recaptures the PATH the wrapper exported", () => {
    const captured = darwinPath([
      `${multishells}/80000_1790600000000/bin`,
      `${home}/.volta/tools/image/node/22.21.0/bin`,
      "/tmp/x",
      "/usr/bin",
    ]);

    expect(darwinPath(captured.split(":"))).toBe(captured);
  });

  it("resolves an fnm per-shell directory to the default alias, or to its version without one", () => {
    expect(darwinPath([`${multishells}/80000_1790600000000/bin`, "/usr/bin"])).toBe(
      `${fnmDir}/aliases/default/bin:/usr/bin`,
    );
    expect(
      darwinPath(
        [`${multishells}/80000_1790600000000/bin`, "/usr/bin"],
        {},
        fakeFs({ defaultAlias: false }),
      ),
    ).toBe(`${fnmDir}/node-versions/v20.19.0/installation/bin:/usr/bin`);
  });

  it("resolves relative fnm links and drops per-shell directories that are gone", () => {
    const fs = fakeFs({
      links: { [`${multishells}/1_2`]: "../../share/fnm/node-versions/v22.0.0/installation" },
    });

    expect(darwinPath([`${multishells}/1_2/bin`, "/usr/bin"], {}, fs)).toBe(
      `${fnmDir}/aliases/default/bin:/usr/bin`,
    );
    expect(darwinPath([`${multishells}/999_1/bin`, "/usr/bin"])).toBe("/usr/bin");
  });

  // L4: alpha.0/.1 wrappers baked in /run/user/<uid>/fnm_multishells/<id>,
  // which a reboot removes. The deferred repair re-captures PATH from that
  // wrapper's environment, so the dead entry must still map to fnm's node.
  it("maps an fnm per-shell directory that is gone to fnm's default alias", () => {
    const linux = (env: Record<string, string>, aliases: string[]) =>
      stableServicePath("/run/user/1000/fnm_multishells/42_1/bin:/usr/bin", {
        env,
        exists: (dir) => aliases.includes(dir),
        platform: "linux",
        readLink: (dir) => {
          throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
        },
      });

    expect(linux({ HOME: "/home/alex" }, ["/home/alex/.local/share/fnm/aliases/default"])).toBe(
      "/home/alex/.local/share/fnm/aliases/default/bin:/usr/bin",
    );
    expect(
      linux({ FNM_DIR: "/opt/fnm", HOME: "/home/alex" }, [
        "/opt/fnm/aliases/default",
        "/home/alex/.local/share/fnm/aliases/default",
      ]),
    ).toBe("/opt/fnm/aliases/default/bin:/usr/bin");
    expect(linux({ HOME: "/home/alex" }, ["/home/alex/.fnm/aliases/default"])).toBe(
      "/home/alex/.fnm/aliases/default/bin:/usr/bin",
    );
    expect(linux({ HOME: "/home/alex" }, [])).toBe("/usr/bin");
  });

  // fnm on Windows keeps its data in %APPDATA%\fnm and links each shell's node through a
  // junction under %LOCALAPPDATA%\fnm_multishells. A wrapper never exports FNM_DIR, so when a
  // repair finds that junction gone only the default dir leads back to fnm's node.
  it("maps a Windows fnm per-shell junction to %APPDATA%\\fnm's default alias", () => {
    const appData = "C:\\Users\\alex\\AppData\\Roaming";
    const multishell = "C:\\Users\\alex\\AppData\\Local\\fnm_multishells\\1304_1790891596390";
    const alias = `${appData}\\fnm\\aliases\\default`;
    const windows = (readLink: (dir: string) => string) =>
      stableServicePath(`${multishell};C:\\WINDOWS\\system32`, {
        env: { APPDATA: appData, USERPROFILE: "C:\\Users\\alex" },
        exists: (dir) => dir === alias,
        platform: "win32",
        readLink,
      });

    expect(
      windows(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    ).toBe(`${alias};C:\\WINDOWS\\system32`);
    expect(windows(() => `${appData}\\fnm\\node-versions\\v22.23.3\\installation`)).toBe(
      `${alias};C:\\WINDOWS\\system32`,
    );
  });

  it("resolves Linux fnm per-shell directories under XDG_RUNTIME_DIR", () => {
    const path = stableServicePath("/run/user/1000/fnm_multishells/42_1/bin:/usr/bin", {
      env: {},
      exists: (dir) => dir === "/home/alex/.local/share/fnm/aliases/default",
      platform: "linux",
      readLink: (dir) => {
        if (dir !== "/run/user/1000/fnm_multishells/42_1") {
          throw new Error(`ENOENT: ${dir}`);
        }
        return "/home/alex/.local/share/fnm/aliases/default";
      },
    });

    expect(path).toBe("/home/alex/.local/share/fnm/aliases/default/bin:/usr/bin");
  });

  it("drops temporary, session, project and app-bundle directories", () => {
    expect(
      darwinPath([
        "/var/folders/xy/abc123/T/bun-node-1a2b3c",
        "/private/var/folders/xy/abc123/T/tool/bin",
        "/tmp/fake/bin",
        "/private/tmp/bin",
        `${home}/code/app/node_modules/.bin`,
        `${home}/code/node_modules/.bin`,
        "/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
        `${home}/Library/Application Support/Codevisor/sessions/abc/bin`,
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
        "/usr/bin",
      ]),
    ).toBe("/usr/bin");
  });

  it("keeps durable tool directories, including ones under Application Support", () => {
    const entries = [
      `${home}/Library/Application Support/fnm/aliases/default/bin`,
      `${home}/Library/Application Support/JetBrains/Toolbox/scripts`,
      `${home}/.nvm/versions/node/v22.21.0/bin`,
      "/tmpfs-tools/bin",
      "/usr/bin",
    ];

    expect(darwinPath(entries)).toBe(entries.join(":"));
  });

  it("swaps version-manager install directories for their shims when the shims exist", () => {
    expect(
      darwinPath([
        `${home}/.volta/tools/image/node/22.21.0/bin`,
        `${home}/.asdf/installs/nodejs/22.21.0/bin`,
        `${home}/.local/share/mise/installs/node/22/bin`,
        `${home}/.volta/bin`,
        "/usr/bin",
      ]),
    ).toBe(
      [
        `${home}/.volta/bin`,
        `${home}/.asdf/shims`,
        // No mise shims directory: the install directory is all there is.
        `${home}/.local/share/mise/installs/node/22/bin`,
        "/usr/bin",
      ].join(":"),
    );
  });

  describe("Node version managers", () => {
    // A machine with asdf, mise and nodenv, each with two Node versions (and
    // mise's version aliases), plus rbenv, whose shims must stay as they are.
    const asdf = `${home}/.asdf`;
    const mise = `${home}/.local/share/mise`;
    const nodenv = `${home}/.nodenv`;
    const versionDirs: Record<string, string[]> = {
      [`${asdf}/installs/nodejs`]: ["22.21.0", "24.11.0"],
      [`${asdf}/installs/python`]: ["3.13.1"],
      [`${mise}/installs/node`]: ["22", "22.21.0", "24", "24.11", "24.11.0", "latest", "lts"],
      [`${nodenv}/versions`]: ["22.21.0", "24.11.0"],
      [`${home}/.rbenv/versions`]: ["3.3.0"],
    };
    const files = new Set([
      ...Object.entries(versionDirs).flatMap(([dir, names]) =>
        names.flatMap((name) => (dir.includes("rbenv") ? [] : [`${dir}/${name}/bin/node`])),
      ),
      `${asdf}/shims`,
      `${mise}/shims`,
      `${nodenv}/shims`,
      `${home}/.rbenv/shims`,
    ]);
    const managerPath = (entries: string[], fs: { exists?: (path: string) => boolean } = {}) =>
      stableServicePath(entries.join(":"), {
        env: { HOME: home },
        exists: fs.exists ?? ((path) => files.has(path)),
        platform: "linux",
        readDir: (dir) => versionDirs[dir] ?? [],
        readLink: () => {
          throw new Error("no links");
        },
      });

    // The 0.7.0 migration rewrote a 0.6.0 wrapper's `installs/nodejs/<v>/bin`
    // (prepended by `asdf exec` when the CLI ran through asdf's npx) to
    // ~/.asdf/shims. A launchd job runs in /, where a node set only in a
    // project's .tool-versions does not apply: "No version is set for command node".
    it("puts asdf's newest Node ahead of its shims, from `asdf exec` or a plain shell", () => {
      const fromAsdfExec = managerPath([
        `${asdf}/plugins/nodejs/shims`,
        `${asdf}/installs/nodejs/22.21.0/bin`,
        `${home}/bin`,
        `${asdf}/shims`,
        "/usr/bin",
      ]);
      const fromShell = managerPath([`${home}/bin`, `${asdf}/shims`, "/usr/bin"]);

      expect(fromAsdfExec).toBe(
        [`${home}/bin`, `${asdf}/installs/nodejs/24.11.0/bin`, `${asdf}/shims`, "/usr/bin"].join(
          ":",
        ),
      );
      expect(fromShell).toBe(fromAsdfExec);
      // A 0.7.5 wrapper, and whatever a later repair recaptures from the new one.
      expect(managerPath(fromAsdfExec.split(":"))).toBe(fromAsdfExec);
    });

    it("does the same for mise in activate mode, shims mode, and with version aliases", () => {
      const expected = [`${mise}/installs/node/24.11.0/bin`, `${mise}/shims`, "/usr/bin"].join(":");

      expect(
        managerPath([
          `${mise}/installs/node/24/bin`,
          `${mise}/installs/python/3.13/bin`,
          "/usr/bin",
        ]),
      ).toBe(expected);
      expect(managerPath([`${mise}/shims`, "/usr/bin"])).toBe(expected);
      expect(managerPath([`${mise}/installs/node/22.21.0/bin`, `${mise}/shims`, "/usr/bin"])).toBe(
        expected,
      );
    });

    it("does the same for nodenv, dropping what `nodenv exec` adds", () => {
      const expected = [
        `${nodenv}/versions/24.11.0/bin`,
        `${nodenv}/shims`,
        `${nodenv}/bin`,
        "/usr/bin",
      ].join(":");

      expect(
        managerPath([
          `${nodenv}/versions/22.21.0/bin`,
          `${nodenv}/libexec`,
          `${nodenv}/plugins/node-build/bin`,
          `${nodenv}/shims`,
          `${nodenv}/bin`,
          "/usr/bin",
        ]),
      ).toBe(expected);
      expect(managerPath([`${nodenv}/shims`, `${nodenv}/bin`, "/usr/bin"])).toBe(expected);
    });

    it("skips versions without a node binary and keeps shims without any Node", () => {
      const without = (missing: string) => (path: string) => files.has(path) && path !== missing;

      expect(
        managerPath([`${asdf}/shims`, "/usr/bin"], {
          exists: without(`${asdf}/installs/nodejs/24.11.0/bin/node`),
        }),
      ).toBe(`${asdf}/installs/nodejs/22.21.0/bin:${asdf}/shims:/usr/bin`);
      expect(
        managerPath([`${home}/.rbenv/shims`, `${home}/.rbenv/versions/3.3.0/bin`, "/usr/libexec"]),
      ).toBe(`${home}/.rbenv/shims:${home}/.rbenv/versions/3.3.0/bin:/usr/libexec`);
    });

    it("leaves Volta, nvm and fnm directories as they were", () => {
      expect(
        managerPath([
          `${home}/.nvm/versions/node/v22.21.0/bin`,
          `${home}/.local/share/fnm/node-versions/v22.21.0/installation/bin`,
          "/usr/bin",
        ]),
      ).toBe(
        [
          `${home}/.nvm/versions/node/v22.21.0/bin`,
          `${home}/.local/share/fnm/node-versions/v22.21.0/installation/bin`,
          "/usr/bin",
        ].join(":"),
      );
    });

    it("finds mise's node.exe in a Windows version directory", () => {
      const localAppData = "C:\\Users\\alex\\AppData\\Local";
      const installs = `${localAppData}\\mise\\installs\\node`;
      const path = stableServicePath([`${installs}\\22.21.0`, "C:\\Windows\\System32"].join(";"), {
        env: { LOCALAPPDATA: localAppData },
        exists: (dir) =>
          dir === `${installs}\\24.11.0\\node.exe` || dir === `${localAppData}\\mise\\shims`,
        platform: "win32",
        readDir: (dir) => (dir === installs ? ["22.21.0", "24.11.0"] : []),
        readLink: () => {
          throw new Error("no links");
        },
      });

      expect(path).toBe(
        [`${installs}\\24.11.0`, `${localAppData}\\mise\\shims`, "C:\\Windows\\System32"].join(";"),
      );
    });
  });

  it("drops relative and empty entries and repeats, keeping the first position", () => {
    expect(darwinPath(["", ".", "bin", "/usr/local/bin", "/usr/bin", "/usr/local/bin/"])).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });

  it("falls back to the default PATH when nothing durable is left", () => {
    expect(darwinPath(["/tmp/a", "relative"])).toBe(defaultServicePath("darwin"));
  });

  it("handles Windows separators, TEMP and case-insensitive repeats", () => {
    const localAppData = "C:\\Users\\Alex\\AppData\\Local";
    const path = stableServicePath(
      [
        `${localAppData}\\fnm_multishells\\1234_5678`,
        `${localAppData}\\Temp\\bun-node-abc`,
        "C:\\Windows\\System32",
        "c:\\windows\\system32\\",
        "C:\\Program Files\\nodejs\\",
        "C:\\code\\app\\node_modules\\.bin",
      ].join(";"),
      {
        env: { TEMP: `${localAppData}\\Temp` },
        exists: (dir) => dir === `${localAppData}\\fnm\\aliases\\default`,
        platform: "win32",
        readLink: () => `${localAppData}\\fnm\\node-versions\\v22.21.0\\installation`,
      },
    );

    expect(path).toBe(
      [
        `${localAppData}\\fnm\\aliases\\default`,
        "C:\\Windows\\System32",
        "C:\\Program Files\\nodejs",
      ].join(";"),
    );
  });
});
