#!/usr/bin/env bun

import { $ } from "bun";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json";
import { assertSafeOutputDir, buildServiceRunners } from "./build-service-runners";
import { createMainPackageJson } from "./publish-manifest";
import {
  npmDistTagForVersion,
  parsePublishCliArgs,
  type PublishCliOptions,
} from "./publish-options";
import { packageVersionIsPublished } from "./publish-registry";
import {
  platformForServiceRunnerTarget,
  serviceRunnerBinaryName,
  serviceRunnerPackageName,
  serviceRunnerPublishOrder,
  serviceRunnerTarget,
  serviceRunnerTargets,
  type ServiceRunnerTarget,
} from "../src/service-runner-targets";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(cliDir, "../..");

async function publishCli(options: PublishCliOptions = {}): Promise<void> {
  const outDir =
    options.outDir === undefined
      ? await mkdtemp(join(tmpdir(), "tokenmaxxing-cli-publish-"))
      : resolve(options.outDir);

  assertSafeOutputDir(outDir);
  await rm(outDir, { force: true, recursive: true });
  await mkdir(outDir, { recursive: true });

  await $`bun run build`.cwd(cliDir);
  await buildServiceRunners({ outDir, targets: serviceRunnerTargets });
  await writeMainPackage(outDir);
  await smokeTestHostRunner(outDir);

  const packagePaths = packagePublishPaths(outDir);
  const tag = options.tag ?? npmDistTagForVersion(packageJson.version);
  for (const packageName of serviceRunnerPublishOrder(packageJson.name)) {
    const packagePath = packagePaths[packageName];
    if (packagePath === undefined) {
      throw new Error(`missing generated package ${packageName}`);
    }
    await publishPackage(packagePath, packageName, packageJson.version, { ...options, tag });
  }
}

function packagePublishPaths(outDir: string): Record<string, string> {
  return Object.fromEntries([
    ...serviceRunnerTargets.map((target) => {
      const packageName = serviceRunnerPackageName(target);
      return [packageName, join(outDir, packageName)];
    }),
    [packageJson.name, join(outDir, packageJson.name)],
  ]);
}

async function writeMainPackage(outDir: string): Promise<void> {
  const packageDir = join(outDir, packageJson.name);
  const binDir = join(packageDir, "bin");
  await mkdir(packageDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await cp(join(repoDir, "LICENSE"), join(packageDir, "LICENSE"));
  await cp(join(repoDir, "THIRD_PARTY_NOTICES.md"), join(packageDir, "THIRD_PARTY_NOTICES.md"));
  await cp(join(cliDir, "README.md"), join(packageDir, "README.md"));
  await cp(join(cliDir, "script", "install-native.mjs"), join(packageDir, "install-native.mjs"));
  await cp(
    join(cliDir, "script", "native-bin-launcher.cjs"),
    join(packageDir, "native-bin-launcher.cjs"),
  );
  await cp(join(cliDir, "script", "native-bin-launcher.cjs"), join(binDir, "tokenmaxxing.exe"));
  await chmod(join(binDir, "tokenmaxxing.exe"), 0o755);
  await Bun.write(
    join(packageDir, "package.json"),
    `${JSON.stringify(createMainPackageJson(), null, 2)}\n`,
  );
}

async function smokeTestHostRunner(outDir: string): Promise<void> {
  const target = serviceRunnerTarget();
  if (target === null) {
    throw new Error(`no native package target for ${process.platform}/${process.arch}`);
  }

  const runnerPath = serviceRunnerPackageBinaryPath(outDir, target);
  const output = await $`${runnerPath} --version`.text();
  const expectedVersion = packageJson.version;
  if (!output.includes(expectedVersion)) {
    throw new Error(
      `host native package smoke test returned ${JSON.stringify(output.trim())}, expected ${expectedVersion}`,
    );
  }
}

function serviceRunnerPackageBinaryPath(outDir: string, target: ServiceRunnerTarget): string {
  const platform = platformForServiceRunnerTarget(target);
  return join(outDir, serviceRunnerPackageName(target), "bin", serviceRunnerBinaryName(platform));
}

async function publishPackage(
  packagePath: string,
  packageName: string,
  version: string,
  options: PublishCliOptions,
): Promise<void> {
  if (await packageVersionIsPublished(packageName, version)) {
    console.log(`already published ${packageName}@${version}`);
    return;
  }

  const args = ["publish", "--access", "public"];
  if (options.provenance !== false) {
    args.push("--provenance");
  }
  args.push("--tag", options.tag ?? npmDistTagForVersion(version));
  if (options.dryRun === true) {
    args.push("--dry-run");
  }

  console.log(
    `${options.dryRun === true ? "dry-run publishing" : "publishing"} ${packageName}@${version}`,
  );
  await $`npm ${args}`.cwd(packagePath);
}

async function main(): Promise<void> {
  await publishCli(parsePublishCliArgs(process.argv.slice(2)));
}

if (import.meta.main) {
  await main();
}

export {
  packagePublishPaths,
  publishCli,
  serviceRunnerPackageBinaryPath,
  smokeTestHostRunner,
  writeMainPackage,
};
export type { PublishCliOptions };
