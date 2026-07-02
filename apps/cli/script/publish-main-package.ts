import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json";
import { createMainPackageJson } from "./publish-manifest";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(cliDir, "../..");

async function writeMainPackage(outDir: string): Promise<void> {
  const packageDir = join(outDir, packageJson.name);
  await mkdir(packageDir, { recursive: true });
  await cp(join(repoDir, "LICENSE"), join(packageDir, "LICENSE"));
  await cp(join(cliDir, "README.md"), join(packageDir, "README.md"));
  await cp(join(cliDir, "script", "install-native.mjs"), join(packageDir, "install-native.mjs"));
  await cp(
    join(cliDir, "script", "native-bin-launcher.cjs"),
    join(packageDir, "native-bin-launcher.cjs"),
  );
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify(createMainPackageJson(), null, 2)}\n`,
  );
}

export { writeMainPackage };
