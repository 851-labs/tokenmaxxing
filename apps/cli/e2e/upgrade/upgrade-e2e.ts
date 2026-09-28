#!/usr/bin/env bun
/**
 * Upgrade and auto-update e2e for every OS. Builds this checkout under
 * fabricated versions, serves them all from the local registry, and moves
 * the registry's dist-tags around while checking which version
 * `tokenmaxxing upgrade` and the service runner's auto-update pick:
 *
 *   stable 0.6.8 follows `latest` (0.6.9); a prerelease follows its channel
 *   (`alpha`) and `latest`, never drops to a lower `latest`, and moves to
 *   stable once `latest` is higher; with the registry unreachable, a
 *   prerelease refuses to upgrade while a stable install still runs @latest.
 *
 * The same decisions are checked for the service runner, during runs the OS
 * scheduler starts (launchd / systemd --user / Task Scheduler) against the
 * API sandbox.
 *
 *   bun apps/cli/e2e/upgrade/upgrade-e2e.ts [--root <dir>] [--out <dir>] [--force]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  assertDisposableMachine,
  blockProduction,
  buildFakeBin,
  check,
  failedChecks,
  flag,
  initE2E,
  isWindows,
  npmCommand,
  oneLine,
  parseCliJson,
  processEnv,
  readBuild,
  repoDir,
  run,
  scenario,
  startRegistry,
  startSandbox,
  unblockProduction,
  type Build,
  type Registry,
  type Sandbox,
} from "../shared/harness";
import {
  backend,
  launchdDomain,
  prepareSystemdUser,
  systemdUserEnv,
  triggerScheduledRun,
  waitForSystemdRun,
} from "../shared/scheduler";
import {
  assertSuccessfulRun,
  configFile,
  newProfile,
  observeRun,
  serviceJson,
  tmx,
  type Profile,
  type ServiceContext,
} from "../shared/service";
import { summarize } from "../shared/summarize";

const STABLE_OLD = "0.6.8";
const STABLE_LATEST = "0.6.9";
const ALPHA_PR = "0.7.0-alpha.1";
const ALPHA_LATEST = "0.7.0-alpha.9";
const STABLE_NEXT = "0.7.0";
const VERSIONS = [STABLE_OLD, STABLE_LATEST, ALPHA_PR, ALPHA_LATEST, STABLE_NEXT];
const PACKAGE = "@851-labs/tokenmaxxing";
// Nothing listens here: the registry is unreachable, not just failing.
const DEAD_REGISTRY = "http://127.0.0.1:9";

const root = flag("root") ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "tmx-e2e-upgrade");
const outDir = flag("out") ?? join(root, "out");
assertDisposableMachine(process.argv.includes("--force"));
initE2E(outDir, "upgrade");

let registry: Registry | undefined;
let sandbox: Sandbox | undefined;
let fakeBin = "";
let context: ServiceContext;
const builds = new Map<string, Build>();

interface UpgradeJson {
  channel?: string;
  channelVersion?: string | null;
  command?: string | null;
  service?: { status?: string };
  currentVersion?: string;
  distTag?: string | null;
  error?: { code?: string; message?: string };
  latestVersion?: string | null;
  skipped?: boolean;
  status?: string;
  targetVersion?: string | null;
  updated?: boolean;
  versionCheck?: string;
}

interface Install {
  bin: string;
  env: Record<string, string | undefined>;
  label: string;
  prefix: string;
}

// ------------------------------------------------------------------ setup
async function setup(): Promise<boolean> {
  const environment: Record<string, string> = {
    image: `${process.env.ImageOS ?? "?"} ${process.env.ImageVersion ?? ""}`.trim(),
    os: `${process.platform}/${process.arch}`,
    versions: VERSIONS.join(", "),
  };
  if (backend === "launchd") {
    const manager = run("launchctl managername", "launchctl", ["managername"]).stdout;
    const domain = run("launchctl print gui domain", "launchctl", ["print", launchdDomain()], {
      quiet: true,
    }).code;
    check(
      "setup",
      "runner has an Aqua (GUI) session with a gui/<uid> launchd domain",
      manager === "Aqua" && domain === 0,
      `managername=${manager}; launchctl print ${launchdDomain()} exit ${domain}`,
    );
  } else if (backend === "systemd") {
    const systemd = await prepareSystemdUser();
    check("setup", "systemd --user manager is running (lingering)", systemd.ok, systemd.detail);
  }

  // One release-style build per fabricated version, all from this checkout.
  // (Run from the scratch root: bun --compile leaves temp files in its cwd.)
  mkdirSync(root, { recursive: true });
  for (const version of VERSIONS) {
    const dir = join(root, "pkgs", version);
    const result = run(
      `build ${version}`,
      "bun",
      [
        join(repoDir, "apps", "cli", "e2e", "shared", "build-packages.ts"),
        "--out",
        dir,
        "--version",
        version,
      ],
      { cwd: root, quiet: true },
    );
    const ok = result.code === 0 && existsSync(join(dir, "build.json"));
    check(
      "setup",
      `build ${version}`,
      ok,
      ok ? "" : oneLine(result.out.split("\n").slice(-8).join("\n")),
    );
    if (ok) {
      builds.set(version, readBuild(join(dir, "build.json")));
    }
  }
  if (builds.size !== VERSIONS.length) {
    return false;
  }

  registry = await startRegistry(
    outDir,
    root,
    VERSIONS.flatMap((version) => [builds.get(version)!.nativeDir, builds.get(version)!.mainDir]),
    { distTags: { alpha: ALPHA_LATEST, latest: STABLE_LATEST } },
  );
  environment.registry = registry.url;
  writeFileSync(join(outDir, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);

  fakeBin = buildFakeBin(join(root, "fakebin"));
  sandbox = await startSandbox(outDir);
  await blockProduction();

  context = {
    agentLogsDir: join(root, "agent-logs"),
    baseEnv: {
      ...processEnv(),
      ...(backend === "systemd" ? systemdUserEnv() : {}),
      npm_config_update_notifier: "false",
    },
    sandbox,
  };
  return failedChecks().length === 0;
}

// ------------------------------------------------------------------ helpers
async function distTags(
  tags: { alpha?: string; latest?: string },
  mode: "down" | "metadata-down" | "ok" = "ok",
) {
  await registry!.setState({ distTags: tags, mode });
}

/** `npm install -g` of one version into its own prefix, with the CLI and npm pointed at `registryUrl`. */
function npmInstall(label: string, version: string, registryUrl = registry!.url): Install {
  const prefix = join(root, "npm", label);
  const bin = isWindows ? prefix : join(prefix, "bin");
  const env = {
    ...context.baseEnv,
    npm_config_prefix: prefix,
    npm_config_registry: `${registryUrl}/`,
    PATH: [bin, context.baseEnv.PATH].join(delimiter),
    // `upgrade` refreshes the service in the config dir it resolves; never
    // let that be a real one.
    TOKENMAXXING_CONFIG_DIR: join(root, `cfg-${label}`),
    TOKENMAXXING_NPM_REGISTRY: registryUrl,
  };
  const result = run(
    `npm install -g ${version} (${label})`,
    npmCommand(),
    ["install", "-g", `${PACKAGE}@${version}`, "--no-audit", "--no-fund"],
    { env },
  );
  check(
    label,
    `npm install -g ${PACKAGE}@${version}`,
    result.code === 0 && installedVersion({ bin, env, label, prefix }) === version,
    `exit ${result.code}; --version ${installedVersion({ bin, env, label, prefix })}`,
  );
  return { bin, env, label, prefix };
}

