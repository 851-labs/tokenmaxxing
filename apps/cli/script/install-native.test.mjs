import { describe, expect, it } from "vite-plus/test";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  binaryName,
  canReplaceLauncher,
  nativePackageNames,
  replaceLauncher,
} from "./install-native.mjs";
import launcher from "./native-bin-launcher.cjs";
import {
  serviceRunnerPackageName,
  serviceRunnerTargetCandidates,
} from "../src/service-runner-targets";

const { findCachedBinary, findNativeBinary, recoveryMessage, relayedSignals } = launcher;
const launcherSource = path.join(import.meta.dirname, "native-bin-launcher.cjs");

async function withTempDir(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenmaxxing-native-launcher-"));
  try {
    return await run(temp);
  } finally {
    fs.rmSync(temp, { force: true, recursive: true });
  }
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

/** Lays out a published main package: bin/tokenmaxxing is the launcher, bin/tokenmaxxing.exe the cached binary. */
function writeMainPackage(temp, cachedBinary) {
  writeExecutable(path.join(temp, "bin", "tokenmaxxing"), fs.readFileSync(launcherSource));
  fs.writeFileSync(
    path.join(temp, "package.json"),
    JSON.stringify({ name: "@851-labs/tokenmaxxing" }),
  );
  writeExecutable(path.join(temp, "bin", "tokenmaxxing.exe"), cachedBinary);
}

function runLauncher(temp, args = []) {
  const env = { ...process.env };
  delete env.TOKENMAXXING_BIN_PATH;
  return childProcess.spawnSync(
    process.execPath,
    [path.join(temp, "bin", "tokenmaxxing"), ...args],
    {
      encoding: "utf8",
      env,
    },
  );
}

describe("native preinstall package selection", () => {
  it("matches service runner candidate ordering", () => {
    for (const options of [
      { arch: "x64", avx2: true, musl: false, platform: "linux" },
      { arch: "x64", avx2: false, musl: false, platform: "linux" },
      { arch: "x64", avx2: true, musl: true, platform: "linux" },
      { arch: "x64", avx2: false, musl: true, platform: "linux" },
      { arch: "arm64", musl: false, platform: "linux" },
      { arch: "arm64", musl: true, platform: "linux" },
      { arch: "x64", avx2: true, platform: "darwin" },
      { arch: "x64", avx2: false, platform: "darwin" },
      { arch: "arm64", platform: "darwin" },
      { arch: "x64", avx2: true, platform: "win32" },
      { arch: "x64", avx2: false, platform: "win32" },
      { arch: "arm64", platform: "win32" },
    ]) {
      expect(nativePackageNames(options)).toEqual(
        serviceRunnerTargetCandidates({
          avx2: options.avx2,
          cpuArch: options.arch,
          libc: options.musl === undefined ? undefined : options.musl ? "musl" : "glibc",
          platform: options.platform,
        }).map((target) => serviceRunnerPackageName(target)),
      );
    }
  });

  it("orders linux glibc and musl x64 candidates with baseline fallback", () => {
    expect(nativePackageNames({ arch: "x64", avx2: true, musl: false, platform: "linux" })).toEqual(
      [
        "@851-labs/tokenmaxxing-linux-x64",
        "@851-labs/tokenmaxxing-linux-x64-baseline",
        "@851-labs/tokenmaxxing-linux-x64-musl",
        "@851-labs/tokenmaxxing-linux-x64-baseline-musl",
      ],
    );
    expect(nativePackageNames({ arch: "x64", avx2: false, musl: true, platform: "linux" })).toEqual(
      [
        "@851-labs/tokenmaxxing-linux-x64-baseline-musl",
        "@851-labs/tokenmaxxing-linux-x64-musl",
        "@851-labs/tokenmaxxing-linux-x64-baseline",
        "@851-labs/tokenmaxxing-linux-x64",
      ],
    );
  });

  it("orders darwin and windows native packages with arm64 exact matches", () => {
    expect(nativePackageNames({ arch: "x64", avx2: false, platform: "darwin" })).toEqual([
      "@851-labs/tokenmaxxing-darwin-x64-baseline",
      "@851-labs/tokenmaxxing-darwin-x64",
    ]);
    expect(nativePackageNames({ arch: "arm64", platform: "windows" })).toEqual([
      "@851-labs/tokenmaxxing-windows-arm64",
    ]);
  });

  it("uses native executable names inside target packages", () => {
    expect(binaryName("darwin")).toBe("tokenmaxxing");
    expect(binaryName("linux")).toBe("tokenmaxxing");
    expect(binaryName("windows")).toBe("tokenmaxxing.exe");
  });

  it("fallback launcher resolves an installed optional native package", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenmaxxing-native-launcher-"));
    try {
      const packageName = "@851-labs/tokenmaxxing-darwin-arm64";
      const packageDir = path.join(temp, "node_modules", "@851-labs", "tokenmaxxing-darwin-arm64");
      const binaryPath = path.join(packageDir, "bin", "tokenmaxxing");
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: packageName }),
      );
      fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");

      expect(
        findNativeBinary({
          arch: "arm64",
          packageDir: temp,
          platform: "darwin",
        }),
      ).toEqual({
        packageName,
        path: fs.realpathSync(binaryPath),
      });
    } finally {
      fs.rmSync(temp, { force: true, recursive: true });
    }
  });

  it("fallback launcher recovery message explains shadowed and script-blocked installs", () => {
    const message = recoveryMessage({ arch: "arm64", platform: "darwin" });

    expect(message).toContain("which -a tokenmaxxing");
    expect(message).toContain("bun add -g --trust @851-labs/tokenmaxxing");
    expect(message).toContain("bun remove -g @851-labs/tokenmaxxing");
    expect(message).toContain("npx -y @851-labs/tokenmaxxing@latest bootstrap");
  });
});

