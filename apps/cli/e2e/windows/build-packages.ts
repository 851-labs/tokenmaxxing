#!/usr/bin/env bun
/**
 * Builds the CLI packages for THIS host the way a release does
 * (script/build-native-packages.ts + script/publish.ts writeMainPackage):
 *
 *   bun apps/cli/e2e/windows/build-packages.ts --out <dir> --version <version>
 *
 * Writes <dir>/@851-labs/tokenmaxxing, <dir>/@851-labs/tokenmaxxing-<host
 * target> and <dir>/build.json. The version is stamped into package.json for
 * the build and restored afterwards.
 *
 * One deliberate deviation from a release: the main package's
 * optionalDependencies are trimmed to the host target, because only that
 * native package is built and served by the e2e registry.
 */
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = fileURLToPath(new URL("../..", import.meta.url));
const cliPackageJsonPath = join(cliDir, "package.json");

const outDir = resolve(requiredFlag("out"));
const version = requiredFlag("version");

const originalPackageJson = await readFile(cliPackageJsonPath, "utf8");
await writeFile(
  cliPackageJsonPath,
  `${JSON.stringify({ ...JSON.parse(originalPackageJson), version }, null, 2)}\n`,
);
try {
  // Imported after stamping: these modules read package.json at load time.
  const { buildNativePackages } = await import("../../script/build-native-packages");
  const { writeMainPackage } = await import("../../script/publish");
  const targets = await import("../../src/service-runner-targets");

  const target = targets.serviceRunnerTarget();
  if (target === null) {
    throw new Error(`no service runner target for ${process.platform}/${process.arch}`);
  }
  const nativePackageName = targets.serviceRunnerPackageName(target);
  const nativeDir = join(outDir, nativePackageName);
  const nativeExe = join(nativeDir, "bin", targets.serviceRunnerBinaryName(process.platform));

  await buildNativePackages({ outDir, targets: [target] });
  const smoke = spawnSync(nativeExe, ["--version"], { encoding: "utf8" });
  console.log(`native smoke: ${nativeExe} --version -> ${smoke.status} ${smoke.stdout.trim()}`);
  if (!smoke.stdout.includes(version)) {
    throw new Error(`native smoke test failed: ${smoke.stderr.trim()}`);
  }

  await writeMainPackage(outDir);
  const mainDir = join(outDir, "@851-labs", "tokenmaxxing");
  const mainManifestPath = join(mainDir, "package.json");
  const mainManifest = JSON.parse(await readFile(mainManifestPath, "utf8"));
  mainManifest.optionalDependencies = { [nativePackageName]: version };
  await writeFile(mainManifestPath, `${JSON.stringify(mainManifest, null, 2)}\n`);

  const build = { mainDir, nativeDir, nativeExe, nativePackageName, target, version };
  await writeFile(join(outDir, "build.json"), `${JSON.stringify(build, null, 2)}\n`);
  console.log(JSON.stringify(build, null, 2));
} finally {
  await writeFile(cliPackageJsonPath, originalPackageJson);
}

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value;
}
