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