describe("native bin launcher", () => {
  it("prefers the binary preinstall cached beside the launcher", async () => {
    await withTempDir((temp) => {
      writeMainPackage(temp, "#!/bin/sh\nexit 0\n");

      const cached = fs.realpathSync(path.join(temp, "bin", "tokenmaxxing.exe"));
      expect(fs.realpathSync(findCachedBinary(path.join(temp, "bin")))).toBe(cached);
      expect(fs.realpathSync(findCachedBinary(temp))).toBe(cached);
    });
    await withTempDir((temp) => {
      expect(findCachedBinary(temp)).toBeNull();
    });
  });

  it("only forwards signals where the native binary is not already signalled", () => {
    expect(relayedSignals("windows")).toEqual({ forward: false, signals: ["SIGINT", "SIGBREAK"] });
    expect(relayedSignals("darwin").forward).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "passes arguments through and propagates the native exit code",
    async () => {
      await withTempDir((temp) => {
        writeMainPackage(temp, '#!/bin/sh\nprintf "%s|" "$@"\nexit 7\n');

        const result = runLauncher(temp, ["sync", "--json", "two words"]);

        expect(result.stdout).toBe("sync|--json|two words|");
        expect(result.status).toBe(7);
      });
    },
  );

  it.skipIf(process.platform === "win32")("dies with the native binary's signal", async () => {
    await withTempDir((temp) => {
      writeMainPackage(temp, "#!/bin/sh\nkill -TERM $$\n");

      const result = runLauncher(temp);

      expect(result.signal).toBe("SIGTERM");
    });
  });

  it.skipIf(process.platform === "win32")("forwards SIGTERM to the native binary", async () => {
    await withTempDir(async (temp) => {
      const marker = path.join(temp, "terminated");
      writeMainPackage(
        temp,
        `#!/bin/sh\ntrap 'echo term > "${marker}"; exit 143' TERM\necho ready\nwhile :; do sleep 0.05; done\n`,
      );

      const child = childProcess.spawn(process.execPath, [path.join(temp, "bin", "tokenmaxxing")], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      await new Promise((resolve) => child.stdout.once("data", resolve));
      child.kill("SIGTERM");
      const [code] = await new Promise((resolve) => child.on("exit", (...exit) => resolve(exit)));

      expect(code).toBe(143);
      expect(fs.readFileSync(marker, "utf8")).toBe("term\n");
    });
  });
});

describe("native preinstall launcher replacement", () => {
  it("replaces the launcher only for npm and Bun on macOS/Linux", () => {
    expect(canReplaceLauncher("darwin", "npm/11.6.0 node/v24.18.0 darwin arm64")).toBe(true);
    expect(canReplaceLauncher("linux", "bun/1.4.2 npm/? node/v24.3.0 linux x64")).toBe(true);
    expect(canReplaceLauncher("windows", "npm/11.6.0 node/v24.18.0 win32 x64")).toBe(false);
    expect(canReplaceLauncher("windows", "bun/1.4.2 npm/? node/v24.3.0 win32 x64")).toBe(false);
    expect(canReplaceLauncher("linux", "pnpm/10.18.0 npm/? node/v24.18.0 linux x64")).toBe(false);
    expect(canReplaceLauncher("darwin", "yarn/1.22.22 npm/? node/v24.18.0 darwin arm64")).toBe(
      false,
    );
    expect(canReplaceLauncher("linux", "")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "swaps in a verified native binary and restores the launcher otherwise",
    async () => {
      await withTempDir((temp) => {
        const launcherPath = path.join(temp, "bin", "tokenmaxxing");
        const good = path.join(temp, "good");
        const bad = path.join(temp, "bad");
        writeExecutable(launcherPath, fs.readFileSync(launcherSource));
        writeExecutable(good, "#!/bin/sh\nexit 0\n");
        writeExecutable(bad, "#!/bin/sh\nexit 1\n");

        expect(replaceLauncher(bad, launcherPath)).toBe(false);
        expect(fs.readFileSync(launcherPath, "utf8")).toBe(fs.readFileSync(launcherSource, "utf8"));
        expect(fs.statSync(launcherPath).mode & 0o111).not.toBe(0);

        expect(replaceLauncher(good, launcherPath)).toBe(true);
        expect(fs.readFileSync(launcherPath, "utf8")).toBe("#!/bin/sh\nexit 0\n");
      });
    },
  );
});
