#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const launcher = require("./native-bin-launcher.cjs");

const {
  CACHED_BINARY_NAME,
  binaryName,
  detectArch,
  detectPlatform,
  isMusl,
  nativePackageNames,
  readPackageJson: readLauncherPackageJson,
  resolveBinary,
  supportsAvx2,
} = launcher;

const targetBinary = path.join(__dirname, "bin", CACHED_BINARY_NAME);
const launcherBinary = path.join(__dirname, "bin", "tokenmaxxing");
const launcherSource = path.join(__dirname, "native-bin-launcher.cjs");
let packageJsonCache;

function copyBinary(source, target = targetBinary) {
  if (!fs.existsSync(source)) {
    throw new Error(`Binary not found at ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
  fs.chmodSync(target, 0o755);
}

function installPackage(packageName, sourceBinary = binaryName()) {
  const packageJson = readPackageJson();
  const version = packageJson.optionalDependencies?.[packageName];
  if (typeof version !== "string" || version.length === 0) {
    return false;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenmaxxing-install-"));
  try {
    const result = childProcess.spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--loglevel=error",
        "--prefix",
        temp,
        `${packageName}@${version}`,
      ],
      { stdio: "inherit", windowsHide: true },
    );
    if (result.status !== 0) {
      return false;
    }

    copyBinary(path.join(temp, "node_modules", packageName, "bin", sourceBinary));
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function readPackageJson() {
  if (packageJsonCache !== undefined) {
    return packageJsonCache;
  }
  packageJsonCache = readLauncherPackageJson(__dirname);
  return packageJsonCache;
}

function verifyBinary(target = targetBinary) {
  const result = childProcess.spawnSync(target, ["--version"], {
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0;
}

// npm and bun link POSIX bins as symlinks, so replacing the JS launcher behind
// the link makes every call exec the native binary directly. Everywhere else the
// link is a generated shim that pins the runtime by reading the file when it is
// linked (Windows cmd/ps1/.bunx shims, pnpm's shell shims) — often before this
// script runs — and would then run node on a native binary. Those keep the JS
// launcher, which execs the cached binary.
function canReplaceLauncher(
  platform = detectPlatform(),
  userAgent = process.env.npm_config_user_agent ?? "",
) {
  return platform !== "windows" && /^(npm|bun)\//.test(userAgent);
}

function replaceLauncher(source = targetBinary, target = launcherBinary) {
  try {
    copyBinary(source, target);
    if (verifyBinary(target)) return true;
  } catch {
    // Fall through and restore the launcher.
  }
  try {
    fs.rmSync(target, { force: true });
    fs.copyFileSync(launcherSource, target);
    fs.chmodSync(target, 0o755);
  } catch {
    // Leave whatever is there; the cached binary is still in place.
  }
  return false;
}

function installNativeBinary() {
  const packages = nativePackageNames();
  const sourceBinary = binaryName();

  for (const packageName of packages) {
    let installed = false;
    try {
      copyBinary(resolveBinary(packageName, sourceBinary, { packageDir: __dirname }));
      installed = verifyBinary();
    } catch {
      installed = installPackage(packageName, sourceBinary) && verifyBinary();
    }
    if (installed) {
      if (canReplaceLauncher()) replaceLauncher();
      return;
    }
    // The launcher trusts whatever is cached, so never leave a binary that failed.
    fs.rmSync(targetBinary, { force: true });
  }

  throw new Error(
    `It seems your package manager failed to install the right tokenmaxxing native package. Try manually installing ${packages
      .map((packageName) => JSON.stringify(packageName))
      .join(" or ")}.`,
  );
}

function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  return argv1 !== undefined && path.resolve(fileURLToPath(metaUrl)) === path.resolve(argv1);
}

if (isMainModule()) {
  try {
    installNativeBinary();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {
  binaryName,
  canReplaceLauncher,
  copyBinary,
  detectArch,
  detectPlatform,
  installNativeBinary,
  isMainModule,
  isMusl,
  nativePackageNames,
  readPackageJson,
  replaceLauncher,
  supportsAvx2,
  verifyBinary,
};
