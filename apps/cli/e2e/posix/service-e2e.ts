#!/usr/bin/env bun
/**
 * macOS (launchd) and Linux (systemd --user) service e2e. Installs this
 * checkout's release-style build from the local registry and drives the real
 * scheduler against the API sandbox:
 *
 *   core            install -> definition (plist / units) + wrapper + runner ->
 *                   the scheduler's own first run (Linux: the timer; macOS:
 *                   the StartInterval, at the end) -> triggered runs ->
 *                   status/doctor -> error paths -> service-failure and
 *                   reload-required deferred repairs -> uninstall
 *   path cases      install -> run -> reload-required repair -> run -> uninstall
 *                   under config dirs with spaces, (), &, ', % and non-ASCII
 *   legacy upgrade  a release from before this template (0.7.0-alpha.0,
 *                   template 5) upgraded by a runner auto-update (deferred
 *                   repair) and by `service repair` (foreground)
 *
 *   bun apps/cli/e2e/posix/service-e2e.ts --build <build.json> [--root <dir>] [--out <dir>] [--legacy 0.7.0-alpha.0] [--force]
 */
import {
  accessSync,
  statSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertDisposableMachine,
  blockProduction,
  buildFakeBin,
  check,
  failedChecks,
  fetchLegacyRelease,
  flag,
  initE2E,
  keep,
  npmCommand,
  oneLine,
  parseCliJson,
  processEnv,
  readBuild,
  repoDir,
  requiredFlag,
  run,
  scenario,
  startRegistry,
  startSandbox,
  unblockProduction,
  waitUntil,
  type Registry,
  type Sandbox,
} from "../shared/harness";
import {
  backend,
  launchdDomain,
  launchdJob,
  launchdPlistPath,
  LAUNCHD_LABEL,
  prepareSystemdUser,
  systemctl,
  systemdShow,
  systemdUnitDir,
  systemdUserEnv,
  SYSTEMD_UNIT,
  triggerScheduledRun,
  waitForLaunchdRun,
  waitForSystemdRun,
  type SchedulerRun,
} from "../shared/scheduler";
import {
  assertSuccessfulRun,
  configFile,
  currentTemplateVersion,
  newProfile,
  observeRun,
  serviceJson,
  serviceState,
  setTemplateVersion,
  tmx,
  type Profile,
  type ServiceContext,
} from "../shared/service";
import { summarize } from "../shared/summarize";

const build = readBuild(requiredFlag("build"));
const root = flag("root") ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "tmx-e2e");
const outDir = flag("out") ?? join(root, "out");
const legacyVersion = flag("legacy") ?? "0.7.0-alpha.0";
const title = `${backend === "launchd" ? "macOS launchd" : "Linux systemd --user"} service e2e`;
assertDisposableMachine(process.argv.includes("--force"));
initE2E(outDir, "service");

const templateVersion = currentTemplateVersion(repoDir);
const home = homedir();
const zoe = "Zoë";

let sandbox: Sandbox | undefined;
let registry: Registry | undefined;
let context: ServiceContext;
let tmxBin = "";
let legacyBin: string | null = null;
let fakeBin = "";

