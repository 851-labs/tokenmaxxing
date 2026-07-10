#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

function detectPlatform(value = os.platform()) {
  return (
    {
      darwin: "darwin",
      linux: "linux",
      win32: "windows",
    }[value] ?? value
  );
}

function detectArch(value = os.arch()) {
  return (
    {
      arm64: "arm64",
      x64: "x64",
    }[value] ?? value
  );
}

function binaryName(platform = detectPlatform()) {
  platform = detectPlatform(platform);
  return platform === "windows" ? "tokenmaxxing.exe" : "tokenmaxxing";
}

function supportsAvx2(options = {}) {
  const arch = options.arch ?? detectArch();
  const platform = options.platform ?? detectPlatform();
  if (arch !== "x64") return false;

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
    } catch {
      return false;
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      });
      return result.status === 0 && (result.stdout || "").trim() === "1";
    } catch {
      return false;
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';
    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(
          executable,
          ["-NoProfile", "-NonInteractive", "-Command", command],
          {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          },
        );
        if (result.status !== 0) continue;
        const output = (result.stdout || "").trim().toLowerCase();
        if (output === "true" || output === "1") return true;
        if (output === "false" || output === "0") return false;
      } catch {
        continue;
      }
    }
  }

  return false;
}

function isMusl(platform = detectPlatform()) {
  if (platform !== "linux") return false;

  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {
    return false;
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl");
  } catch {
    return false;
  }
}

function nativePackageNames(options = {}) {
  const platform = detectPlatform(options.platform);
  const arch = options.arch ?? detectArch();
  const musl = options.musl ?? isMusl(platform);
  const baseline = arch === "x64" && !(options.avx2 ?? supportsAvx2({ arch, platform }));
  const base = `@851-labs/tokenmaxxing-${platform}-${arch}`;

  if (platform === "linux") {
    if (arch === "arm64") {
      return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
    }

    if (arch === "x64" && musl) {
      return baseline
        ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
        : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`];
    }

    if (arch === "x64") {
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    }
  }

  if (arch === "x64") {
    return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
  }

  if (arch === "arm64") {
    return [base];
  }

  return [];
}

function packageJsonPaths(packageDir = __dirname) {
  return [path.join(packageDir, "package.json"), path.join(packageDir, "..", "package.json")];
}

function readPackageJson(packageDir = __dirname) {
  for (const packageJsonPath of packageJsonPaths(packageDir)) {
    try {
      return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    } catch {
      continue;
    }
  }

  throw new Error("Unable to read @851-labs/tokenmaxxing package.json");
}

function packageResolvePaths(packageDir = __dirname) {
  return [packageDir, path.join(packageDir, "..")];
}

function resolveBinary(packageName, sourceBinary = binaryName(), options = {}) {
  const packageDir = options.packageDir ?? __dirname;
  const resolver = createRequire(path.join(packageDir, "package.json"));
  const packageJsonPath = resolver.resolve(`${packageName}/package.json`, {
    paths: packageResolvePaths(packageDir),
  });
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath}`);
  }
  return binaryPath;
}

function findNativeBinary(options = {}) {
  const packages = options.packages ?? nativePackageNames(options);
  const sourceBinary = options.sourceBinary ?? binaryName(options.platform);

  for (const packageName of packages) {
    try {
      return {
        packageName,
        path: resolveBinary(packageName, sourceBinary, options),
      };
    } catch {
      continue;
    }
  }

  const fallbackPath = path.join(options.packageDir ?? __dirname, "bin", "tokenmaxxing.exe");
  if (fs.existsSync(fallbackPath)) {
    return {
      packageName: "@851-labs/tokenmaxxing",
      path: fs.realpathSync(fallbackPath),
    };
  }

  return null;
}

function recoveryMessage(options = {}) {
  const packages = options.packages ?? nativePackageNames(options);
  return [
    "Error: @851-labs/tokenmaxxing could not find a native binary for this platform.",
    "",
    "This usually means your package manager skipped postinstall scripts or optional dependencies.",
    "It can also happen when an older broken global install is earlier in PATH.",
    "",
    "Debug:",
    "  which -a tokenmaxxing",
    "",
    "Fix:",
    "  bun remove -g @851-labs/tokenmaxxing && bun add -g --trust @851-labs/tokenmaxxing",
    "  npm install -g @851-labs/tokenmaxxing@latest",
    "  npx -y @851-labs/tokenmaxxing@latest bootstrap",
    "",
    `Expected one of: ${packages.length === 0 ? "(none)" : packages.join(", ")}`,
  ].join("\n");
}

function runBinary(target, argv = process.argv.slice(2)) {
  const result = childProcess.spawnSync(target, argv, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(typeof result.status === "number" ? result.status : 1);
}

function runNativeBinary(options = {}) {
  const envPath = process.env.TOKENMAXXING_BIN_PATH;
  if (envPath) {
    runBinary(envPath, options.argv);
    return;
  }

  const nativeBinary = findNativeBinary(options);
  if (nativeBinary === null) {
    console.error(recoveryMessage(options));
    process.exit(1);
  }
  runBinary(nativeBinary.path, options.argv);
}

if (require.main === module) {
  runNativeBinary();
}

module.exports = {
  binaryName,
  detectArch,
  detectPlatform,
  findNativeBinary,
  isMusl,
  nativePackageNames,
  packageJsonPaths,
  readPackageJson,
  recoveryMessage,
  resolveBinary,
  runNativeBinary,
  supportsAvx2,
};
