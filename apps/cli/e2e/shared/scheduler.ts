/**
 * Drives the real OS scheduler the CLI registers with: launchd (gui/<uid>
 * domain) on macOS, `systemd --user` on Linux and Task Scheduler on Windows.
 * Used by posix/service-e2e.ts and upgrade/upgrade-e2e.ts to make the
 * scheduler itself start a sync, and to tell when that run has finished.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { oneLine, run, type RunResult, sleep, waitUntil } from "./harness";

const LAUNCHD_LABEL = "sh.tokenmaxxing.sync";
const SYSTEMD_UNIT = "tokenmaxxing-sync";
const WINDOWS_TASK = "tokenmaxxing-sync";

type Backend = "launchd" | "systemd" | "windows-task-scheduler";

interface LaunchdJob {
  exit: number;
  lastExitCode: string | null;
  loaded: boolean;
  raw: string;
  runs: number;
  state: string | null;
}

interface SchedulerRun {
  /** Seconds from trigger to the run finishing. */
  seconds: number;
  /** What the scheduler reports for the run (exit code / result). */
  detail: string;
  /** False when the run never finished within the timeout. */
  finished: boolean;
  /** The scheduler's own exit status for the run, when it reports one. */
  exitCode: string | null;
}

const backend: Backend =
  process.platform === "darwin"
    ? "launchd"
    : process.platform === "win32"
      ? "windows-task-scheduler"
      : "systemd";

function uid(): number {
  return process.getuid?.() ?? 0;
}

function launchdDomain(): string {
  return `gui/${uid()}`;
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
}

/**
 * The environment `systemctl --user` needs from a CI step: the user manager's
 * runtime dir and bus. Lingering keeps user@<uid>.service up without a login.
 */
function systemdUserEnv(): Record<string, string> {
  const runtimeDir = `/run/user/${uid()}`;
  return {
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
    XDG_RUNTIME_DIR: runtimeDir,
  };
}

/** Starts the systemd user manager for this user (lingering) and waits for its bus. */
async function prepareSystemdUser(): Promise<{ ok: boolean; detail: string }> {
  const user = run("id -un", "id", ["-un"], { quiet: true }).stdout;
  const linger = run("loginctl enable-linger", "sudo", ["loginctl", "enable-linger", user]);
  const env = systemdUserEnv();
  const bus = await waitUntil(() => existsSync(env.XDG_RUNTIME_DIR + "/bus"), 30_000);
  const state = await waitUntil(
    () => {
      const result = systemctl(["is-system-running"], true);
      return ["running", "degraded"].includes(result.stdout) ? result : undefined;
    },
    60_000,
    1000,
  );
  const version = run("systemctl --version", "systemctl", ["--version"], { quiet: true });
  return {
    detail: `linger exit ${linger.code}; bus=${bus === true}; user manager: ${state?.stdout ?? systemctl(["is-system-running"], true).out}; ${oneLine(version.stdout.split("\n")[0] ?? "", 120)}`,
    ok: linger.code === 0 && bus === true && state !== undefined,
  };
}

function systemctl(args: string[], quiet = false): RunResult {
  return run(`systemctl --user ${args.join(" ")}`, "systemctl", ["--user", ...args], {
    env: { ...process.env, ...systemdUserEnv() },
    quiet,
  });
}

