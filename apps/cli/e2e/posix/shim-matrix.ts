#!/usr/bin/env bun
/**
 * Global-install shim matrix for macOS and Linux: installs this build from
 * the local registry with each package manager (each into its own isolated
 * global dir), then runs `tokenmaxxing --version` through bash, sh and pwsh,
 * checks that exit codes pass through, and checks what bin/tokenmaxxing is
 * after install. #107's design: npm and trusted Bun installs swap the JS
 * launcher for the verified native binary (their global bins are plain
 * symlinks); every other install keeps the launcher.
 *
 *   bun apps/cli/e2e/posix/shim-matrix.ts --build <build.json> [--tools <bin dir with pnpm/yarn>] [--root <dir>] [--out <dir>] [--force]
 *
 * Extend it by adding a row to `installers` or `shells`. `knownIssues` lists
 * installers whose checks currently fail: they record XFAIL, and XPASS (which
 * fails the job) once they pass, so the entry is removed with the fix.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  assertDisposableMachine,
  blockProduction,
  check,
  failedChecks,
  flag,
  initE2E,
  npmCommand,
  oneLine,
  readBuild,
  requiredFlag,
  run,
  scenario,
  startRegistry,
  unblockProduction,
  type Registry,
} from "../shared/harness";
import { summarize } from "../shared/summarize";

type BinKind = "launcher" | "native";

interface Installer {
  /** What bin/tokenmaxxing should be after install (#107). */
  expectBin: BinKind;
  install: (spec: string) => { args: string[]; command: string; env?: Record<string, string> };
  /** The directory the package manager links global bins into. */
  binDir: () => string;
  env?: () => Record<string, string>;
  packageDir: () => string;
}

const build = readBuild(requiredFlag("build"));
const root = flag("root") ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "tmx-e2e-shims");
const outDir = flag("out") ?? join(root, "out");
const toolsBin = flag("tools");
assertDisposableMachine(process.argv.includes("--force"));
initE2E(outDir, "shims");

const pkg = "@851-labs/tokenmaxxing";
const spec = `${pkg}@${build.version}`;
const installs = join(root, "installs");
let registry: Registry;

// installer name -> issue, e.g. "yarn global add": "851-labs/tokenmaxxing#123".
const knownIssues: Record<string, string> = {};

const installers: Record<string, Installer> = {
  "npm i -g": {
    binDir: () => join(installs, "npm", "bin"),
    expectBin: "native",
    install: (packageSpec) => ({
      args: [
        "install",
        "-g",
        "--prefix",
        join(installs, "npm"),
        packageSpec,
        "--registry",
        `${registry.url}/`,
        "--foreground-scripts",
        "--no-audit",
        "--no-fund",
      ],
      command: npmCommand(),
    }),
    packageDir: () => join(installs, "npm", "lib", "node_modules", pkg),
  },
  "bun add -g": bunInstaller("bun", false),
  "bun add -g --trust": bunInstaller("bun-trust", true),
  "pnpm add -g": pnpmInstaller("pnpm", false),
  "pnpm add -g --allow-build": pnpmInstaller("pnpm-build", true),
  "yarn global add": {
    binDir: () => join(installs, "yarn-prefix", "bin"),
    expectBin: "launcher",
    install: (packageSpec) => ({
      args: [
        "global",
        "add",
        packageSpec,
        "--registry",
        `${registry.url}/`,
        "--prefix",
        join(installs, "yarn-prefix"),
        "--global-folder",
        join(installs, "yarn-global"),
        "--non-interactive",
      ],
      command: "yarn",
    }),
    packageDir: () => join(installs, "yarn-global", "node_modules", pkg),
  },
};

const shells: Record<string, (command: string) => [string, string[]]> = {
  bash: (command) => ["bash", ["-c", command]],
  sh: (command) => ["sh", ["-c", command]],
  pwsh: (command) => ["pwsh", ["-NoProfile", "-Command", `${command}; exit $LASTEXITCODE`]],
};

