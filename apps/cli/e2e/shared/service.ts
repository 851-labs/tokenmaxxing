/**
 * Service helpers shared by the TypeScript suites: a sandbox profile per
 * scenario, the installed CLI, and one observed scheduled run (what the
 * scheduler reported, the service.log lines it appended, the sandbox
 * requests it made).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  check,
  log,
  oneLine,
  readJson,
  run,
  type RunResult,
  type Sandbox,
  type SandboxRequest,
} from "./harness";
import { fileSize, readFrom, type SchedulerRun } from "./scheduler";

interface Profile {
  configDir: string;
  deviceId: string;
  env: Record<string, string | undefined>;
  jitterMs: number;
  userId: string;
}

interface RunObservation {
  label: string;
  logDelta: string;
  /** The runner's `{"event":"service_run",...}` line, parsed. */
  line: Record<string, unknown> | null;
  requests: SandboxRequest[];
  scheduler: SchedulerRun;
}

interface ServiceContext {
  agentLogsDir: string;
  baseEnv: Record<string, string | undefined>;
  sandbox: Sandbox;
}

/**
 * A fresh config dir with a sandbox token, and the environment the CLI runs
 * with: fake bun first on PATH, then `binDirs`, the sandbox API, and agent log
 * roots the service captures at install.
 */
