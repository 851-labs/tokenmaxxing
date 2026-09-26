import packageJson from "../package.json";
import { serviceRunnerOptionalDependencies } from "../src/service-runner-targets";

function createMainPackageJson() {
  return {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    keywords: packageJson.keywords,
    license: packageJson.license,
    repository: packageJson.repository,
    // Always a JS launcher when the package manager links it. Windows shims
    // (npm, pnpm, yarn, and Bun's .bunx) and pnpm's POSIX shims record the
    // runtime from the file at link time, and Bun links before preinstall, so a
    // file that preinstall later swaps for a native binary gets run by node.
    // Preinstall caches the native binary at bin/tokenmaxxing.exe for the
    // launcher, and only replaces bin/tokenmaxxing itself under npm/Bun on
    // macOS/Linux, where the link is a plain symlink.
    bin: {
      tokenmaxxing: "./bin/tokenmaxxing",
    },
    scripts: {
      preinstall: "bun ./install-native.mjs || node ./install-native.mjs",
    },
    files: ["bin", "native-bin-launcher.cjs", "install-native.mjs", "README.md", "LICENSE"],
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    publishConfig: packageJson.publishConfig,
    optionalDependencies: serviceRunnerOptionalDependencies(packageJson.version),
  };
}

export { createMainPackageJson };
