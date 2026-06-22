import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch as hostArch, platform as hostPlatform } from "node:os";

const SERVICE_RUNNER_PACKAGE_PREFIX = "@851-labs/tokenmaxxing-service-";
const SERVICE_RUNNER_BIN_NAME = "tokenmaxxing-service";

const serviceRunnerTargetDefinitions = [
  { arch: "arm64", platform: "linux", target: "linux-arm64" },
  { arch: "x64", platform: "linux", target: "linux-x64" },
  { arch: "x64", baseline: true, platform: "linux", target: "linux-x64-baseline" },
  { arch: "arm64", libc: "musl", platform: "linux", target: "linux-arm64-musl" },
  { arch: "x64", libc: "musl", platform: "linux", target: "linux-x64-musl" },
  {
    arch: "x64",
    baseline: true,
    libc: "musl",
    platform: "linux",
    target: "linux-x64-baseline-musl",
  },
  { arch: "arm64", platform: "darwin", target: "darwin-arm64" },
  { arch: "x64", platform: "darwin", target: "darwin-x64" },
  { arch: "x64", baseline: true, platform: "darwin", target: "darwin-x64-baseline" },
  { arch: "arm64", platform: "win32", target: "windows-arm64" },
  { arch: "x64", platform: "win32", target: "windows-x64" },
  { arch: "x64", baseline: true, platform: "win32", target: "windows-x64-baseline" },
] as const;

type ServiceRunnerTargetDefinition = (typeof serviceRunnerTargetDefinitions)[number];
type ServiceRunnerTarget = ServiceRunnerTargetDefinition["target"];
type ServiceRunnerArch = ServiceRunnerTargetDefinition["arch"];
type ServiceRunnerLibc = "glibc" | "musl";
type ServiceRunnerPlatform = ServiceRunnerTargetDefinition["platform"];

interface ServiceRunnerHostOptions {
  avx2?: boolean | undefined;
  cpuArch?: string | undefined;
  libc?: ServiceRunnerLibc | undefined;
  platform?: NodeJS.Platform | undefined;
}

interface ServiceRunnerPackageManifest {
  bin: {
    "tokenmaxxing-service": string;
  };
  cpu: ServiceRunnerArch[];
  files: ["bin"];
  libc?: ["musl"] | undefined;
  license?: string | undefined;
  name: string;
  os: ServiceRunnerPlatform[];
  preferUnplugged: true;
  publishConfig: {
    access: "public";
  };
  repository?: {
    directory?: string | undefined;
    type: "git";
    url: string;
  };
  version: string;
}

function parseServiceRunnerTarget(value: string | undefined): ServiceRunnerTarget | null {
  return serviceRunnerTargetDefinitions.some((definition) => definition.target === value)
    ? (value as ServiceRunnerTarget)
    : null;
}

function serviceRunnerTargetDefinition(target: ServiceRunnerTarget): ServiceRunnerTargetDefinition {
  return serviceRunnerTargetDefinitions.find((definition) => definition.target === target)!;
}

function serviceRunnerPackageName(target: ServiceRunnerTarget): string {
  return `${SERVICE_RUNNER_PACKAGE_PREFIX}${target}`;
}

function serviceRunnerBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${SERVICE_RUNNER_BIN_NAME}.exe` : SERVICE_RUNNER_BIN_NAME;
}

function serviceRunnerBunTarget(target: ServiceRunnerTarget): string {
  return `bun-${target}`;
}

function platformForServiceRunnerTarget(target: ServiceRunnerTarget): NodeJS.Platform {
  return serviceRunnerTargetDefinition(target).platform;
}

function serviceRunnerPackageManifest(
  target: ServiceRunnerTarget,
  version: string,
  options: {
    license?: string | undefined;
    repository?: ServiceRunnerPackageManifest["repository"] | undefined;
  } = {},
): ServiceRunnerPackageManifest {
  const definition = serviceRunnerTargetDefinition(target);
  const binaryName = serviceRunnerBinaryName(definition.platform);

  return {
    bin: {
      "tokenmaxxing-service": `bin/${binaryName}`,
    },
    cpu: [definition.arch],
    files: ["bin"],
    ...("libc" in definition && definition.libc === "musl" ? { libc: ["musl"] as ["musl"] } : {}),
    ...(options.license === undefined ? {} : { license: options.license }),
    name: serviceRunnerPackageName(target),
    os: [definition.platform],
    preferUnplugged: true,
    publishConfig: {
      access: "public",
    },
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    version,
  };
}

function serviceRunnerOptionalDependencies(version: string): Record<string, string> {
  return Object.fromEntries(
    serviceRunnerTargetDefinitions.map((definition) => [
      serviceRunnerPackageName(definition.target),
      version,
    ]),
  );
}

function serviceRunnerPublishOrder(mainPackageName: string): string[] {
  return [
    ...serviceRunnerTargetDefinitions.map((definition) =>
      serviceRunnerPackageName(definition.target),
    ),
    mainPackageName,
  ];
}

function serviceRunnerTargetCandidates(
  options: ServiceRunnerHostOptions = {},
): readonly ServiceRunnerTarget[] {
  const platform = options.platform ?? hostPlatform();
  const cpuArch = normalizeCpuArch(options.cpuArch ?? hostArch());
  if (cpuArch === null) {
    return [];
  }

  if (platform === "linux") {
    const libc = options.libc ?? detectLinuxLibc();
    if (cpuArch === "arm64") {
      return libc === "musl"
        ? ["linux-arm64-musl", "linux-arm64"]
        : ["linux-arm64", "linux-arm64-musl"];
    }

    const baseline = !(options.avx2 ?? supportsAvx2({ cpuArch, platform }));
    if (libc === "musl") {
      return baseline
        ? ["linux-x64-baseline-musl", "linux-x64-musl", "linux-x64-baseline", "linux-x64"]
        : ["linux-x64-musl", "linux-x64-baseline-musl", "linux-x64", "linux-x64-baseline"];
    }

    return baseline
      ? ["linux-x64-baseline", "linux-x64", "linux-x64-baseline-musl", "linux-x64-musl"]
      : ["linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-x64-baseline-musl"];
  }

  if (platform === "darwin") {
    if (cpuArch === "arm64") {
      return ["darwin-arm64"];
    }

    const baseline = !(options.avx2 ?? supportsAvx2({ cpuArch, platform }));
    return baseline ? ["darwin-x64-baseline", "darwin-x64"] : ["darwin-x64", "darwin-x64-baseline"];
  }

  if (platform === "win32") {
    if (cpuArch === "arm64") {
      return ["windows-arm64"];
    }

    const baseline = !(options.avx2 ?? supportsAvx2({ cpuArch, platform }));
    return baseline
      ? ["windows-x64-baseline", "windows-x64"]
      : ["windows-x64", "windows-x64-baseline"];
  }

  return [];
}

function serviceRunnerTarget(
  platform: NodeJS.Platform = process.platform,
  cpuArch: string = hostArch(),
): ServiceRunnerTarget | null {
  return serviceRunnerTargetCandidates({ cpuArch, platform })[0] ?? null;
}

function normalizeCpuArch(cpuArch: string): ServiceRunnerArch | null {
  if (cpuArch === "arm64" || cpuArch === "x64") {
    return cpuArch;
  }

  return null;
}

function detectLinuxLibc(): ServiceRunnerLibc {
  try {
    if (existsSync("/etc/alpine-release")) {
      return "musl";
    }
  } catch {
    return "glibc";
  }

  try {
    const result = spawnSync("ldd", ["--version"], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
    return output.includes("musl") ? "musl" : "glibc";
  } catch {
    return "glibc";
  }
}

function supportsAvx2(
  options: {
    cpuArch?: string | undefined;
    platform?: NodeJS.Platform | undefined;
  } = {},
): boolean {
  const cpuArch = options.cpuArch ?? hostArch();
  const platform = options.platform ?? hostPlatform();
  if (cpuArch !== "x64") {
    return false;
  }

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"));
    } catch {
      return false;
    }
  }

  if (platform === "darwin") {
    try {
      const result = spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      });
      return result.status === 0 && (result.stdout ?? "").trim() === "1";
    } catch {
      return false;
    }
  }

  if (platform === "win32") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';
    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = spawnSync(
          executable,
          ["-NoProfile", "-NonInteractive", "-Command", command],
          {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          },
        );
        if (result.status !== 0) {
          continue;
        }

        const output = (result.stdout ?? "").trim().toLowerCase();
        if (output === "true" || output === "1") {
          return true;
        }
        if (output === "false" || output === "0") {
          return false;
        }
      } catch {
        continue;
      }
    }
  }

  return false;
}

const serviceRunnerTargets = serviceRunnerTargetDefinitions.map(
  (definition) => definition.target,
) as readonly ServiceRunnerTarget[];

export {
  SERVICE_RUNNER_BIN_NAME,
  SERVICE_RUNNER_PACKAGE_PREFIX,
  detectLinuxLibc,
  parseServiceRunnerTarget,
  platformForServiceRunnerTarget,
  serviceRunnerBinaryName,
  serviceRunnerBunTarget,
  serviceRunnerOptionalDependencies,
  serviceRunnerPackageManifest,
  serviceRunnerPackageName,
  serviceRunnerPublishOrder,
  serviceRunnerTarget,
  serviceRunnerTargetCandidates,
  serviceRunnerTargetDefinition,
  serviceRunnerTargetDefinitions,
  serviceRunnerTargets,
  supportsAvx2,
};

export type {
  ServiceRunnerHostOptions,
  ServiceRunnerLibc,
  ServiceRunnerPackageManifest,
  ServiceRunnerTarget,
};