async function newProfile(
  context: ServiceContext,
  configDir: string,
  binDirs: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<Profile> {
  const minted = await context.sandbox.mintProfile(configDir, { maxJitterMs: 3000 });
  const claude = join(context.agentLogsDir, "claude");
  const codex = join(context.agentLogsDir, "codex");
  mkdirSync(join(claude, "projects", "e2e"), { recursive: true });
  mkdirSync(join(codex, "sessions"), { recursive: true });
  const env: Record<string, string | undefined> = {
    ...context.baseEnv,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    PATH: [...binDirs, context.baseEnv.PATH].join(delimiter),
    TOKENMAXXING_API_TOKEN: undefined,
    TOKENMAXXING_API_URL: context.sandbox.url,
    TOKENMAXXING_CONFIG_DIR: configDir,
    TOKENMAXXING_ENV: undefined,
    TOKENMAXXING_WWW_URL: context.sandbox.url,
    ...extraEnv,
  };
  log(
    `profile ${configDir} user=${minted.login} device=${minted.deviceId} jitter=${minted.jitterMs}ms`,
  );
  return {
    configDir,
    deviceId: minted.deviceId,
    env,
    jitterMs: minted.jitterMs,
    userId: minted.userId,
  };
}

/** Scheduled runs skip sources whose logs are unchanged, so every run gets a new log file. */
function touchAgentLogs(profile: Profile) {
  const name = `${crypto.randomUUID()}.jsonl`;
  writeFileSync(join(profile.env.CLAUDE_CONFIG_DIR!, "projects", "e2e", name), '{"e2e":true}\n');
  writeFileSync(join(profile.env.CODEX_HOME!, "sessions", name), '{"e2e":true}\n');
}

function tmx(profile: Profile, args: string[], timeoutMs?: number): RunResult {
  return run(`tokenmaxxing ${args.join(" ")}`, "tokenmaxxing", args, {
    env: profile.env,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function configFile(profile: Profile, name: string): string {
  return join(profile.configDir, name);
}

function serviceJson(profile: Profile) {
  return readJson<Record<string, unknown> & { templateVersion?: number; runnerVersion?: string }>(
    configFile(profile, "service.json"),
  );
}

function serviceState(profile: Profile) {
  return readJson<
    Record<string, unknown> & {
      lastAutoUpdate?: Record<string, unknown>;
      lastRepairReason?: string;
      lastRepairStatus?: string;
      lastRepairError?: string;
    }
  >(configFile(profile, "service-state.json"));
}

function setTemplateVersion(profile: Profile, version: number) {
  const path = configFile(profile, "service.json");
  const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  meta.templateVersion = version;
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Runs `trigger` (which makes the scheduler start the sync) and collects what the run did. */
async function observeRun(
  context: ServiceContext,
  profile: Profile,
  label: string,
  trigger: () => Promise<SchedulerRun>,
  options: { touchLogs?: boolean } = {},
): Promise<RunObservation> {
  const logPath = configFile(profile, "service.log");
  const logBefore = fileSize(logPath);
  const requestsBefore = (await context.sandbox.requests()).length;
  if (options.touchLogs !== false) {
    touchAgentLogs(profile);
  }
  const scheduler = await trigger();
  const logDelta = readFrom(logPath, logBefore);
  const requests = (await context.sandbox.requests()).slice(requestsBefore);
  const observation = { label, line: serviceRunLine(logDelta), logDelta, requests, scheduler };
  log(
    `run ${label}: ${scheduler.detail} after ${scheduler.seconds}s; requests: ${requests.map((r) => `${r.method} ${r.path} ${r.status}`).join(", ")}`,
  );
  return observation;
}

function serviceRunLine(logDelta: string): Record<string, unknown> | null {
  const line = logDelta
    .split(/\r?\n/)
    .filter((text) => text.includes('"event":"service_run"'))
    .at(-1);
  try {
    return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * A scheduled run that the scheduler reports as exit 0, that logged a
 * successful sync, and that checked in and ingested usage. A run seconds
 * after the previous one may skip every source (cadence cooldown) when
 * `allowCooldown` is set.
 */
function assertSuccessfulRun(
  scenarioName: string,
  observation: RunObservation,
  options: { allowCooldown?: boolean; successCodes?: string[] } = {},
) {
  const label = observation.label;
  const successCodes = options.successCodes ?? ["0"];
  check(
    scenarioName,
    `scheduler reports exit 0 (${label})`,
    observation.scheduler.finished && successCodes.includes(observation.scheduler.exitCode ?? ""),
    `${observation.scheduler.detail}; ${observation.scheduler.seconds}s`,
  );
  check(
    scenarioName,
    `service.log records a successful sync (${label})`,
    observation.logDelta.includes("tokenmaxxing service sync") &&
      observation.line?.status === "success",
    oneLine(observation.logDelta, 900),
  );
  const paths = observation.requests.map((r) => `${r.method} ${r.path} ${r.status}`).join(", ");
  const checkIns = observation.requests.filter(
    (r) => r.path === "/usage/check-in" && r.status === 200,
  ).length;
  const ingests = observation.requests.filter(
    (r) => r.path === "/usage/ingest" && r.status === 200,
  ).length;
  if (options.allowCooldown && ingests === 0) {
    check(
      scenarioName,
      `sandbox got a check-in; sources on cooldown (${label})`,
      checkIns >= 1 && observation.line?.rows === 0,
      paths,
    );
  } else {
    check(
      scenarioName,
      `sandbox got check-in + ingest (${label})`,
      checkIns >= 1 && ingests >= 1,
      paths,
    );
  }
}

/** The CLI's SERVICE_TEMPLATE_VERSION, read from this checkout's source. */
function currentTemplateVersion(repoDir: string): number {
  const source = readFileSync(
    join(repoDir, "apps", "cli", "src", "commands", "service.ts"),
    "utf8",
  );
  const match = /const SERVICE_TEMPLATE_VERSION = (\d+);/.exec(source);
  if (match === null) {
    throw new Error("SERVICE_TEMPLATE_VERSION not found in service.ts");
  }
  return Number(match[1]);
}

export {
  assertSuccessfulRun,
  configFile,
  currentTemplateVersion,
  newProfile,
  observeRun,
  serviceJson,
  serviceRunLine,
  serviceState,
  setTemplateVersion,
  tmx,
  touchAgentLogs,
};
export type { Profile, RunObservation, ServiceContext };