function withRegistry(install: Install, registryUrl: string): Install {
  return {
    ...install,
    env: {
      ...install.env,
      npm_config_registry: `${registryUrl}/`,
      TOKENMAXXING_NPM_REGISTRY: registryUrl,
    },
  };
}

function installedVersion(install: Install): string {
  const result = run("tokenmaxxing --version", "tokenmaxxing", ["--version"], {
    env: install.env,
    quiet: true,
  });
  return (
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(result.stdout)?.[0] ??
    `? (${oneLine(result.out, 120)})`
  );
}

function upgrade(install: Install): { code: number; json: UpgradeJson | null; out: string } {
  const result = run(
    `tokenmaxxing upgrade --json (${install.label})`,
    "tokenmaxxing",
    ["upgrade", "--json"],
    { env: install.env },
  );
  return { code: result.code, json: parseCliJson<UpgradeJson>(result.out), out: result.out };
}

function npmCommandFor(specifier: string) {
  return `npm install -g ${PACKAGE}@${specifier} --silent`;
}

/** Compares the fields of `upgrade --json` that matter; returns the mismatches. */
function mismatches(json: UpgradeJson | null, expected: UpgradeJson): string[] {
  const actual = (key: string): unknown => {
    const value = (json as Record<string, unknown> | null)?.[key];
    // Only an error's code and message are asserted; its hint may change.
    return key === "error" && value !== null && typeof value === "object"
      ? {
          code: (value as UpgradeJson["error"])?.code,
          message: (value as UpgradeJson["error"])?.message,
        }
      : value;
  };
  return Object.entries(expected)
    .filter(([key, value]) => JSON.stringify(actual(key)) !== JSON.stringify(value))
    .map(
      ([key, value]) =>
        `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual(key))}`,
    );
}

