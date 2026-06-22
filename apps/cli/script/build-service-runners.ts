#!/usr/bin/env bun

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json";
import {
  platformForServiceRunnerTarget,
  serviceRunnerBinaryName,
  serviceRunnerBunTarget,
  serviceRunnerPackageManifest,
  serviceRunnerPackageName,
  serviceRunnerTarget,
  serviceRunnerTargets,
  type ServiceRunnerTarget,
} from "../src/service-runner-targets";

interface BuildServiceRunnerOptions {
  clean?: boolean | undefined;
  outDir: string;
  single?: boolean | undefined;
  targets?: readonly ServiceRunnerTarget[] | undefined;
}

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(cliDir, "../..");

async function buildServiceRunners(options: BuildServiceRunnerOptions): Promise<void> {
  assertSafeOutputDir(options.outDir);
  const targets = selectedTargets(options);
  if (targets.length === 0) {
    throw new Error("no service runner targets selected");
  }

  if (options.clean !== false) {
    await rm(options.outDir, { force: true, recursive: true });
  }
  await mkdir(options.outDir, { recursive: true });

  for (const target of targets) {
    const packageName = serviceRunnerPackageName(target);
    const packageDir = join(options.outDir, packageName);
    const platform = platformForServiceRunnerTarget(target);
    const binaryName = serviceRunnerBinaryName(platform);
    const outfile = join(packageDir, "bin", binaryName);

    console.log(`building ${packageName}`);
    await mkdir(dirname(outfile), { recursive: true });
    const result = await Bun.build({
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadPackageJson: true,
        autoloadTsconfig: true,
        execArgv: ["--use-system-ca", "--"],
        outfile,
        target: serviceRunnerBunTarget(target) as Bun.Build.CompileTarget,
      },
      entrypoints: [join(cliDir, "src/index.ts")],
      format: "esm",
      minify: true,
      target: "bun",
    });

    if (!result.success) {
      for (const log of result.logs) {
        console.error(log);
      }
      throw new Error(`failed to build ${packageName}`);
    }

    await Bun.write(
      join(packageDir, "package.json"),
      `${JSON.stringify(
        serviceRunnerPackageManifest(target, packageJson.version, {
          license: packageJson.license,
          repository: {
            directory: `generated/${packageName}`,
            type: "git",
            url: packageJson.repository.url,
          },
        }),
        null,
        2,
      )}\n`,
    );
    await cp(join(repoDir, "LICENSE"), join(packageDir, "LICENSE"));
  }
}

function selectedTargets(options: BuildServiceRunnerOptions): readonly ServiceRunnerTarget[] {
  if (options.targets !== undefined) {
    return options.targets;
  }

  if (options.single === true) {
    const target = serviceRunnerTarget();
    return target === null ? [] : [target];
  }

  return serviceRunnerTargets;
}

function parseBuildServiceRunnerArgs(argv: readonly string[]): BuildServiceRunnerOptions {
  let outDir = join(cliDir, "dist", "service-runners");
  let single = false;
  const targets: ServiceRunnerTarget[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--out-dir requires a value");
      }
      outDir = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--single") {
      single = true;
      continue;
    }
    if (arg === "--target") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--target requires a value");
      }
      if (!serviceRunnerTargets.includes(value as ServiceRunnerTarget)) {
        throw new Error(`unsupported service runner target ${value}`);
      }
      targets.push(value as ServiceRunnerTarget);
      index += 1;
      continue;
    }

    throw new Error(`unknown argument ${arg}`);
  }

  return {
    outDir,
    single,
    targets: targets.length === 0 ? undefined : targets,
  };
}

function assertSafeOutputDir(outDir: string): void {
  const resolvedOutDir = resolve(outDir);
  const unsafeDirs = new Set([resolve("/"), repoDir, cliDir]);
  if (unsafeDirs.has(resolvedOutDir)) {
    throw new Error(`refusing to clean unsafe output directory ${resolvedOutDir}`);
  }
}

async function main(): Promise<void> {
  await buildServiceRunners(parseBuildServiceRunnerArgs(process.argv.slice(2)));
}

if (import.meta.main) {
  await main();
}

export { assertSafeOutputDir, buildServiceRunners, parseBuildServiceRunnerArgs, selectedTargets };
export type { BuildServiceRunnerOptions };