function bunInstaller(name: string, trust: boolean): Installer {
  const env = () => ({
    BUN_INSTALL_BIN: join(installs, `${name}-bin`),
    BUN_INSTALL_GLOBAL_DIR: join(installs, `${name}-global`),
  });
  return {
    binDir: () => env().BUN_INSTALL_BIN,
    env,
    expectBin: trust ? "native" : "launcher",
    install: (packageSpec) => ({
      args: [
        "add",
        "-g",
        packageSpec,
        "--registry",
        `${registry.url}/`,
        ...(trust ? ["--trust"] : []),
      ],
      command: "bun",
    }),
    packageDir: () => join(env().BUN_INSTALL_GLOBAL_DIR, "node_modules", pkg),
  };
}

function pnpmInstaller(name: string, allowBuild: boolean): Installer {
  const home = join(installs, `${name}-home`);
  const globalDir = join(installs, `${name}-global`);
  return {
    binDir: () => home,
    env: () => ({ PNPM_HOME: home }),
    expectBin: "launcher",
    install: (packageSpec) => ({
      args: [
        "add",
        "-g",
        packageSpec,
        "--registry",
        `${registry.url}/`,
        `--config.global-dir=${globalDir}`,
        ...(allowBuild ? [`--allow-build=${pkg}`] : []),
      ],
      command: "pnpm",
    }),
    packageDir: () => {
      const rootDir = run(
        "pnpm root -g",
        "pnpm",
        ["root", "-g", `--config.global-dir=${globalDir}`],
        {
          cwd: join(root, "cwd"),
          env: { ...baseEnv(), PNPM_HOME: home },
          quiet: true,
        },
      ).stdout;
      return join(rootDir, pkg);
    },
  };
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    npm_config_update_notifier: "false",
    PATH: [...(toolsBin ? [toolsBin] : []), process.env.PATH].join(delimiter),
    ...extra,
  };
}

function describeFile(path: string): { kind: BinKind | "missing" | "other"; detail: string } {
  if (!existsSync(path)) {
    return { detail: "missing", kind: "missing" };
  }
  const stat = lstatSync(path);
  const link = stat.isSymbolicLink() ? ` -> ${readlinkSync(path)}` : "";
  const bytes = readFileSync(path);
  const size = `${bytes.length} b${link}`;
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return { detail: `native ELF (${size})`, kind: "native" };
  }
  if ((bytes[0] === 0xcf && bytes[1] === 0xfa) || (bytes[0] === 0xca && bytes[1] === 0xfe)) {
    return { detail: `native Mach-O (${size})`, kind: "native" };
  }
  const head = bytes.subarray(0, 40).toString("latin1");
  if (head.startsWith("#!") && bytes.toString("utf8").includes("runNativeBinary")) {
    return { detail: `JS launcher (${size}) '${head.split("\n")[0]}'`, kind: "launcher" };
  }
  return { detail: `other (${size}) '${head.replace(/[^\x20-\x7e]/g, ".")}'`, kind: "other" };
}

function testInstaller(name: string, installer: Installer, nativeBogusCode: number) {
  const knownIssue = knownIssues[name];
  const env = baseEnv(installer.env?.() ?? {});
  // pnpm refuses a global install whose bin dir is not on PATH.
  mkdirSync(installer.binDir(), { recursive: true });
  env.PATH = [installer.binDir(), env.PATH].join(delimiter);
  const invocation = installer.install(spec);
  const install = run(`${name} install`, invocation.command, invocation.args, {
    cwd: join(root, "cwd"),
    env,
  });
  check(
    name,
    "install",
    install.code === 0,
    `exit ${install.code}: ${oneLine(install.out.split("\n").slice(-6).join("\n"))}`,
    { knownIssue },
  );

  const packageDir = installer.packageDir();
  const bin = describeFile(join(packageDir, "bin", "tokenmaxxing"));
  check(
    name,
    `bin/tokenmaxxing is the ${installer.expectBin === "native" ? "native binary" : "JS launcher"}`,
    bin.kind === installer.expectBin,
    bin.detail,
    { knownIssue },
  );
  check(
    name,
    "bin/tokenmaxxing.exe (cached native)",
    "INFO",
    describeFile(join(packageDir, "bin", "tokenmaxxing.exe")).detail,
  );
  const binDir = installer.binDir();
  const entries = existsSync(binDir)
    ? readdirSync(binDir)
        .filter((entry) => entry.startsWith("tokenmaxxing"))
        .map((entry) => `${entry} (${describeFile(join(binDir, entry)).detail})`)
        .join(", ")
    : "missing";
  check(name, "global bin entries", "INFO", `${binDir} :: ${entries}`);

  const shellEnv = env;
  const resolved = run(`${name} command -v`, "sh", ["-c", "command -v tokenmaxxing"], {
    env: shellEnv,
    quiet: true,
  });
  check(
    name,
    "tokenmaxxing resolves to this install",
    resolved.stdout === join(binDir, "tokenmaxxing"),
    resolved.out,
    { knownIssue },
  );
  for (const [shell, invoke] of Object.entries(shells)) {
    const [command, args] = invoke("tokenmaxxing --version");
    const result = run(`${name} via ${shell}`, command, args, { env: shellEnv });
    check(
      name,
      `tokenmaxxing --version via ${shell}`,
      result.code === 0 && result.out.includes(build.version),
      `exit ${result.code}: ${oneLine(result.out, 300)}`,
      { knownIssue },
    );
  }
  const bogus = run(`${name} bogus flag`, "sh", ["-c", "tokenmaxxing --definitely-not-a-flag"], {
    env: shellEnv,
    quiet: true,
  });
  check(
    name,
    "exit code propagates",
    bogus.code !== 0 && bogus.code === nativeBogusCode,
    `exit ${bogus.code} (native ${nativeBogusCode})`,
    { knownIssue },
  );
}