/** `systemctl --user show <unit> -p ...` as a map. */
function systemdShow(unit: string, properties: string[]): Record<string, string> {
  const result = systemctl(["show", unit, ...properties.flatMap((p) => ["-p", p])], true);
  return Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

/** `launchctl print gui/<uid>/<label>`, parsed. */
function launchdJob(): LaunchdJob {
  const result = run(
    "launchctl print job",
    "launchctl",
    ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`],
    {
      quiet: true,
    },
  );
  const field = (name: string) =>
    new RegExp(`^\\s*${name} = (.*)$`, "m").exec(result.stdout)?.[1]?.trim() ?? null;
  return {
    exit: result.code,
    lastExitCode: field("last exit code"),
    loaded: result.code === 0,
    raw: result.out,
    runs: Number(field("runs") ?? "0"),
    state: field("state"),
  };
}

/** `schtasks /Query /V /FO LIST` for the sync task, as a map. */
function windowsTask(): Record<string, string> & { _exit: string } {
  const result = run(
    "schtasks /Query",
    "schtasks",
    ["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"],
    {
      quiet: true,
    },
  );
  const map: Record<string, string> = { _exit: String(result.code) };
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([^:]+?):\s+(.*)$/.exec(line);
    if (match !== null && map[match[1]!] === undefined) {
      map[match[1]!] = match[2]!.trim();
    }
  }
  return map as Record<string, string> & { _exit: string };
}

/** Asks the scheduler to start the sync job now and waits for that run to finish. */
async function triggerScheduledRun(timeoutMs = 180_000): Promise<SchedulerRun> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;

  if (backend === "launchd") {
    const before = launchdJob();
    const kick = run("launchctl kickstart", "launchctl", [
      "kickstart",
      "-k",
      `${launchdDomain()}/${LAUNCHD_LABEL}`,
    ]);
    const after = await waitForLaunchdRun(before.runs, timeoutMs);
    return {
      detail: `kickstart exit ${kick.code}; runs ${before.runs} -> ${after?.runs ?? "?"}; last exit code ${after?.lastExitCode ?? "?"}`,
      exitCode: after?.lastExitCode ?? null,
      finished: after !== undefined,
      seconds: seconds(),
    };
  }

  if (backend === "systemd") {
    // A oneshot service's `start` returns once the run has finished.
    const start = systemctl(["start", `${SYSTEMD_UNIT}.service`]);
    const show = systemdShow(`${SYSTEMD_UNIT}.service`, [
      "Result",
      "ExecMainStatus",
      "ActiveState",
    ]);
    return {
      detail: `systemctl start exit ${start.code}; Result=${show.Result} ExecMainStatus=${show.ExecMainStatus} ActiveState=${show.ActiveState}`,
      exitCode: show.ExecMainStatus ?? null,
      finished: show.ActiveState !== "activating",
      seconds: seconds(),
    };
  }

  const before = windowsTask();
  const start = run("schtasks /Run", "schtasks", ["/Run", "/TN", WINDOWS_TASK]);
  const after = await waitUntil(
    () => {
      const task = windowsTask();
      // 267009 = SCHED_S_TASK_RUNNING
      return task.Status !== "Running" &&
        task["Last Run Time"] !== before["Last Run Time"] &&
        task["Last Result"] !== "267009"
        ? task
        : undefined;
    },
    timeoutMs,
    500,
  );
  return {
    detail: `schtasks /Run exit ${start.code}; Last Result ${after?.["Last Result"] ?? "?"}`,
    exitCode: after?.["Last Result"] ?? null,
    finished: after !== undefined,
    seconds: seconds(),
  };
}

/** Waits until launchd has started the job more than `runsBefore` times and it is idle again. */
async function waitForLaunchdRun(runsBefore: number, timeoutMs: number) {
  const job = await waitUntil(
    () => {
      const current = launchdJob();
      return current.runs > runsBefore && current.state !== "running" ? current : undefined;
    },
    timeoutMs,
    500,
  );
  if (job !== undefined) {
    // The wrapper may still be flushing service.log.
    await sleep(500);
  }
  return job;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readFrom(path: string, offset: number): string {
  try {
    return readFileSync(path).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

export {
  backend,
  fileSize,
  launchdDomain,
  launchdJob,
  launchdPlistPath,
  LAUNCHD_LABEL,
  prepareSystemdUser,
  readFrom,
  systemctl,
  systemdShow,
  systemdUnitDir,
  systemdUserEnv,
  SYSTEMD_UNIT,
  triggerScheduledRun,
  uid,
  waitForLaunchdRun,
  windowsTask,
  WINDOWS_TASK,
};
export type { Backend, LaunchdJob, SchedulerRun };