function assertUpgrade(
  name: string,
  what: string,
  install: Install,
  expected: UpgradeJson,
  expectedVersion: string,
) {
  const result = upgrade(install);
  const wrong = mismatches(result.json, expected);
  check(
    name,
    `upgrade --json: ${what}`,
    wrong.length === 0 && (expected.status === "error" ? result.code !== 0 : result.code === 0),
    wrong.length === 0
      ? `exit ${result.code}; ${oneLine(JSON.stringify(result.json), 500)}`
      : `exit ${result.code}; ${wrong.join("; ")}; ${oneLine(result.out, 400)}`,
  );
  const version = installedVersion(install);
  check(
    name,
    `installed version is ${expectedVersion}`,
    version === expectedVersion,
    `tokenmaxxing --version -> ${version}`,
  );
}

function skipped(
  current: string,
  channel: string,
  channelVersion: string,
  latestVersion: string,
): UpgradeJson {
  return {
    channel,
    channelVersion,
    command: null,
    currentVersion: current,
    distTag: null,
    latestVersion,
    service: { status: "skipped" },
    skipped: true,
    status: "ok",
    targetVersion: null,
    updated: false,
    versionCheck: "ok",
  };
}

// ------------------------------------------------------------------ upgrade --json
async function stableFollowsLatest() {
  const name = "upgrade: stable follows latest";
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_LATEST });
  const install = npmInstall("stable", STABLE_OLD);
  assertUpgrade(
    name,
    `${STABLE_OLD} -> latest ${STABLE_LATEST}`,
    install,
    {
      channel: "latest",
      channelVersion: STABLE_LATEST,
      command: npmCommandFor("latest"),
      currentVersion: STABLE_OLD,
      distTag: "latest",
      latestVersion: STABLE_LATEST,
      service: { status: "not-installed" },
      skipped: false,
      status: "ok",
      targetVersion: STABLE_LATEST,
      updated: true,
      versionCheck: "ok",
    },
    STABLE_LATEST,
  );
  assertUpgrade(
    name,
    "up to date: skipped, command null",
    install,
    skipped(STABLE_LATEST, "latest", STABLE_LATEST, STABLE_LATEST),
    STABLE_LATEST,
  );
}