// ------------------------------------------------------------------ setup
async function setup(): Promise<boolean> {
  const environment: Record<string, string> = {
    image: `${process.env.ImageOS ?? "?"} ${process.env.ImageVersion ?? ""}`.trim(),
    os: `${process.platform}/${process.arch}`,
    uid: String(process.getuid?.()),
  };

  if (backend === "launchd") {
    // launchd user agents live in the gui/<uid> domain, which only exists
    // while that user has an Aqua (GUI) login session.
    const manager = run("launchctl managername", "launchctl", ["managername"]);
    const domain = run("launchctl print gui domain", "launchctl", ["print", launchdDomain()], {
      quiet: true,
    });
    environment.session = `${manager.stdout || "?"}; ${launchdDomain()} ${domain.code === 0 ? "present" : "missing"}`;
    const aqua = manager.stdout === "Aqua" && domain.code === 0;
    check(
      "setup",
      "runner has an Aqua (GUI) session with a gui/<uid> launchd domain",
      aqua,
      `managername=${manager.stdout}; launchctl print ${launchdDomain()} exit ${domain.code}: ${oneLine(domain.out, 200)}`,
    );
    if (!aqua) {
      console.log(
        "::error::No Aqua session: launchctl bootstrap gui/<uid> cannot load a user agent on this runner, so every launchd check would be meaningless.",
      );
      return false;
    }
  } else {
    const systemd = await prepareSystemdUser();
    environment.session = systemd.detail;
    check("setup", "systemd --user manager is running (lingering)", systemd.ok, systemd.detail);
    if (!systemd.ok) {
      return false;
    }
  }
  writeFileSync(join(outDir, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);

  fakeBin = buildFakeBin(join(root, "fakebin"));
  sandbox = await startSandbox(outDir);
  check("setup", "sandbox API up", true, sandbox.url);

  registry = await startRegistry(outDir, root, [build.nativeDir, build.mainDir]);
  const prefix = join(root, "npm-global");
  const install = run("npm install -g", npmCommand(), [
    "install",
    "-g",
    `@851-labs/tokenmaxxing@${build.version}`,
    "--prefix",
    prefix,
    "--registry",
    `${registry.url}/`,
    "--no-audit",
    "--no-fund",
  ]);
  tmxBin = join(prefix, "bin");
  const version = run("tokenmaxxing --version", join(tmxBin, "tokenmaxxing"), ["--version"]);
  check(
    "setup",
    "npm install -g from the e2e registry",
    install.code === 0 && version.out.includes(build.version),
    `prefix=${prefix}; ${oneLine(version.out)}`,
  );

  const legacy = fetchLegacyRelease(root, build.nativePackageName, legacyVersion);
  legacyBin = legacy.bin;
  const legacyVersionOut =
    legacyBin === null
      ? ""
      : run("legacy --version", join(legacyBin, "tokenmaxxing"), ["--version"]).out;
  check(
    "setup",
    `legacy release ${build.nativePackageName}@${legacyVersion}`,
    legacyVersionOut.includes(legacyVersion),
    `${legacyVersionOut} ${legacy.detail}`,
  );

  await blockProduction();

  context = {
    agentLogsDir: join(root, "agent-logs"),
    baseEnv: {
      ...processEnv(),
      ...(backend === "systemd" ? systemdUserEnv() : {}),
      npm_config_update_notifier: "false",
      // Runner auto-update checks the e2e registry (which serves this build
      // as `latest`), so every scheduled run reports "not-needed" instead of
      // failing against the blocked public registry.
      TOKENMAXXING_NPM_REGISTRY: registry.url,
    },
    sandbox,
  };
  return failedChecks().length === 0;
}

// ------------------------------------------------------------------ helpers
async function profileFor(configDir: string, bin = tmxBin): Promise<Profile> {
  run("remove old config dir", "rm", ["-rf", configDir], { quiet: true });
  return newProfile(context, configDir, [fakeBin, bin]);
}

function label(scenarioName: string) {
  return scenarioName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function install(scenarioName: string, profile: Profile): boolean {
  const result = tmx(profile, ["service", "install", "--json"]);
  const json = parseCliJson<{ backend?: string; status?: string }>(result.out);
  return check(
    scenarioName,
    "service install",
    result.code === 0 && json?.status === "ok" && json.backend === backend,
    oneLine(result.out),
  );
}

function wrapperPath(profile: Profile) {
  return configFile(profile, "tokenmaxxing.sh");
}

async function trigger(): Promise<SchedulerRun> {
  return triggerScheduledRun();
}

function scheduledRun(profile: Profile, runLabel: string, options: { touchLogs?: boolean } = {}) {
  return observeRun(context, profile, runLabel, trigger, options);
}

/** Waits for a deferred repair started after `since` to finish; returns the state. */
async function waitForRepair(profile: Profile, since: string | undefined, timeoutMs = 90_000) {
  await waitUntil(() => {
    const state = serviceState(profile);
    return (
      state?.lastRepairAttemptAt !== since &&
      (state?.lastRepairStatus === "success" || state?.lastRepairStatus === "failure")
    );
  }, timeoutMs);
  return serviceState(profile);
}

function systemdQuoted(path: string) {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

// The scheduler definition the install registered, as the scheduler sees it.
function assertDefinition(scenarioName: string, profile: Profile, keepAs: string) {
  const wrapper = wrapperPath(profile);
  const logPath = configFile(profile, "service.log");
  if (backend === "launchd") {
    const plist = launchdPlistPath();
    keep(outDir, plist, `${keepAs}.plist`);
    const lint = run("plutil -lint", "plutil", ["-lint", plist], { quiet: true });
    const converted = run(
      "plutil -convert json",
      "plutil",
      ["-convert", "json", "-o", "-", plist],
      {
        quiet: true,
      },
    );
    const parsed = parseCliJson<{
      Label?: string;
      ProgramArguments?: string[];
      StandardErrorPath?: string;
      StandardOutPath?: string;
      StartInterval?: number;
    }>(converted.stdout);
    check(scenarioName, "plist lints", lint.code === 0, oneLine(lint.out, 200));
    check(
      scenarioName,
      "plist: Label, ProgramArguments = [wrapper], StartInterval 300, log paths",
      parsed?.Label === LAUNCHD_LABEL &&
        JSON.stringify(parsed.ProgramArguments) === JSON.stringify([wrapper]) &&
        parsed.StartInterval === 300 &&
        parsed.StandardOutPath === logPath &&
        parsed.StandardErrorPath === logPath,
      oneLine(converted.stdout, 700),
    );
    const job = launchdJob();
    keep(
      outDir,
      writeTemp(`${keepAs}-launchctl-print.txt`, job.raw),
      `${keepAs}-launchctl-print.txt`,
    );
    check(
      scenarioName,
      `agent loaded in ${launchdDomain()} from the plist, every 300 s`,
      job.loaded &&
        job.raw.includes(`path = ${plist}`) &&
        /run interval = 300 seconds/.test(job.raw),
      `exit ${job.exit}; state=${job.state} runs=${job.runs}; ${oneLine(
        job.raw
          .split("\n")
          .filter((line) => /path =|run interval|program|state =/.test(line))
          .join("\n"),
        500,
      )}`,
    );
  } else {
    const unitDir = systemdUnitDir(context.baseEnv);
    const servicePath = join(unitDir, `${SYSTEMD_UNIT}.service`);
    const timerPath = join(unitDir, `${SYSTEMD_UNIT}.timer`);
    keep(outDir, servicePath, `${keepAs}.service`);
    keep(outDir, timerPath, `${keepAs}.timer`);
    const service = readText(servicePath);
    const timer = readText(timerPath);
    check(
      scenarioName,
      "service unit: oneshot running the quoted wrapper",
      service.includes("Type=oneshot") && service.includes(`ExecStart=${systemdQuoted(wrapper)}`),
      oneLine(service, 400),
    );
    check(
      scenarioName,
      "timer unit: OnBootSec/OnUnitActiveSec 5min, Persistent, timers.target",
      ["OnBootSec=5min", "OnUnitActiveSec=5min", "Persistent=true", "WantedBy=timers.target"].every(
        (line) => timer.includes(line),
      ),
      oneLine(timer, 400),
    );
    // What systemd itself parsed out of ExecStart: specifiers (%) and
    // escapes in the config path would show up here.
    const execStart = systemdShow(`${SYSTEMD_UNIT}.service`, [
      "ExecStart",
      "LoadState",
      "LoadError",
    ]);
    check(
      scenarioName,
      "systemd parses ExecStart to the wrapper path",
      execStart.LoadState === "loaded" && (execStart.ExecStart ?? "").includes(`path=${wrapper} ;`),
      `LoadState=${execStart.LoadState} LoadError=${execStart.LoadError ?? ""} ExecStart=${execStart.ExecStart ?? ""}`,
    );
    const verify = run(
      "systemd-analyze --user verify",
      "systemd-analyze",
      ["--user", "verify", servicePath, timerPath],
      { env: context.baseEnv, quiet: true },
    );
    check(
      scenarioName,
      "systemd-analyze --user verify",
      verify.code === 0,
      oneLine(verify.out, 400) || "clean",
    );
    const enabled = systemctl(["is-enabled", `${SYSTEMD_UNIT}.timer`], true).stdout;
    const active = systemctl(["is-active", `${SYSTEMD_UNIT}.timer`], true).stdout;
    check(
      scenarioName,
      "timer enabled + active",
      enabled === "enabled" && active === "active",
      `is-enabled=${enabled} is-active=${active}`,
    );
  }

  // The wrapper the scheduler runs.
  let executable = false;
  try {
    accessSync(wrapper, constants.X_OK);
    executable = true;
  } catch {
    executable = false;
  }
  const syntax = run("sh -n wrapper", "sh", ["-n", wrapper], { quiet: true });
  keep(outDir, wrapper, `${keepAs}-tokenmaxxing.sh.txt`);
  check(
    scenarioName,
    "wrapper is executable and parses",
    executable && syntax.code === 0,
    `${wrapper}; sh -n exit ${syntax.code} ${oneLine(syntax.out, 200)}`,
  );
  const exported = wrapperEnv(readText(wrapper));
  check(
    scenarioName,
    "wrapper captures config dir, source roots, registry and PATH",
    exported.TOKENMAXXING_CONFIG_DIR === profile.configDir &&
      exported.CLAUDE_CONFIG_DIR === profile.env.CLAUDE_CONFIG_DIR &&
      exported.CODEX_HOME === profile.env.CODEX_HOME &&
      exported.TOKENMAXXING_NPM_REGISTRY === registry!.url &&
      (exported.PATH ?? "").startsWith(`${fakeBin}:`),
    oneLine(JSON.stringify(exported), 700),
  );

  const meta = serviceJson(profile);
  check(
    scenarioName,
    `service.json at template ${templateVersion}`,
    meta?.templateVersion === templateVersion && meta.backend === backend,
    `templateVersion=${meta?.templateVersion} backend=${String(meta?.backend)} runner=${String(meta?.runnerPath)} target=${String(meta?.runnerTarget)}`,
  );
  const runner = readText(configFile(profile, "service-runner-current")).trim();
  const runnerVersion =
    runner === "" ? { out: "" } : run("runner --version", runner, ["--version"], { quiet: true });
  check(
    scenarioName,
    "runner pointer -> a runner of this build",
    runner.startsWith(join(profile.configDir, "service-runners")) &&
      runnerVersion.out.includes(build.version),
    `${runner}: ${oneLine(runnerVersion.out, 100)}`,
  );
}

async function assertStatusAndDoctor(scenarioName: string, profile: Profile) {
  const status = parseCliJson<{
    backend?: string;
    installed?: boolean;
    lastSyncStatus?: string;
    reloadRequired?: boolean;
    runnerVersion?: string;
    scheduler?: { active?: boolean; detail?: string };
    templateVersion?: number;
  }>(tmx(profile, ["service", "status", "--json"]).out);
  check(
    scenarioName,
    "status --json: installed, scheduler active, current template and runner",
    status?.installed === true &&
      status.backend === backend &&
      status.scheduler?.active === true &&
      status.reloadRequired === false &&
      status.templateVersion === templateVersion &&
      status.runnerVersion === build.version,
    oneLine(JSON.stringify(status), 700),
  );
  const doctor = tmx(profile, ["service", "doctor"]);
  const line = (name: string) =>
    doctor.out
      .split(/\r?\n/)
      .find((text) => new RegExp(`^\\s*(OK|WARN|INFO)\\s+${name}\\b`).test(text)) ?? "";
  const expectedOk = [
    "scheduler",
    "active",
    "template",
    "definition",
    "wrapper",
    "source roots",
    "runner",
    "metadata",
    "auth",
    "auto-update",
  ];
  const notOk = expectedOk.filter((name) => !/^\s*OK\b/.test(line(name)));
  check(
    scenarioName,
    `doctor: OK for ${expectedOk.join(", ")}`,
    doctor.code === 0 && notOk.length === 0,
    notOk.length === 0
      ? oneLine(expectedOk.map(line).join("\n"), 900)
      : `not OK: ${notOk.map((name) => line(name) || `${name} (missing)`).join(" | ")}`,
  );
}

async function assertReloadRequiredRepair(
  scenarioName: string,
  profile: Profile,
  runLabel: string,
) {
  setTemplateVersion(profile, templateVersion - 1);
  const before = serviceState(profile)?.lastRepairAttemptAt as string | undefined;
  const reload = await scheduledRun(profile, `${runLabel}-reload-required`);
  check(
    scenarioName,
    "run reports reloadRequired",
    reload.line?.reloadRequired === true && reload.line.status === "success",
    oneLine(JSON.stringify(reload.line), 400),
  );
  const state = await waitForRepair(profile, before);
  const meta = serviceJson(profile);
  check(
    scenarioName,
    `deferred reload-required repair restores template ${templateVersion}`,
    state?.lastRepairStatus === "success" &&
      state.lastRepairReason === "reload-required" &&
      meta?.templateVersion === templateVersion,
    `status=${state?.lastRepairStatus} reason=${state?.lastRepairReason} error=${state?.lastRepairError ?? ""} templateVersion=${meta?.templateVersion}`,
  );
  assertSchedulerStillRegistered(scenarioName);
  const next = await scheduledRun(profile, `${runLabel}-after-reload`);
  assertSuccessfulRun(scenarioName, next, { allowCooldown: true });
  check(
    scenarioName,
    "next run no longer reports reloadRequired",
    next.line?.reloadRequired === false,
    oneLine(JSON.stringify(next.line), 300),
  );
}

function assertSchedulerStillRegistered(scenarioName: string) {
  if (backend === "launchd") {
    const job = launchdJob();
    check(scenarioName, "agent still loaded", job.loaded, `state=${job.state} runs=${job.runs}`);
  } else {
    const active = systemctl(["is-active", `${SYSTEMD_UNIT}.timer`], true).stdout;
    check(scenarioName, "timer still active", active === "active", `is-active=${active}`);
  }
}

function assertUninstall(scenarioName: string, profile: Profile) {
  const result = tmx(profile, ["service", "uninstall", "--json"]);
  check(scenarioName, "service uninstall", result.code === 0, oneLine(result.out, 300));
  if (backend === "launchd") {
    const job = launchdJob();
    check(
      scenarioName,
      "agent unloaded and plist removed",
      !job.loaded && !existsSync(launchdPlistPath()),
      `launchctl print exit ${job.exit}; plist exists=${existsSync(launchdPlistPath())}`,
    );
  } else {
    const unitDir = systemdUnitDir(context.baseEnv);
    const left = [`${SYSTEMD_UNIT}.service`, `${SYSTEMD_UNIT}.timer`].filter((name) =>
      existsSync(join(unitDir, name)),
    );
    const active = systemctl(["is-active", `${SYSTEMD_UNIT}.timer`], true).stdout;
    const load = systemdShow(`${SYSTEMD_UNIT}.timer`, ["LoadState"]).LoadState;
    check(
      scenarioName,
      "timer stopped and units removed",
      left.length === 0 && active !== "active" && load === "not-found",
      `left=[${left.join(", ")}] is-active=${active} LoadState=${load}`,
    );
  }
  const leftovers = [
    "tokenmaxxing.sh",
    "service.json",
    "service-state.json",
    "service-runner-current",
    "service-runners",
  ].filter((name) => existsSync(configFile(profile, name)));
  check(
    scenarioName,
    "wrapper, metadata, state and runners removed; login kept",
    leftovers.length === 0 && existsSync(configFile(profile, "config.json")),
    `left: [${leftovers.join(", ")}] config.json=${existsSync(configFile(profile, "config.json"))}`,
  );
}

// ------------------------------------------------------------------ scenarios
async function core() {
  const name = "core";
  const profile = await profileFor(join(root, "cfg-core"));
  let bootstrapAt = 0;

  if (backend === "systemd") {
    // Positive control: the timer's OnBootSec has long passed on a CI runner,
    // so enabling it starts a run with nobody asking for one. Nothing below
    // starts the service before this run is seen.
    const first = await observeRun(context, profile, "core-timer-first-run", async () => {
      const installedAt = Date.now();
      if (!install(name, profile)) {
        return { detail: "install failed", exitCode: null, finished: false, seconds: 0 };
      }
      const fired = await waitForSystemdRun(6.5 * 60_000);
      const timer = systemdShow(`${SYSTEMD_UNIT}.timer`, [
        "LastTriggerUSec",
        "NextElapseUSecMonotonic",
      ]);
      return {
        detail: `timer LastTrigger=${timer.LastTriggerUSec} Next=${timer.NextElapseUSecMonotonic}; service Result=${fired?.Result} ExecMainStatus=${fired?.ExecMainStatus}`,
        exitCode: fired?.ExecMainStatus ?? null,
        finished: fired !== undefined,
        seconds: Math.round((Date.now() - installedAt) / 1000),
      };
    });
    const timer = systemdShow(`${SYSTEMD_UNIT}.timer`, ["LastTriggerUSec"]);
    check(
      name,
      "the timer started a run on its own (positive control)",
      first.scheduler.finished && timer.LastTriggerUSec !== "" && timer.LastTriggerUSec !== "n/a",
      `${first.scheduler.detail}; ${first.scheduler.seconds}s after install`,
    );
    assertSuccessfulRun(name, first);
  } else {
    if (!install(name, profile)) {
      return;
    }
    bootstrapAt = Date.now();
    const job = launchdJob();
    check(
      name,
      "no run at load (no RunAtLoad)",
      job.loaded && job.runs === 0,
      `state=${job.state} runs=${job.runs}`,
    );
  }
  assertDefinition(name, profile, "core");

  const run1 = await scheduledRun(profile, "core-run");
  assertSuccessfulRun(name, run1, { allowCooldown: backend === "systemd" });
  const usage = await sandbox!.usageRows(profile.userId);
  check(
    name,
    "ingested usage stored in the sandbox",
    usage.length > 0,
    `${usage.length} usage_days rows: ${usage.map((row) => `${row.date}/${row.source}`).join(", ")}`,
  );
  check(
    name,
    "runner auto-update checked the e2e registry: not-needed",
    (run1.line?.autoUpdate as { status?: string } | undefined)?.status === "not-needed",
    oneLine(JSON.stringify(run1.line?.autoUpdate), 300),
  );
  await assertStatusAndDoctor(name, profile);

  // Error paths keep the wrapper's exit codes through the scheduler.
  const pointer = configFile(profile, "service-runner-current");
  const runnerPath = readText(pointer).trim();
  renameSync(pointer, `${pointer}.bak`);
  const noPointer = await scheduledRun(profile, "core-no-pointer");
  renameSync(`${pointer}.bak`, pointer);
  check(
    name,
    "exit 127 when the runner pointer is missing",
    noPointer.scheduler.exitCode === "127" && noPointer.logDelta.includes("runner pointer missing"),
    `${noPointer.scheduler.detail}; ${oneLine(noPointer.logDelta, 300)}`,
  );
  renameSync(runnerPath, `${runnerPath}.bak`);
  const noRunner = await scheduledRun(profile, "core-no-runner");
  renameSync(`${runnerPath}.bak`, runnerPath);
  check(
    name,
    "exit 127 when the runner is missing",
    noRunner.scheduler.exitCode === "127" &&
      noRunner.logDelta.includes("runner missing or not executable"),
    `${noRunner.scheduler.detail}; ${oneLine(noRunner.logDelta, 300)}`,
  );

  // A failed sync (revoked token) starts a deferred service-failure repair.
  const beforeFailure = serviceState(profile)?.lastRepairAttemptAt as string | undefined;
  await sandbox!.revoke(profile.userId, true);
  const failed = await scheduledRun(profile, "core-service-failure");
  const failureState = await waitForRepair(profile, beforeFailure);
  await sandbox!.revoke(profile.userId, false);
  check(
    name,
    "failed sync logged and exited nonzero",
    failed.line?.status === "failure" && failed.scheduler.exitCode !== "0",
    `${failed.scheduler.detail}; ${oneLine(JSON.stringify(failed.line), 300)}`,
  );
  check(
    name,
    "failed sync runs a deferred service-failure repair",
    failureState?.lastRepairReason === "service-failure" &&
      failureState.lastRepairStatus === "success",
    `reason=${failureState?.lastRepairReason} status=${failureState?.lastRepairStatus} error=${failureState?.lastRepairError ?? ""}`,
  );
  assertSchedulerStillRegistered(name);
  const recovered = await scheduledRun(profile, "core-recovered");
  assertSuccessfulRun(name, recovered, { allowCooldown: true });

  await assertReloadRequiredRepair(name, profile, "core");

  if (backend === "launchd") {
    // Positive control: launchd starts the agent on its StartInterval with no
    // kickstart. Kickstarts do not move the interval, so the first one lands
    // about 300 s after bootstrap.
    const job = launchdJob();
    const interval = await observeRun(context, profile, "core-interval", async () => {
      const waitedFrom = Date.now();
      const fired = await waitForLaunchdRun(
        job.runs,
        Math.max(60_000, bootstrapAt + 400_000 - Date.now()),
      );
      return {
        detail: `launchd runs ${job.runs} -> ${fired?.runs ?? "?"}; last exit code ${fired?.lastExitCode ?? "?"}; fired ${fired ? Math.round((Date.now() - bootstrapAt) / 1000) : "?"} s after bootstrap`,
        exitCode: fired?.lastExitCode ?? null,
        finished: fired !== undefined,
        seconds: Math.round((Date.now() - waitedFrom) / 1000),
      };
    });
    check(
      name,
      "launchd started the agent on its interval (positive control)",
      interval.scheduler.finished,
      interval.scheduler.detail,
    );
    assertSuccessfulRun(name, interval);
  }

  assertUninstall(name, profile);
}

async function pathCase(name: string, configDir: string) {
  const keepAs = label(name);
  const profile = await profileFor(configDir);
  if (!install(name, profile)) {
    return;
  }
  if (backend === "systemd") {
    // Let the timer's own first run finish before triggering ours.
    await waitForSystemdRun(30_000);
  }
  assertDefinition(name, profile, keepAs);
  const first = await scheduledRun(profile, `${keepAs}-run`);
  assertSuccessfulRun(name, first, { allowCooldown: backend === "systemd" });
  if (first.line?.status === "success") {
    await assertReloadRequiredRepair(name, profile, keepAs);
  }
  assertUninstall(name, profile);
}

async function installLegacy(name: string, configDir: string): Promise<Profile | null> {
  const profile = await profileFor(configDir, legacyBin!);
  if (!install(name, profile)) {
    return null;
  }
  const meta = serviceJson(profile);
  check(
    name,
    `legacy install is below template ${templateVersion}`,
    (meta?.templateVersion ?? 0) < templateVersion && meta?.runnerVersion === legacyVersion,
    `templateVersion=${meta?.templateVersion} runnerVersion=${meta?.runnerVersion}`,
  );
  if (backend === "systemd") {
    await waitForSystemdRun(30_000);
  }
  const legacyRun = await scheduledRun(profile, `${label(name)}-legacy-run`);
  assertSuccessfulRun(name, legacyRun, { allowCooldown: backend === "systemd" });
  return profile;
}

/**
 * What a runner auto-update leaves behind (runServiceRunnerAutoUpdate): the
 * new runner staged under service-runners/<version>/<target>/, the pointer
 * moved to it and service.json's runner fields updated. The old runner
 * writes service.json, so templateVersion stays at its own (older) value.
 */
function stageRunnerLikeAutoUpdate(profile: Profile) {
  const destination = join(
    profile.configDir,
    "service-runners",
    build.version,
    build.target,
    "tokenmaxxing",
  );
  mkdirSync(dirname(destination), { recursive: true });
  run("stage runner", "cp", [build.nativeExe, destination], { quiet: true });
  run("chmod runner", "chmod", ["755", destination], { quiet: true });
  writeFileSync(configFile(profile, "service-runner-current"), `${destination}\n`);
  const meta = serviceJson(profile)!;
  writeFileSync(
    configFile(profile, "service.json"),
    `${JSON.stringify(
      {
        ...meta,
        autoUpdateManager: "registry",
        commandPath: destination,
        runnerPackage: build.nativePackageName,
        runnerPath: destination,
        runnerTarget: build.target,
        runnerVersion: build.version,
      },
      null,
      2,
    )}\n`,
  );
}

async function legacyUpgrade() {
  // (1) Runner auto-update: the next scheduled run of the new runner under
  // the old template reports reload-required, and its deferred repair
  // rewrites the service files (and, on systemd, re-registers the units).
  let name = "legacy upgrade (auto-update)";
  let profile = await installLegacy(name, join(root, "cfg-legacy"));
  if (profile === null) {
    return;
  }
  const oldWrapper = readText(wrapperPath(profile));
  const oldWrapperMtime = statSync(wrapperPath(profile)).mtimeMs;
  stageRunnerLikeAutoUpdate(profile);
  const before = serviceState(profile)?.lastRepairAttemptAt as string | undefined;
  const upgraded = await scheduledRun(profile, "legacy-upgraded-run");
  check(
    name,
    "upgraded runner syncs under the old service files",
    upgraded.line?.status === "success" && upgraded.line.version === build.version,
    oneLine(JSON.stringify(upgraded.line), 400),
  );
  check(
    name,
    "run reports reloadRequired",
    upgraded.line?.reloadRequired === true,
    oneLine(JSON.stringify(upgraded.line), 300),
  );
  const state = await waitForRepair(profile, before);
  const newWrapper = readText(wrapperPath(profile));
  check(
    name,
    `deferred repair migrates to template ${templateVersion}`,
    state?.lastRepairStatus === "success" &&
      state.lastRepairReason === "reload-required" &&
      serviceJson(profile)?.templateVersion === templateVersion,
    `status=${state?.lastRepairStatus} reason=${state?.lastRepairReason} error=${state?.lastRepairError ?? ""} templateVersion=${serviceJson(profile)?.templateVersion}`,
  );
  keep(outDir, writeTemp("legacy-wrapper-before.txt", oldWrapper), "legacy-wrapper-before.txt");
  keep(outDir, wrapperPath(profile), "legacy-wrapper-after.txt");
  // Templates 5 and 6 render the same POSIX wrapper, so the rewrite shows in
  // the mtime rather than the content.
  check(
    name,
    "repair rewrote the wrapper",
    statSync(wrapperPath(profile)).mtimeMs > oldWrapperMtime &&
      newWrapper.includes("tokenmaxxing service sync"),
    `${oldWrapper.length} -> ${newWrapper.length} bytes; ${newWrapper === oldWrapper ? "same content" : "content changed"}`,
  );
  if (backend === "systemd") {
    // The deferred repair runs in its own transient unit and re-registers.
    const journal = run(
      "journalctl repair unit",
      "journalctl",
      ["--user", "--no-pager", "-o", "cat", "-u", `${SYSTEMD_UNIT}-repair-reload-required`],
      { env: context.baseEnv, quiet: true },
    );
    check(
      name,
      "repair ran in its transient systemd unit",
      journal.out
        .split("\n")
        .some((line) => line.startsWith("Started") && line.includes(profile!.configDir)),
      oneLine(
        journal.out
          .split("\n")
          .filter((line) => line.includes(profile!.configDir))
          .join("\n"),
        400,
      ),
    );
  }
  assertSchedulerStillRegistered(name);
  const next = await scheduledRun(profile, "legacy-after-upgrade");
  assertSuccessfulRun(name, next, { allowCooldown: true });
  check(
    name,
    "next run is clean",
    next.line?.reloadRequired === false,
    oneLine(JSON.stringify(next.line), 300),
  );
  tmx(profile, ["service", "uninstall", "--json"]);

  // (2) `service repair` from the new CLI migrates a legacy install at once
  // and re-registers it with the scheduler.
  name = "legacy upgrade (service repair)";
  profile = await installLegacy(name, join(root, "cfg-legacy-repair"));
  if (profile === null) {
    return;
  }
  const runsBefore = backend === "launchd" ? launchdJob().runs : 0;
  const activeBefore =
    backend === "systemd"
      ? systemdShow(`${SYSTEMD_UNIT}.timer`, ["ActiveEnterTimestampMonotonic"])
          .ActiveEnterTimestampMonotonic
      : "";
  const repairProfile = {
    ...profile,
    env: { ...profile.env, PATH: [fakeBin, tmxBin, context.baseEnv.PATH].join(":") },
  };
  const repair = tmx(repairProfile, ["service", "repair", "--json"]);
  const repairJson = parseCliJson<{ active?: boolean; status?: string }>(repair.out);
  check(
    name,
    "service repair",
    repair.code === 0 && repairJson?.status === "ok" && repairJson.active === true,
    oneLine(repair.out, 400),
  );
  check(
    name,
    `service.json at template ${templateVersion}`,
    serviceJson(profile)?.templateVersion === templateVersion &&
      serviceJson(profile)?.runnerVersion === build.version,
    `templateVersion=${serviceJson(profile)?.templateVersion} runnerVersion=${serviceJson(profile)?.runnerVersion}`,
  );
  if (backend === "launchd") {
    const job = launchdJob();
    check(
      name,
      "repair re-bootstrapped the agent (launchd run count reset)",
      job.loaded && job.runs < runsBefore,
      `runs ${runsBefore} -> ${job.runs}`,
    );
  } else {
    const activeAfter = systemdShow(`${SYSTEMD_UNIT}.timer`, [
      "ActiveEnterTimestampMonotonic",
      "ActiveState",
    ]);
    check(
      name,
      "repair left the timer registered and active",
      activeAfter.ActiveState === "active",
      `ActiveEnter ${activeBefore} -> ${activeAfter.ActiveEnterTimestampMonotonic}`,
    );
  }
  assertDefinition(name, repairProfile, "legacy-repaired");
  const repaired = await scheduledRun(repairProfile, "legacy-repaired-run");
  assertSuccessfulRun(name, repaired, { allowCooldown: true });
  assertUninstall(name, repairProfile);
}

// ------------------------------------------------------------------ main
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeTemp(name: string, text: string): string {
  const path = join(root, "tmp", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Reads back the `export KEY='value'` lines of a POSIX wrapper. */
function wrapperEnv(wrapper: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of wrapper.split("\n")) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
    if (match !== null) {
      env[match[1]!] = match[2]!.replaceAll("'\\''", "'");
    }
  }
  return env;
}

function uninstallAll() {
  if (backend === "launchd") {
    run("launchctl bootout", "launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`], {
      quiet: true,
    });
    run("remove plist", "rm", ["-f", launchdPlistPath()], { quiet: true });
  } else {
    systemctl(["disable", "--now", `${SYSTEMD_UNIT}.timer`], true);
    run(
      "remove units",
      "rm",
      [
        "-f",
        join(systemdUnitDir(), `${SYSTEMD_UNIT}.service`),
        join(systemdUnitDir(), `${SYSTEMD_UNIT}.timer`),
      ],
      { quiet: true },
    );
    systemctl(["daemon-reload"], true);
  }
}

try {
  if (await setup()) {
    uninstallAll();
    await scenario("core", core);
    const pathCases: Record<string, string> =
      backend === "launchd"
        ? {
            [`Application Support + non-ASCII (${zoe} (Work))`]: join(
              home,
              "Library",
              "Application Support",
              `${zoe} (Work)`,
              "tm",
            ),
            [`everything path (${zoe} O'Neil (Work) & Co 100%)`]: join(
              root,
              `${zoe} O'Neil (Work) & Co 100%`,
              "tm",
            ),
          }
        : {
            [`spaces + non-ASCII (${zoe} (Work))`]: join(home, ".config", `${zoe} (Work)`, "tm"),
            [`everything path (${zoe} O'Neil (Work) & Co 100%)`]: join(
              root,
              `${zoe} O'Neil (Work) & Co 100%`,
              "tm",
            ),
          };
    for (const [name, dir] of Object.entries(pathCases)) {
      await scenario(name, () => pathCase(name, dir));
    }
    if (legacyBin !== null) {
      await scenario("legacy upgrade", legacyUpgrade);
    } else {
      check(
        "legacy upgrade",
        "legacy release available",
        false,
        "the pinned legacy release could not be downloaded",
      );
    }
    uninstallAll();
    check("service", "all scenarios ran", true, "");
  } else {
    console.log("::error::setup failed; skipping the service scenarios");
  }
} catch (error) {
  check(
    "setup",
    "harness ran without errors",
    false,
    oneLine(error instanceof Error ? `${error.message} ${error.stack}` : String(error)),
  );
} finally {
  keep(outDir, join(fakeBin, "calls.log"), "fake-ccusage-calls.log");
  if (sandbox !== undefined) {
    writeFileSync(
      join(outDir, "sandbox-requests.json"),
      JSON.stringify(await sandbox.requests().catch(() => []), null, 2),
    );
  }
  if (backend === "systemd") {
    const journal = run("journalctl --user", "journalctl", ["--user", "--no-pager", "-n", "400"], {
      env: { ...process.env, ...systemdUserEnv() },
      quiet: true,
    });
    writeFileSync(join(outDir, "journal-user.txt"), journal.out);
  }
  sandbox?.process.kill();
  registry?.process.kill();
  unblockProduction();
}

if (!readText(join(outDir, "results.jsonl")).includes('"all scenarios ran"')) {
  check(
    "setup",
    "service scenarios completed",
    false,
    "service-e2e.ts never reached its end; see the failures above and service.log",
  );
}
summarize(outDir, title);
process.exit(failedChecks().length > 0 ? 1 : 0);
