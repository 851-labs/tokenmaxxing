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
    bin: {
      tokenmaxxing: "./bin/tokenmaxxing.exe",
    },
    // npm links Windows shims after preinstall and before postinstall. Keep
    // native installation here so shims see the final .exe instead of Node JS.
    scripts: {
      preinstall: "bun ./install-native.mjs || node ./install-native.mjs",
    },
    files: [
      "bin",
      "native-bin-launcher.cjs",
      "install-native.mjs",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    publishConfig: packageJson.publishConfig,
    optionalDependencies: serviceRunnerOptionalDependencies(packageJson.version),
  };
}

export { createMainPackageJson };