async function prereleaseFollowsChannel() {
  const name = "upgrade: prerelease follows its channel";
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_LATEST });
  const install = npmInstall("alpha", ALPHA_PR);
  assertUpgrade(
    name,
    `${ALPHA_PR} -> alpha ${ALPHA_LATEST} (exact version)`,
    install,
    {
      channel: "alpha",
      channelVersion: ALPHA_LATEST,
      command: npmCommandFor(ALPHA_LATEST),
      currentVersion: ALPHA_PR,
      distTag: "alpha",
      latestVersion: STABLE_LATEST,
      service: { status: "not-installed" },
      skipped: false,
      status: "ok",
      targetVersion: ALPHA_LATEST,
      updated: true,
      versionCheck: "ok",
    },
    ALPHA_LATEST,
  );

  // latest (0.6.9) is lower than the installed prerelease: never "update" to it.
  assertUpgrade(
    name,
    `never drops to a lower latest ${STABLE_LATEST}`,
    install,
    skipped(ALPHA_LATEST, "alpha", ALPHA_LATEST, STABLE_LATEST),
    ALPHA_LATEST,
  );

  // The alpha tag moving back below the install is not a reason to move either.
  await distTags({ alpha: ALPHA_PR, latest: STABLE_LATEST });
  assertUpgrade(
    name,
    `never follows alpha back down to ${ALPHA_PR}`,
    install,
    skipped(ALPHA_LATEST, "alpha", ALPHA_PR, STABLE_LATEST),
    ALPHA_LATEST,
  );

  // Once latest is higher than the prerelease, it moves to stable.
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_NEXT });
  assertUpgrade(
    name,
    `alpha -> stable once latest ${STABLE_NEXT} is higher`,
    install,
    {
      channel: "alpha",
      channelVersion: ALPHA_LATEST,
      command: npmCommandFor("latest"),
      currentVersion: ALPHA_LATEST,
      distTag: "latest",
      latestVersion: STABLE_NEXT,
      service: { status: "not-installed" },
      skipped: false,
      status: "ok",
      targetVersion: STABLE_NEXT,
      updated: true,
      versionCheck: "ok",
    },
    STABLE_NEXT,
  );
  assertUpgrade(
    name,
    "stable now: follows latest only",
    install,
    skipped(STABLE_NEXT, "latest", STABLE_NEXT, STABLE_NEXT),
    STABLE_NEXT,
  );
}

async function registryUnreachable() {
  const name = "upgrade: registry unreachable";
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_LATEST });
  const alpha = withRegistry(npmInstall("offline-alpha", ALPHA_PR), DEAD_REGISTRY);
  assertUpgrade(
    name,
    "prerelease refuses without a version check",
    alpha,
    {
      error: {
        code: "upgrade_prerelease_version_check",
        message: "could not check the latest tokenmaxxing versions",
      },
      status: "error",
    } as UpgradeJson,
    ALPHA_PR,
  );
  const stable = withRegistry(npmInstall("offline-stable", STABLE_OLD), DEAD_REGISTRY);
  // A stable install cannot be ahead of latest, so it still runs @latest,
  // which fails here because npm cannot reach the registry either.
  assertUpgrade(
    name,
    "stable still runs @latest (and fails with npm)",
    stable,
    {
      error: { code: "upgrade_failed", message: "failed to upgrade tokenmaxxing" },
      status: "error",
    } as UpgradeJson,
    STABLE_OLD,
  );
}

async function distTagsUnavailable() {
  const name = "upgrade: version check fails, packages reachable";
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_LATEST });
  const alpha = npmInstall("metadata-down-alpha", ALPHA_PR);
  const stable = npmInstall("metadata-down-stable", STABLE_OLD);
  await distTags({}, "metadata-down");
  const requestsBefore = (await registry!.requests()).length;
  assertUpgrade(
    name,
    "prerelease refuses",
    alpha,
    {
      error: {
        code: "upgrade_prerelease_version_check",
        message: "could not check the latest tokenmaxxing versions",
      },
      status: "error",
    } as UpgradeJson,
    ALPHA_PR,
  );
  const afterAlpha = (await registry!.requests()).slice(requestsBefore);
  check(
    name,
    "prerelease never asked npm to install anything",
    afterAlpha.every((request) => request.path.includes("/dist-tags")),
    afterAlpha.map((request) => `${request.method} ${request.path} ${request.status}`).join(", "),
  );
  assertUpgrade(
    name,
    `stable runs @latest anyway -> ${STABLE_LATEST}`,
    stable,
    {
      channel: "latest",
      channelVersion: null,
      command: npmCommandFor("latest"),
      currentVersion: STABLE_OLD,
      distTag: null,
      latestVersion: null,
      service: { status: "not-installed" },
      skipped: false,
      status: "ok",
      targetVersion: null,
      updated: true,
      versionCheck: "unavailable",
    },
    STABLE_LATEST,
  );
  await distTags({}, "ok");
}

