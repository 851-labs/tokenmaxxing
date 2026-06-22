import { describe, expect, it } from "vitest";

import {
  parseServiceRunnerTarget,
  platformForServiceRunnerTarget,
  serviceRunnerBinaryName,
  serviceRunnerOptionalDependencies,
  serviceRunnerPackageManifest,
  serviceRunnerPackageName,
  serviceRunnerPublishOrder,
  serviceRunnerTargetCandidates,
  serviceRunnerTargetDefinitions,
  serviceRunnerTargets,
} from "./service-runner-targets";

describe("service runner target candidates", () => {
  it("orders linux x64 glibc candidates by AVX2 support", () => {
    expect(
      serviceRunnerTargetCandidates({
        avx2: true,
        cpuArch: "x64",
        libc: "glibc",
        platform: "linux",
      }),
    ).toEqual(["linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-x64-baseline-musl"]);
    expect(
      serviceRunnerTargetCandidates({
        avx2: false,
        cpuArch: "x64",
        libc: "glibc",
        platform: "linux",
      }),
    ).toEqual(["linux-x64-baseline", "linux-x64", "linux-x64-baseline-musl", "linux-x64-musl"]);
  });

  it("orders linux x64 musl candidates by AVX2 support", () => {
    expect(
      serviceRunnerTargetCandidates({
        avx2: true,
        cpuArch: "x64",
        libc: "musl",
        platform: "linux",
      }),
    ).toEqual(["linux-x64-musl", "linux-x64-baseline-musl", "linux-x64", "linux-x64-baseline"]);
    expect(
      serviceRunnerTargetCandidates({
        avx2: false,
        cpuArch: "x64",
        libc: "musl",
        platform: "linux",
      }),
    ).toEqual(["linux-x64-baseline-musl", "linux-x64-musl", "linux-x64-baseline", "linux-x64"]);
  });

  it("orders linux arm64 by libc without crossing CPU architecture", () => {
    expect(
      serviceRunnerTargetCandidates({
        cpuArch: "arm64",
        libc: "glibc",
        platform: "linux",
      }),
    ).toEqual(["linux-arm64", "linux-arm64-musl"]);
    expect(
      serviceRunnerTargetCandidates({
        cpuArch: "arm64",
        libc: "musl",
        platform: "linux",
      }),
    ).toEqual(["linux-arm64-musl", "linux-arm64"]);
  });

  it("orders darwin and windows x64 baseline fallbacks by AVX2 support", () => {
    expect(
      serviceRunnerTargetCandidates({ avx2: true, cpuArch: "x64", platform: "darwin" }),
    ).toEqual(["darwin-x64", "darwin-x64-baseline"]);
    expect(
      serviceRunnerTargetCandidates({ avx2: false, cpuArch: "x64", platform: "darwin" }),
    ).toEqual(["darwin-x64-baseline", "darwin-x64"]);
    expect(
      serviceRunnerTargetCandidates({ avx2: true, cpuArch: "x64", platform: "win32" }),
    ).toEqual(["windows-x64", "windows-x64-baseline"]);
    expect(
      serviceRunnerTargetCandidates({ avx2: false, cpuArch: "x64", platform: "win32" }),
    ).toEqual(["windows-x64-baseline", "windows-x64"]);
  });

  it("supports exact arm64 targets for darwin and windows", () => {
    expect(serviceRunnerTargetCandidates({ cpuArch: "arm64", platform: "darwin" })).toEqual([
      "darwin-arm64",
    ]);
    expect(serviceRunnerTargetCandidates({ cpuArch: "arm64", platform: "win32" })).toEqual([
      "windows-arm64",
    ]);
  });
});

describe("service runner package metadata", () => {
  it("has the full OpenCode-style target matrix", () => {
    expect(serviceRunnerTargets).toEqual([
      "linux-arm64",
      "linux-x64",
      "linux-x64-baseline",
      "linux-arm64-musl",
      "linux-x64-musl",
      "linux-x64-baseline-musl",
      "darwin-arm64",
      "darwin-x64",
      "darwin-x64-baseline",
      "windows-arm64",
      "windows-x64",
      "windows-x64-baseline",
    ]);
  });

  it("generates npm package manifests for every target", () => {
    for (const definition of serviceRunnerTargetDefinitions) {
      const manifest = serviceRunnerPackageManifest(definition.target, "1.2.3");
      expect(manifest.name).toBe(serviceRunnerPackageName(definition.target));
      expect(manifest.version).toBe("1.2.3");
      expect(manifest.os).toEqual([definition.platform]);
      expect(manifest.cpu).toEqual([definition.arch]);
      expect(manifest.preferUnplugged).toBe(true);
      expect(manifest.publishConfig).toEqual({ access: "public" });
      expect(manifest.files).toEqual(["bin"]);
      expect(manifest.bin["tokenmaxxing-service"]).toBe(
        `bin/${serviceRunnerBinaryName(platformForServiceRunnerTarget(definition.target))}`,
      );
      if ("libc" in definition && definition.libc === "musl") {
        expect(manifest.libc).toEqual(["musl"]);
      } else {
        expect(manifest).not.toHaveProperty("libc");
      }
    }
  });

  it("generates main package optional dependencies and publish order from the same matrix", () => {
    const optionalDependencies = serviceRunnerOptionalDependencies("1.2.3");
    expect(Object.keys(optionalDependencies)).toEqual(
      serviceRunnerTargets.map((target) => serviceRunnerPackageName(target)),
    );
    expect(Object.values(optionalDependencies)).toEqual(serviceRunnerTargets.map(() => "1.2.3"));
    expect(serviceRunnerPublishOrder("@851-labs/tokenmaxxing")).toEqual([
      ...Object.keys(optionalDependencies),
      "@851-labs/tokenmaxxing",
    ]);
  });

  it("parses every generated target and rejects unknown targets", () => {
    for (const target of serviceRunnerTargets) {
      expect(parseServiceRunnerTarget(target)).toBe(target);
    }
    expect(parseServiceRunnerTarget("linux-riscv64")).toBeNull();
  });
});
