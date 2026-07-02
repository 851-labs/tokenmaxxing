import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../package.json";
import { createMainPackageJson } from "./publish-manifest";
import { writeMainPackage } from "./publish-main-package";
import { npmDistTagForVersion, parsePublishCliArgs } from "./publish-options";
import { npmRegistryPackageVersionUrl } from "./publish-registry";

describe("publish script dist tags", () => {
  it("uses latest for stable versions and the prerelease identifier otherwise", () => {
    expect(npmDistTagForVersion("0.4.18")).toBe("latest");
    expect(npmDistTagForVersion("0.4.18-alpha.0")).toBe("alpha");
    expect(npmDistTagForVersion("0.4.18-beta.2")).toBe("beta");
    expect(npmDistTagForVersion("0.4.18-rc.1")).toBe("rc");
  });

  it("parses an explicit npm dist-tag override", () => {
    expect(
      parsePublishCliArgs(["--dry-run", "--tag", "alpha", "--out-dir", ".tmp/publish"]),
    ).toEqual({
      dryRun: true,
      outDir: ".tmp/publish",
      tag: "alpha",
    });
  });
});

describe("publish script generated main package", () => {
  it("publishes a native CLI installer package with new target optional dependencies", () => {
    const manifest = createMainPackageJson();

    expect(manifest.bin).toEqual({ tokenmaxxing: "./native-bin-launcher.cjs" });
    // Package-manager command shims should run the JS launcher. Pointing the
    // package bin at a native .exe makes Bun's Windows shim ask Node to parse it.
    expect(manifest.scripts).toEqual({
      preinstall: "bun ./install-native.mjs || node ./install-native.mjs",
    });
    expect(manifest.scripts).not.toHaveProperty("postinstall");
    expect(manifest.files).toEqual([
      "native-bin-launcher.cjs",
      "install-native.mjs",
      "README.md",
      "LICENSE",
    ]);
    expect(manifest.optionalDependencies).toHaveProperty("@851-labs/tokenmaxxing-darwin-arm64");
    expect(Object.keys(manifest.optionalDependencies)).not.toContain(
      "@851-labs/tokenmaxxing-service-darwin-arm64",
    );
  });

  it("writes the JS launcher as the package bin without a native exe placeholder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-publish-test-"));

    try {
      await writeMainPackage(dir);

      const packageDir = join(dir, packageJson.name);
      const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

      expect(manifest.bin).toEqual({ tokenmaxxing: "./native-bin-launcher.cjs" });
      expect(existsSync(join(packageDir, "native-bin-launcher.cjs"))).toBe(true);
      expect(existsSync(join(packageDir, "bin", "tokenmaxxing.exe"))).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("publish script registry checks", () => {
  it("uses public package version endpoints for scoped packages", () => {
    expect(
      npmRegistryPackageVersionUrl("@851-labs/tokenmaxxing-darwin-arm64", "0.4.18-alpha.4"),
    ).toBe("https://registry.npmjs.org/@851-labs%2Ftokenmaxxing-darwin-arm64/0.4.18-alpha.4");
  });

  it("escapes version build metadata in registry URLs", () => {
    expect(npmRegistryPackageVersionUrl("@851-labs/tokenmaxxing", "1.0.0-alpha.1+build.2")).toBe(
      "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing/1.0.0-alpha.1%2Bbuild.2",
    );
  });
});
