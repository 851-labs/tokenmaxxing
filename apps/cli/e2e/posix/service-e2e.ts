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
 *   hanging ccusage a full run whose ccusage hangs (npx on a black-holed network)
 *                   stops after the first timeout, records why, and the next
 *                   run syncs the rest
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
  fileSize,
  readFrom,
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
  type RunObservation,
  type ServiceContext,
} from "../shared/service";
import { summarize } from "../shared/summarize";

const build = readBuild(requiredFlag("build"));
// Not under the OS temp dir: a service install drops temporary directories from
// the PATH it captures, and the fake bun lives under the root.
const root = flag("root") ?? join(process.env.RUNNER_TEMP ?? join(homedir(), ".cache"), "tmx-e2e");
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
      service.includes("Type=oneshot") &&
        (service.includes(`ExecStart=${systemdQuoted(wrapper)}\n`) ||
          // Paths with quotes or backslashes run as /bin/sh's argument.
          (/["'\\]/.test(wrapper) &&
            service.includes(`ExecStart=/bin/sh ${systemdQuoted(wrapper)}\n`))),
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
      execStart.LoadState === "loaded" &&
        (execStart.ExecStart ?? "").includes(`argv[]=`) &&
        (execStart.ExecStart ?? "").includes(`${wrapper} ;`),
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
      .find((text) => new RegExp(`^\\s*(OK|WARN|FAIL|INFO)\\s+${name}\\b`).test(text)) ?? "";
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
  // Scripts gate on the exit code, or on `health` under --json.
  const doctorJson = tmx(profile, ["service", "doctor", "--json"]);
  const report = parseCliJson<{
    checks?: Array<{ label?: string; status?: string }>;
    health?: string;
  }>(doctorJson.out);
  check(
    scenarioName,
    "doctor --json: health ok, exit 0, no WARN or FAIL check",
    doctorJson.code === 0 &&
      report?.health === "ok" &&
      (report.checks ?? []).every((entry) => entry.status === "ok" || entry.status === "info"),
    `exit ${doctorJson.code}: ${oneLine(doctorJson.out, 900)}`,
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

function fileStamp(path: string): string {
  try {
    const info = statSync(path);
    return `ino ${info.ino} mtime ${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function definitionFiles(): string[] {
  return backend === "launchd"
    ? [launchdPlistPath()]
    : [
        join(systemdUnitDir(context.baseEnv), `${SYSTEMD_UNIT}.service`),
        join(systemdUnitDir(context.baseEnv), `${SYSTEMD_UNIT}.timer`),
      ];
}

function userJournalSince(epochSeconds: number): string {
  return run(
    "journalctl --user",
    "journalctl",
    ["--user", "--no-pager", "-o", "cat", "--since", `@${epochSeconds}`],
    { env: { ...process.env, ...systemdUserEnv() }, quiet: true },
  ).out;
}

// macOS Background Task Management re-posts "can run in the background" when
// the plist or the program it runs is replaced or its mtime changes, even with
// the same bytes, so a refresh that changes nothing must leave both alone and
// must not reload the job. A scheduler that is actually broken still gets
// re-registered by repair.
async function assertUnchangedRefresh(scenarioName: string, profile: Profile) {
  const tracked = [...definitionFiles(), wrapperPath(profile)];
  const before = tracked.map(fileStamp);
  const runsBefore = backend === "launchd" ? launchdJob().runs : 0;
  const timerBefore =
    backend === "systemd"
      ? systemdShow(`${SYSTEMD_UNIT}.timer`, ["ActiveEnterTimestampMonotonic"])
          .ActiveEnterTimestampMonotonic
      : "";
  const since = Math.floor(Date.now() / 1000);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const refresh = tmx(profile, ["service", "install", "--refresh", "--json"]);
  const json = parseCliJson<{ status?: string }>(refresh.out);
  check(
    scenarioName,
    "service install --refresh",
    refresh.code === 0 && json?.status === "ok",
    oneLine(refresh.out, 300),
  );
  const after = tracked.map(fileStamp);
  check(
    scenarioName,
    "unchanged refresh leaves the definition and wrapper untouched (inode + mtime)",
    after.every((stamp, index) => stamp === before[index] && stamp !== "missing"),
    tracked.map((path, index) => `${path}: ${before[index]} -> ${after[index]}`).join("; "),
  );

  if (backend === "launchd") {
    const job = launchdJob();
    check(
      scenarioName,
      "unchanged refresh did not reload the agent (launchd run count kept)",
      runsBefore > 0 && job.loaded && job.runs === runsBefore,
      `runs ${runsBefore} -> ${job.runs}; state=${job.state}`,
    );
  } else {
    const timer = systemdShow(`${SYSTEMD_UNIT}.timer`, [
      "ActiveEnterTimestampMonotonic",
      "ActiveState",
      "NeedDaemonReload",
    ]);
    const journal = userJournalSince(since);
    check(
      scenarioName,
      "unchanged refresh ran no daemon-reload and left the timer running",
      !/Reloading/.test(journal) &&
        timer.ActiveState === "active" &&
        timer.NeedDaemonReload === "no" &&
        timer.ActiveEnterTimestampMonotonic === timerBefore,
      `ActiveEnter ${timerBefore} -> ${timer.ActiveEnterTimestampMonotonic}; NeedDaemonReload=${timer.NeedDaemonReload}; journal: ${oneLine(journal, 300) || "(empty)"}`,
    );
    // Positive control: a daemon-reload does show up in the user journal.
    const controlSince = Math.floor(Date.now() / 1000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    systemctl(["daemon-reload"], true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    check(
      scenarioName,
      "a daemon-reload is visible in the user journal (positive control)",
      /Reloading/.test(userJournalSince(controlSince)),
      oneLine(userJournalSince(controlSince), 300),
    );
  }

  // Repair still re-registers a scheduler that lost the job, with every file unchanged.
  if (backend === "launchd") {
    run("launchctl bootout", "launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`], {
      quiet: true,
    });
  } else {
    systemctl(["disable", "--now", `${SYSTEMD_UNIT}.timer`], true);
  }
  const repair = tmx(profile, ["service", "repair", "--json"]);
  const repairJson = parseCliJson<{ active?: boolean; status?: string }>(repair.out);
  const reloaded =
    backend === "launchd"
      ? launchdJob().loaded
      : systemctl(["is-active", `${SYSTEMD_UNIT}.timer`], true).stdout === "active" &&
        systemctl(["is-enabled", `${SYSTEMD_UNIT}.timer`], true).stdout === "enabled";
  check(
    scenarioName,
    "repair re-registers an unloaded job whose files are unchanged",
    repair.code === 0 && repairJson?.status === "ok" && repairJson.active === true && reloaded,
    oneLine(repair.out, 300),
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
  await assertUnchangedRefresh(name, profile);

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
    // kickstart. The interval counts from the job's last start (a kickstart
    // included), so the run lands about 300 s after the last one above.
    const job = launchdJob();
    const lastRunAt = Date.now();
    const interval = await observeRun(context, profile, "core-interval", async () => {
      const waitedFrom = Date.now();
      const fired = await waitForLaunchdRun(job.runs, 360_000);
      return {
        detail: `launchd runs ${job.runs} -> ${fired?.runs ?? "?"}; last exit code ${fired?.lastExitCode ?? "?"}; fired ${fired ? Math.round((Date.now() - lastRunAt) / 1000) : "?"} s after the last triggered run, ${fired ? Math.round((Date.now() - bootstrapAt) / 1000) : "?"} s after bootstrap`,
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

// A full run (no service-sources.json: the first after every CLI update)
// whose ccusage hangs. It used to wait out every source's 180 s timeout in
// turn: 54 minutes for 18 sources, which systemd killed at 30 with nothing
// recorded. Now the run stops after the first timeout and says so.
async function hangingCcusage() {
  const name = "hanging ccusage";
  const profile = await profileFor(join(root, "cfg-hang"));
  if (!install(name, profile)) {
    return;
  }
  if (backend === "systemd") {
    await waitForSystemdRun(60_000);
  }
  // The first run after an install may be the one-time codex-only usage
  // backfill; get it done so the hung run below covers every source.
  const warmup = await scheduledRun(profile, "hang-warmup");
  assertSuccessfulRun(name, warmup, { allowCooldown: true });
  check(
    name,
    "the usage backfill is done before the hung run",
    serviceState(profile)?.usageReplacementBackfillVersion !== undefined,
    oneLine(JSON.stringify(warmup.line?.sources), 300),
  );
  const hangFile = join(fakeBin, "hang");
  const callsLog = join(fakeBin, "calls.log");
  rmSync(configFile(profile, "service-sources.json"), { force: true });
  const callsBefore = fileSize(callsLog);
  writeFileSync(hangFile, "");
  let hung: RunObservation;
  try {
    hung = await observeRun(context, profile, "hang-full-run", () => triggerScheduledRun(330_000));
  } finally {
    rmSync(hangFile, { force: true });
  }

  check(
    name,
    "the run ends after one ccusage timeout, not one per source",
    hung.scheduler.finished && hung.scheduler.exitCode !== "0" && hung.scheduler.seconds < 300,
    `${hung.scheduler.detail}; ${hung.scheduler.seconds}s`,
  );
  const calls = readFrom(callsLog, callsBefore)
    .split("\n")
    .filter((line) => line.includes(" bun pid="));
  check(
    name,
    "ccusage ran once (claude daily)",
    calls.length === 1,
    oneLine(calls.join(" | "), 400),
  );
  const sources = (hung.line?.sources ?? []) as Array<{
    issue?: { code?: string };
    reason?: string;
    source?: string;
    status?: string;
  }>;
  const [first, ...rest] = sources;
  const error = typeof hung.line?.error === "string" ? hung.line.error : "";
  check(
    name,
    "service.log records the timeout and the sources left for the next run",
    hung.line?.status === "failure" &&
      first?.source === "claude" &&
      first.issue?.code === "command_timed_out" &&
      rest.length > 0 &&
      rest.every((source) => source.status === "skipped" && source.reason === "runner_timed_out") &&
      error === `ccusage timed out for claude; skipped ${rest.length} sources until the next run`,
    oneLine(JSON.stringify(hung.line), 900),
  );
  check(
    name,
    "state records the error",
    serviceState(profile)?.lastError === error,
    String(serviceState(profile)?.lastError),
  );
  const leftovers = run("pgrep hung child", "pgrep", ["-f", "sleep 86399"], { quiet: true });
  check(
    name,
    "the hung process group is gone and the lock released",
    leftovers.code !== 0 && !existsSync(configFile(profile, "service.lock")),
    `pgrep exit ${leftovers.code}: ${oneLine(leftovers.stdout, 200)}; lock exists=${existsSync(configFile(profile, "service.lock"))}`,
  );
  const doctor = tmx(profile, ["service", "doctor"]);
  check(
    name,
    "doctor warns with the run's error and exits 1",
    /^\s*WARN\s+last error\s+ccusage timed out for claude/m.test(doctor.out) && doctor.code === 1,
    `exit ${doctor.code}: ${oneLine(doctor.out.split(/\r?\n/).find((line) => line.includes("last error")) ?? "", 300)}`,
  );

  // The timed-out source cools down; the ones it left behind run now.
  const next = await scheduledRun(profile, "hang-recovered");
  assertSuccessfulRun(name, next, { allowCooldown: true });
  const nextSources = (next.line?.sources ?? []) as Array<{ source?: string; status?: string }>;
  check(
    name,
    "the next run syncs the sources the hung run skipped",
    nextSources.find((source) => source.source === "codex")?.status === "synced" &&
      next.line?.error === undefined,
    oneLine(JSON.stringify(next.line), 900),
  );
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
  // Templates 5 and 6 render the same POSIX wrapper; only the captured PATH
  // can differ. Repair rewrites a wrapper whose bytes changed and leaves an
  // identical one alone: macOS treats a rewritten program (even with the same
  // bytes, or only a new mtime) as a new background item and notifies again.
  const wrapperChanged = newWrapper !== oldWrapper;
  const wrapperMtime = statSync(wrapperPath(profile)).mtimeMs;
  check(
    name,
    wrapperChanged
      ? "repair rewrote the changed wrapper"
      : "repair left the identical wrapper untouched",
    newWrapper.includes("tokenmaxxing service sync") &&
      (wrapperChanged ? wrapperMtime > oldWrapperMtime : wrapperMtime === oldWrapperMtime),
    `${oldWrapper.length} -> ${newWrapper.length} bytes; ${wrapperChanged ? "content changed" : "same content"}; mtime ${oldWrapperMtime} -> ${wrapperMtime}`,
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
  const plistBefore = backend === "launchd" ? readText(launchdPlistPath()) : "";
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
    // The plist has rendered the same since before the legacy release, so the
    // loaded job already matches it and repair must not re-bootstrap it (a
    // re-bootstrap resets the run count). A changed plist must be reloaded.
    const job = launchdJob();
    const plistChanged = readText(launchdPlistPath()) !== plistBefore;
    check(
      name,
      plistChanged
        ? "repair re-bootstrapped the agent for its changed plist (launchd run count reset)"
        : "repair left the unchanged, loaded agent alone (launchd run count kept)",
      job.loaded && (plistChanged ? job.runs < runsBefore : job.runs === runsBefore),
      `plist changed=${plistChanged}; runs ${runsBefore} -> ${job.runs}`,
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
    await scenario("hanging ccusage", hangingCcusage);
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
            [`spaces + non-ASCII + % (${zoe} (Work) 100%)`]: join(
              home,
              ".config",
              `${zoe} (Work) 100%`,
              "tm",
            ),
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
