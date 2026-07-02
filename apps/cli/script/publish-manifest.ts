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
      tokenmaxxing: "./native-bin-launcher.cjs",
    },
    // Keep native installation in preinstall so package managers that skip
    // optional dependencies still get one chance to materialize the host binary.
    scripts: {
      preinstall: "bun ./install-native.mjs || node ./install-native.mjs",
    },
    files: ["native-bin-launcher.cjs", "install-native.mjs", "README.md", "LICENSE"],
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    publishConfig: packageJson.publishConfig,
    optionalDependencies: serviceRunnerOptionalDependencies(packageJson.version),
  };
}

export { createMainPackageJson };