// ------------------------------------------------------------------ service runner auto-update
/** A service installed by `version`'s CLI, with the runner checking the e2e registry. */
async function installService(
  name: string,
  label: string,
  version: string,
): Promise<{ install: Install; profile: Profile } | null> {
  const install = npmInstall(label, version);
  const profile = await newProfile(context, join(root, `cfg-${label}`), [fakeBin, install.bin], {
    npm_config_prefix: install.env.npm_config_prefix,
    npm_config_registry: install.env.npm_config_registry,
    TOKENMAXXING_NPM_REGISTRY: registry!.url,
  });
  const result = tmx(profile, ["service", "install", "--json"]);
  const ok = check(
    name,
    `service install (runner ${version})`,
    result.code === 0 && serviceJson(profile)?.runnerVersion === version,
    `exit ${result.code}; runnerVersion=${serviceJson(profile)?.runnerVersion}; ${oneLine(result.out, 300)}`,
  );
  if (backend === "systemd") {
    // Enabling the timer starts a run right away; let it finish first.
    await waitForSystemdRun(60_000);
  }
  return ok ? { install, profile } : null;
}

async function assertAutoUpdateRun(
  name: string,
  profile: Profile,
  runLabel: string,
  expected: {
    installedVersion: string | null;
    latestVersion: string | null;
    reason?: string | null;
    status: string;
  },
  runnerAfter: string,
) {
  const observed = await observeRun(context, profile, runLabel, () => triggerScheduledRun(), {});
  assertSuccessfulRun(name, observed, { allowCooldown: true });
  const autoUpdate = (observed.line?.autoUpdate ?? null) as Record<string, unknown> | null;
  const wrong = Object.entries(expected)
    .filter(([key, value]) => JSON.stringify(autoUpdate?.[key]) !== JSON.stringify(value))
    .map(
      ([key, value]) =>
        `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(autoUpdate?.[key])}`,
    );
  check(
    name,
    `scheduled run's auto-update: ${expected.status}${expected.installedVersion ? ` ${expected.installedVersion}` : ""} (${runLabel})`,
    autoUpdate?.manager === "registry" && wrong.length === 0,
    wrong.length === 0
      ? oneLine(JSON.stringify(autoUpdate), 500)
      : `${wrong.join("; ")}; ${oneLine(JSON.stringify(autoUpdate), 400)}`,
  );
  const meta = serviceJson(profile);
  const pointer = readText(configFile(profile, "service-runner-current")).trim();
  const pointerVersion =
    pointer === "" ? "" : run("runner --version", pointer, ["--version"], { quiet: true }).stdout;
  check(
    name,
    `runner is ${runnerAfter} (${runLabel})`,
    meta?.runnerVersion === runnerAfter &&
      pointer.includes(runnerAfter) &&
      pointerVersion.includes(runnerAfter),
    `service.json runnerVersion=${meta?.runnerVersion}; pointer=${pointer} (${oneLine(pointerVersion, 80)})`,
  );
}

async function serviceStable() {
  const name = "auto-update: stable runner";
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_LATEST });
  const installed = await installService(name, "svc-stable", STABLE_OLD);
  if (installed === null) {
    return;
  }
  const { profile } = installed;
  await assertAutoUpdateRun(
    name,
    profile,
    "stable-update",
    {
      installedVersion: STABLE_LATEST,
      latestVersion: STABLE_LATEST,
      reason: null,
      status: "success",
    },
    STABLE_LATEST,
  );
  await assertAutoUpdateRun(
    name,
    profile,
    "stable-current",
    {
      installedVersion: STABLE_LATEST,
      latestVersion: STABLE_LATEST,
      reason: null,
      status: "not-needed",
    },
    STABLE_LATEST,
  );
  await distTags({}, "down");
  await assertAutoUpdateRun(
    name,
    profile,
    "stable-registry-down",
    { installedVersion: null, latestVersion: null, reason: "download-failed", status: "failure" },
    STABLE_LATEST,
  );
  await distTags({}, "ok");
  tmx(profile, ["service", "uninstall", "--json"]);
}