let registryProcess: Registry | undefined;
try {
  mkdirSync(join(root, "cwd"), { recursive: true });
  registryProcess = await startRegistry(outDir, root, [build.nativeDir, build.mainDir]);
  registry = registryProcess;
  // yarn v1 resolves scoped packages from the scope registry and ignores
  // --registry for them; `yarn global` reads $HOME/.yarnrc. Install from a
  // neutral directory: the repo's packageManager field makes yarn refuse.
  writeFileSync(
    join(homedir(), ".yarnrc"),
    `registry "${registry.url}/"\n"@851-labs:registry" "${registry.url}/"\n`,
  );
  writeFileSync(
    join(root, "cwd", ".npmrc"),
    `registry=${registry.url}/\n@851-labs:registry=${registry.url}/\n`,
  );

  const versions = ["node", "npm", "bun", "pnpm", "yarn", "pwsh"].map((tool) => {
    const args =
      tool === "pwsh"
        ? ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]
        : ["--version"];
    const result = run(`${tool} --version`, tool === "npm" ? npmCommand() : tool, args, {
      cwd: join(root, "cwd"),
      env: baseEnv(),
      quiet: true,
    });
    return `${tool} ${result.code === 0 ? result.stdout.split("\n")[0] : "missing"}`;
  });
  writeFileSync(
    join(outDir, "environment.json"),
    `${JSON.stringify({ image: `${process.env.ImageOS ?? "?"} ${process.env.ImageVersion ?? ""}`.trim(), os: `${process.platform}/${process.arch}`, tools: versions.join(", ") }, null, 2)}\n`,
  );

  await blockProduction("shims");

  const direct = run("native --version", build.nativeExe, ["--version"]);
  const nativeBogus = run("native bogus flag", build.nativeExe, ["--definitely-not-a-flag"], {
    quiet: true,
  });
  check(
    "native binary",
    "direct --version",
    direct.code === 0 && direct.out.includes(build.version),
    `exit ${direct.code}: ${oneLine(direct.out)}; bogus-flag exit ${nativeBogus.code}`,
  );

  for (const [name, installer] of Object.entries(installers)) {
    await scenario(name, () => testInstaller(name, installer, nativeBogus.code));
  }
  check("shims", "all installers ran", true, "");
} catch (error) {
  check(
    "shims",
    "harness ran without errors",
    false,
    oneLine(error instanceof Error ? `${error.message} ${error.stack}` : String(error)),
  );
} finally {
  registryProcess?.process.kill();
  unblockProduction();
}

if (!readFileSync(join(outDir, "results.jsonl"), "utf8").includes('"all installers ran"')) {
  check("shims", "matrix completed", false, "shim-matrix.ts never reached its end");
}
summarize(outDir, `${process.platform === "darwin" ? "macOS" : "Linux"} global-install shims`);
process.exit(failedChecks().length > 0 ? 1 : 0);