async function servicePrerelease() {
  const name = "auto-update: prerelease runner";
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_LATEST });
  const installed = await installService(name, "svc-alpha", ALPHA_PR);
  if (installed === null) {
    return;
  }
  const { profile } = installed;
  await assertAutoUpdateRun(
    name,
    profile,
    "alpha-update",
    {
      installedVersion: ALPHA_LATEST,
      latestVersion: ALPHA_LATEST,
      reason: null,
      status: "success",
    },
    ALPHA_LATEST,
  );
  await assertAutoUpdateRun(
    name,
    profile,
    "alpha-never-to-lower-latest",
    {
      installedVersion: ALPHA_LATEST,
      latestVersion: ALPHA_LATEST,
      reason: null,
      status: "not-needed",
    },
    ALPHA_LATEST,
  );
  await distTags({ alpha: ALPHA_PR, latest: STABLE_LATEST });
  await assertAutoUpdateRun(
    name,
    profile,
    "alpha-tag-moved-back",
    { installedVersion: ALPHA_LATEST, latestVersion: ALPHA_PR, reason: null, status: "not-needed" },
    ALPHA_LATEST,
  );
  await distTags({}, "down");
  await assertAutoUpdateRun(
    name,
    profile,
    "alpha-registry-down",
    { installedVersion: null, latestVersion: null, reason: "download-failed", status: "failure" },
    ALPHA_LATEST,
  );
  await distTags({ alpha: ALPHA_LATEST, latest: STABLE_NEXT }, "ok");
  await assertAutoUpdateRun(
    name,
    profile,
    "alpha-to-stable",
    { installedVersion: STABLE_NEXT, latestVersion: STABLE_NEXT, reason: null, status: "success" },
    STABLE_NEXT,
  );
  tmx(profile, ["service", "uninstall", "--json"]);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ main
try {
  if (await setup()) {
    await scenario("upgrade: stable follows latest", stableFollowsLatest);
    await scenario("upgrade: prerelease follows its channel", prereleaseFollowsChannel);
    await scenario("upgrade: registry unreachable", registryUnreachable);
    await scenario("upgrade: version check fails, packages reachable", distTagsUnavailable);
    await scenario("auto-update: stable runner", serviceStable);
    await scenario("auto-update: prerelease runner", servicePrerelease);
    check("upgrade", "all scenarios ran", true, "");
  } else {
    console.log("::error::setup failed; skipping the upgrade scenarios");
  }
} catch (error) {
  check(
    "setup",
    "harness ran without errors",
    false,
    oneLine(error instanceof Error ? `${error.message} ${error.stack}` : String(error)),
  );
} finally {
  if (sandbox !== undefined) {
    writeFileSync(
      join(outDir, "sandbox-requests.json"),
      JSON.stringify(await sandbox.requests().catch(() => []), null, 2),
    );
  }
  if (registry !== undefined) {
    writeFileSync(
      join(outDir, "registry-requests.json"),
      JSON.stringify(await registry.requests().catch(() => []), null, 2),
    );
  }
  run("remove service", ...cleanupCommand());
  sandbox?.process.kill();
  registry?.process.kill();
  unblockProduction();
}

function cleanupCommand(): [string, string[], { quiet: boolean }] {
  if (backend === "launchd") {
    return ["launchctl", ["bootout", `${launchdDomain()}/sh.tokenmaxxing.sync`], { quiet: true }];
  }
  if (backend === "systemd") {
    return [
      "systemctl",
      ["--user", "disable", "--now", "tokenmaxxing-sync.timer"],
      { quiet: true },
    ];
  }
  return ["schtasks", ["/Delete", "/TN", "tokenmaxxing-sync", "/F"], { quiet: true }];
}

if (!readText(join(outDir, "results.jsonl")).includes('"all scenarios ran"')) {
  check("setup", "upgrade scenarios completed", false, "upgrade-e2e.ts never reached its end");
}
summarize(outDir, "Upgrade + auto-update e2e");
process.exit(failedChecks().length > 0 ? 1 : 0);
