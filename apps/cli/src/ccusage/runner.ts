import { type ChildProcess, type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { stripDayModelPaths } from "@tokenmaxxing/api-contract";
import { Data, Effect } from "effect";

import type { CcusageDailyReport, CcusageSessionReport } from "./schema";
import { decodeDailyReport, decodeSessionReport } from "./schema";
import type { CcusageSource } from "./sources";
import { type CcusageEnv, ccusageSourceArgs, ccusageSourceEnv } from "./source-env";

/**
 * Shells out to `bun x ccusage@^20.0.22 <source> daily --json --breakdown`, falling back to
 * npx when bun is missing, cannot be started or does not take `bun x`. Runner and report
 * failures stay typed so the sync layer can distinguish them from valid empty reports.
 */

// 20.0.21 added the Antigravity and ZCode adapters; 20.0.22 stopped dropping
// claude-fable-5-1 usage. Earlier v20 releases also carry the Codex replay fix.
const CCUSAGE_SPEC = "ccusage@^20.0.22";
const RUN_TIMEOUT_MS = 180_000;
const WINDOWS_NPX_SHIM = "npx.cmd";
/** What `npm i -g bun` and pnpm put on PATH instead of bun.exe; cmd.exe has to run them. */
const WINDOWS_BUN_SHIMS = ["bun.cmd", "bun.bat"] as const;
const KILL_GRACE_MS = 2_000;
const MAX_STDOUT_BYTES = 256 * 1024 * 1024;
const STDERR_MAX_LINES = 5;
const STDERR_MAX_CHARS = 500;
const STDERR_MAX_LINE_CHARS = 240;
/**
 * stderr lines that say why ccusage could not run, best first. The reason is
 * rarely the last line: dyld ends with a long `Reason: tried: …` after
 * `Library not loaded`, asdf and mise end their "No version is set" message
 * with the installed versions, and npm with where its log went.
 */
const STDERR_REASON_PATTERNS: readonly (readonly RegExp[])[] = [
  [
    /^dyld\b|Library not loaded/,
    /No (?:preset )?version (?:is set|installed)|\bnot installed\b/i,
    /command not found|: not found$|No such file or directory|Cannot find module/i,
    /\bE(?:NOENT|ACCES|PERM)\b/,
  ],
  [/\berror\b/i, /Error:/],
];
/** Lines that look like reasons but never are. */
const STDERR_NOISE = /A complete log of this run can be found in|^npm error code \S+$|^npm warn\b/i;
/**
 * What a bun that took the `x` of `bun x` for a script to run prints, and nothing else:
 * `error: Script not found "x"` (Bun 1.0.19 and later) or `error: missing script "x"`
 * (earlier). Every Bun release since 0.4 takes `bun x`, yet one Linux device's bun printed the
 * former for every run, so this goes by what bun says rather than by its version.
 */
const BUN_X_REJECTED = /^error: (?:script not found|missing script) "x"$/im;
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
/** What ccusage prints for a source with no logs; used when there is nothing to point it at. */
const EMPTY_REPORTS: Record<CcusageReportKind, string> = {
  daily: JSON.stringify({ daily: [], totals: null }),
  session: JSON.stringify({ sessions: [], totals: null }),
};

class CcusageRunError extends Data.TaggedError("CcusageRunError")<{
  readonly cause: unknown;
  readonly code: CcusageRunErrorCode;
  readonly report: CcusageReportKind;
  readonly source: string;
  /** Runners tried before this one that could not be started (`ccusageRunDiagnostic`s). */
  readonly earlier?: readonly string[] | undefined;
  /** Runners tried after this one that were not on PATH, e.g. `npx`. */
  readonly missing?: readonly string[] | undefined;
  /** What a bun that does not take `bun x` printed instead of running ccusage; see BUN_X_REJECTED. */
  readonly rejected?: string | undefined;
  /** What ran ccusage: `bun`, `npx`, or on Windows `bun.exe`, `bun.cmd` or `npx.cmd`. */
  readonly runner?: string | undefined;
  /** Why the runner could not be started at all, e.g. `EINVAL`; unset once it ran. */
  readonly startError?: string | undefined;
  /** The end of what the command wrote to stderr, e.g. `env: node: No such file or directory`. */
  readonly stderr?: string | undefined;
}> {}

interface RunOptions {
  /** YYYY-MM-DD; forwarded to ccusage as compact YYYYMMDD. */
  exec?: ExecCcusageOptions | undefined;
  since?: string | undefined;
}

interface CcusageCommandInvocation {
  args: string[];
  command: string;
  /** The runner's name in diagnostics: `bun`, `npx`, `bun.exe`, `bun.cmd`, `npx.cmd`. */
  runner: string;
  /** The Windows command shim that `cmd.exe` runs; missing from PATH means command_not_found. */
  shim?: string | undefined;
  windowsVerbatimArguments?: boolean | undefined;
}

/** The bun a Windows PATH offers: bun.exe itself, or only a batch shim that starts it. */
type WindowsBun = { kind: "exe"; path: string } | { kind: "shim"; name: string };

interface CcusageSpawnOptions {
  /** Hand `args` to CreateProcess as written: the `cmd.exe /d /s /c` line quotes itself. */
  windowsVerbatimArguments: boolean;
}

interface ExecCcusageOptions {
  /** Base environment for the child; defaults to `process.env`. */
  env?: CcusageEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  run?: CcusageCommandRunner | undefined;
  timeoutMs?: number | undefined;
}

type CcusageReportKind = "daily" | "session";
type CcusageRunErrorCode =
  | "command_failed"
  | "command_not_found"
  | "command_timed_out"
  | "invalid_json"
  | "invalid_report";

type CcusageCommandRunner = (
  command: string,
  args: string[],
  env: CcusageEnv,
  options: CcusageSpawnOptions,
) => Effect.Effect<string, CcusageRunError>;

function runCcusageDailyReport(
  source: CcusageSource,
  options: RunOptions = {},
): Effect.Effect<CcusageDailyReport, CcusageRunError> {
  // calculate mode prices every token at current list rates ("API-equivalent
  // cost") — auto mode trusts pre-recorded costs, which subscription usage
  // records as $0 and would zero out codex/opencode on the leaderboard.
  const args = dailyCcusageArgs(source, options);

  return execCcusage(args, source.source, "daily", options.exec).pipe(
    Effect.flatMap((stdout) => decodeCcusageJson(stdout, source.source, "daily")),
    Effect.flatMap((payload) =>
      decodeDailyReport(payload).pipe(
        Effect.mapError(
          (cause) =>
            new CcusageRunError({
              cause,
              code: "invalid_report",
              report: "daily",
              source: source.source,
            }),
        ),
      ),
    ),
    // Local model runners report the loaded file's path as the model, which
    // can name the home directory; only the file name ever leaves the device.
    Effect.map((report) => ({ ...report, daily: report.daily.map(stripDayModelPaths) })),
  );
}

function runCcusageSessionReport(
  source: CcusageSource,
  options: RunOptions = {},
): Effect.Effect<CcusageSessionReport, CcusageRunError> {
  const args = sessionCcusageArgs(source, options);

  return execCcusage(args, source.source, "session", options.exec).pipe(
    Effect.flatMap((stdout) => decodeCcusageJson(stdout, source.source, "session")),
    Effect.flatMap((payload) =>
      decodeSessionReport(payload).pipe(
        Effect.mapError(
          (cause) =>
            new CcusageRunError({
              cause,
              code: "invalid_report",
              report: "session",
              source: source.source,
            }),
        ),
      ),
    ),
  );
}

function decodeCcusageJson(stdout: string, source: string, report: CcusageReportKind) {
  return Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: (cause) => new CcusageRunError({ cause, code: "invalid_json", report, source }),
  });
}

// The recorded (and uploaded) command leaves out the arguments
// `ccusageSourceArgs` adds at run time: those are local paths.
function dailyCcusageCommand(source: CcusageSource, options: RunOptions = {}): string[] {
  return [CCUSAGE_SPEC, ...dailyCcusageArgs(source, options)];
}

function sessionCcusageCommand(source: CcusageSource, options: RunOptions = {}): string[] {
  return [CCUSAGE_SPEC, ...sessionCcusageArgs(source, options)];
}

function dailyCcusageArgs(source: CcusageSource, options: RunOptions = {}): string[] {
  const args = [source.subcommand, "daily", "--json", "--breakdown", "--mode", "calculate"];
  if (options.since !== undefined) {
    args.push("--since", options.since.replaceAll("-", ""));
  }

  return args;
}

function sessionCcusageArgs(source: CcusageSource, options: RunOptions = {}): string[] {
  const args = [source.subcommand, "session", "--json", "--mode", "calculate"];
  if (options.since !== undefined) {
    args.push("--since", options.since.replaceAll("-", ""));
  }

  return args;
}

function execCcusage(
  args: string[],
  source: string,
  report: CcusageReportKind,
  options: ExecCcusageOptions = {},
): Effect.Effect<string, CcusageRunError> {
  const run = options.run ?? makeCcusageCommandRunner(source, report);
  const platform = options.platform ?? process.platform;
  const runInvocation = (invocation: CcusageCommandInvocation, env: CcusageEnv) =>
    Effect.promise(() =>
      invocation.shim === undefined
        ? Promise.resolve(true)
        : findOnWindowsPath(invocation.shim, env).then((found) => found !== undefined),
    ).pipe(
      Effect.flatMap((found) =>
        found
          ? run(invocation.command, invocation.args, env, {
              windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
            })
          : Effect.fail(
              new CcusageRunError({
                cause: Object.assign(new Error(`${invocation.shim} is not on PATH`), {
                  code: "ENOENT",
                }),
                code: "command_not_found",
                report,
                source,
              }),
            ),
      ),
      Effect.timeout(`${Math.max(1, options.timeoutMs ?? RUN_TIMEOUT_MS)} millis`),
      Effect.mapError((error) =>
        error instanceof CcusageRunError
          ? bunXRejection(withRunner(error, invocation.runner))
          : new CcusageRunError({
              cause: error,
              code: "command_timed_out",
              report,
              runner: invocation.runner,
              source,
            }),
      ),
    );
  // The next runner gets a turn only when this one never ran ccusage: missing, refused by the OS
  // or the runtime (Bun 1.4 throws for a .cmd it cannot quote), or a bun that does not take
  // `bun x`. A ccusage that ran and failed is reported as is, never hidden behind another
  // runner's attempt.
  const runInvocations = (
    invocations: readonly CcusageCommandInvocation[],
    env: CcusageEnv,
    tried: readonly CcusageRunError[] = [],
  ): Effect.Effect<string, CcusageRunError> => {
    const [invocation, ...rest] = invocations;
    if (invocation === undefined) {
      return Effect.fail(reportedFailure(tried));
    }
    return runInvocation(invocation, env).pipe(
      Effect.catch((error: CcusageRunError) =>
        rest.length > 0 && neverRanCcusage(error)
          ? runInvocations(rest, env, [...tried, error])
          : Effect.fail(reportedFailure([...tried, error])),
      ),
    );
  };

  return Effect.promise(() => ccusageSourceEnv(source, options.env ?? process.env, platform)).pipe(
    Effect.flatMap((env) => {
      const sourceArgs = ccusageSourceArgs(source, env);
      if (sourceArgs === null) {
        return Effect.succeed(EMPTY_REPORTS[report]);
      }

      return Effect.promise(() =>
        platform === "win32" ? findWindowsBun(env) : Promise.resolve(undefined),
      ).pipe(
        Effect.flatMap((bun) =>
          runInvocations(
            ccusageCommandInvocations([...args, ...sourceArgs], platform, env, bun),
            env,
          ),
        ),
      );
    }),
  );
}

function withRunner(error: CcusageRunError, runner: string): CcusageRunError {
  return error.runner === undefined ? withFields(error, { runner }) : error;
}

function withFields(
  error: CcusageRunError,
  fields: Partial<Pick<CcusageRunError, "earlier" | "missing" | "rejected" | "runner" | "stderr">>,
): CcusageRunError {
  return new CcusageRunError({
    cause: error.cause,
    code: error.code,
    earlier: error.earlier,
    missing: error.missing,
    rejected: error.rejected,
    report: error.report,
    runner: error.runner,
    source: error.source,
    startError: error.startError,
    stderr: error.stderr,
    ...fields,
  });
}

/**
 * A bun that exited printing BUN_X_REJECTED's line never got to ccusage: it is no more use than a
 * missing one, so npx gets its turn. Any other failure of a bun that ran is ccusage's own.
 */
function bunXRejection(error: CcusageRunError): CcusageRunError {
  const rejected =
    error.runner?.startsWith("bun") === true &&
    error.code === "command_failed" &&
    error.startError === undefined
      ? error.stderr?.match(BUN_X_REJECTED)?.[0]
      : undefined;
  return rejected === undefined ? error : withFields(error, { rejected, stderr: undefined });
}

function neverRanCcusage(error: CcusageRunError): boolean {
  return (
    error.code === "command_not_found" ||
    error.startError !== undefined ||
    error.rejected !== undefined
  );
}

/**
 * The failure to report once no runner is left: the last one that was there to run, since
 * "not found" from the npx fallback would hide a bun that exists but cannot start. It names
 * the runners that could not be started before it and, after a bun that does not take
 * `bun x`, the ones that were not on PATH.
 */
function reportedFailure(tried: readonly CcusageRunError[]): CcusageRunError {
  const found = tried.filter((error) => error.code !== "command_not_found");
  const reported = found.at(-1) ?? tried.at(-1)!;
  const earlier = found
    .filter((error) => error !== reported)
    .flatMap((error) => ccusageRunDiagnostic(error) ?? []);
  const missing =
    reported.rejected === undefined
      ? []
      : tried.slice(tried.indexOf(reported) + 1).flatMap((error) => error.runner ?? []);
  return earlier.length === 0 && missing.length === 0
    ? reported
    : withFields(reported, {
        ...(earlier.length === 0 ? {} : { earlier }),
        ...(missing.length === 0 ? {} : { missing }),
      });
}

/**
 * One line on how the runner ended, for a failure without stderr: `bun.cmd could not be
 * started (EINVAL)`, `npx.cmd exited with code 1; tried first: bun.exe could not be started
 * (EACCES)`, `bun does not support \`bun x\` (error: Script not found "x") and npx is not on
 * PATH; update Bun or install Node.js`. It names runners and error codes only, never a path.
 */
function ccusageRunDiagnostic(error: CcusageRunError): string | undefined {
  const runner = error.runner ?? "ccusage";
  const exit = error.cause as { code?: unknown; signal?: unknown } | undefined;
  const ended =
    error.startError !== undefined
      ? `${runner} could not be started (${error.startError})`
      : error.rejected !== undefined
        ? bunXRejectedDiagnostic(runner, error.rejected, error.missing ?? [])
        : error.code !== "command_failed"
          ? undefined
          : typeof exit?.signal === "string"
            ? `${runner} was stopped by ${exit.signal}`
            : typeof exit?.code === "number"
              ? `${runner} exited with code ${exit.code}`
              : undefined;
  const earlier = error.earlier ?? [];
  if (earlier.length === 0) {
    return ended;
  }

  return `${ended ?? `${runner} failed`}; tried first: ${earlier.join("; ")}`;
}

function bunXRejectedDiagnostic(runner: string, rejected: string, missing: readonly string[]) {
  const rejection = `${runner} does not support \`bun x\` (${rejected})`;
  if (missing.length === 0) {
    return rejection;
  }

  const notOnPath = `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not on PATH`;
  return `${rejection} and ${notOnPath}; update Bun or install Node.js`;
}

function makeCcusageCommandRunner(source: string, report: CcusageReportKind): CcusageCommandRunner {
  return (command, commandArgs, env, spawnOptions) =>
    Effect.callback<string, CcusageRunError>((resume) => {
      const fail = (cause: unknown, stderr?: string, started = true) =>
        resume(
          Effect.fail(
            new CcusageRunError({
              cause,
              code: isMissingCommand(cause) ? "command_not_found" : "command_failed",
              report,
              source,
              startError: started ? undefined : spawnErrorCode(cause),
              stderr: stderrTail(stderr),
            }),
          ),
        );
      // Its own process group on POSIX, so stopping it stops everything it
      // started: npx runs ccusage's node as a child, which would otherwise
      // outlive a timeout and keep this process's stdio pipes open, so the
      // CLI (and a oneshot systemd unit) never finished. Never on Windows,
      // where `detached` opens a console window. (execFile drops `detached`.)
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(command, commandArgs, {
          detached: process.platform !== "win32",
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments,
        });
      } catch (cause) {
        // spawn throws for some commands (EINVAL for a .cmd without a shell). Thrown out of this
        // callback it became a defect that ended the whole run with nothing logged or reported.
        fail(cause, undefined, false);
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          killProcessTree(child);
          fail(new Error(`ccusage output exceeded ${MAX_STDOUT_BYTES} bytes`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });
      // A child that never got a pid was never started (ENOENT, EACCES).
      child.on("error", (error) =>
        fail(error, Buffer.concat(stderr).toString("utf8"), child.pid !== undefined),
      );
      child.on("close", (code, signal) => {
        if (code === 0) {
          resume(Effect.succeed(Buffer.concat(stdout).toString("utf8")));
          return;
        }
        fail(
          Object.assign(new Error(`${command} exited with ${signal ?? `code ${code}`}`), {
            code,
            signal,
          }),
          Buffer.concat(stderr).toString("utf8"),
        );
      });

      return Effect.sync(() => {
        killProcessTree(child);
      });
    });
}

/** Stops `child` and whatever it started; see makeCcusageCommandRunner. */
function killProcessTree(
  child: Pick<ChildProcess, "kill" | "pid">,
  platform: NodeJS.Platform = process.platform,
  kill: typeof process.kill = process.kill.bind(process),
  run: typeof execFile = execFile,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (platform === "win32") {
    // ChildProcess#kill is TerminateProcess on the direct child only.
    run("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) {
    child.kill();
    return;
  }
  // Anything that ignores SIGTERM goes too, unless this process exits first.
  setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
}

/**
 * What a failed ccusage wrote to stderr, for the source's `detail`: the last lines, and the line
 * `ccusageStderrReason` picks when it came earlier, each cut to STDERR_MAX_LINE_CHARS.
 */
function stderrTail(stderr: string | Buffer | undefined): string | undefined {
  const lines = stderrLines(stderr).map((line) =>
    line.length > STDERR_MAX_LINE_CHARS ? `${line.slice(0, STDERR_MAX_LINE_CHARS)}…` : line,
  );
  const reason = ccusageStderrReason(lines.join("\n"));
  if (reason === undefined) {
    return undefined;
  }

  const tail = lines.slice(-STDERR_MAX_LINES);
  const head = tail.includes(reason) ? [] : [reason, "…"];
  while (tail.length > 1 && [...head, ...tail].join("\n").length > STDERR_MAX_CHARS) {
    tail.shift();
  }
  return [...head, ...tail].join("\n");
}

/**
 * The stderr line that says why ccusage failed, for the one-line reason a failed sync reports:
 * the first that matches STDERR_REASON_PATTERNS (dyld's `Library not loaded`, asdf's `No preset
 * version installed for command node`, `env: node: No such file or directory`, then any error),
 * else the last line.
 */
function ccusageStderrReason(stderr: string | undefined): string | undefined {
  const lines = stderrLines(stderr);
  const useful = lines.filter((line) => !STDERR_NOISE.test(line));
  for (const patterns of STDERR_REASON_PATTERNS) {
    const reason = useful.find((line) => patterns.some((pattern) => pattern.test(line)));
    if (reason !== undefined) {
      return reason;
    }
  }

  return useful.at(-1) ?? lines.at(-1);
}

function stderrLines(stderr: string | Buffer | undefined): string[] {
  return String(stderr ?? "")
    .replaceAll(ANSI_ESCAPE_SEQUENCE, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ccusageCommandInvocations(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  windowsBun?: WindowsBun,
): CcusageCommandInvocation[] {
  const bunArgs = ["x", CCUSAGE_SPEC, ...args];
  const npxArgs = ["-y", CCUSAGE_SPEC, ...args];
  if (platform !== "win32") {
    return [
      { args: bunArgs, command: "bun", runner: "bun" },
      { args: npxArgs, command: "npx", runner: "npx" },
    ];
  }

  // A bare `bun` would be resolved by the runtime, which takes the first bun.exe, bun.cmd or
  // bun.bat on PATH and, for a batch file, refuses the ^ in the version range
  // (ERR_INVALID_ARG_VALUE). So bun.exe runs by its path, and a shim the way npx.cmd does.
  const bun =
    windowsBun === undefined
      ? []
      : windowsBun.kind === "exe"
        ? [{ args: bunArgs, command: windowsBun.path, runner: "bun.exe" }]
        : [windowsShimInvocation(windowsBun.name, bunArgs, env)];
  return [...bun, windowsShimInvocation(WINDOWS_NPX_SHIM, npxArgs, env)];
}

/**
 * Runs a batch-file shim like npm's npx.cmd through cmd.exe: Node and Bun (since 1.4) refuse
 * to start one without a shell (EINVAL), and Bun's own shell quoting rejects the ^ in the
 * version range. The arguments are quoted: cmd reads ^ as its escape character anywhere outside
 * quotes. The shim's name is not: a batch file that cmd finds on PATH by a quoted name gets the
 * current directory as %~dp0, which is where npm's shims look for what they start. Every word
 * is fixed, apart from OMP session paths, which `ompSessionDirs` only passes without `%` or `"`.
 */
function windowsShimInvocation(
  shim: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): CcusageCommandInvocation {
  const quoted = args.map((word) => `"${word}"`);
  return {
    args: ["/d", "/s", "/c", `"${[shim, ...quoted].join(" ")}"`],
    command: windowsEnvValue(env, "ComSpec") ?? "cmd.exe",
    runner: shim,
    shim,
    windowsVerbatimArguments: true,
  };
}

/**
 * The bun to run on Windows: bun.exe anywhere on PATH (the official installer, Scoop's shim
 * exe, or npm's package binary when its folder is on PATH) over a batch shim that sits earlier,
 * since only the exe starts without cmd.exe; otherwise the first bun.cmd or bun.bat.
 */
async function findWindowsBun(env: CcusageEnv): Promise<WindowsBun | undefined> {
  const exe = await findOnWindowsPath("bun.exe", env);
  if (exe !== undefined) {
    return { kind: "exe", path: exe };
  }
  for (const dir of windowsPathDirs(env)) {
    for (const name of WINDOWS_BUN_SHIMS) {
      if (await isFile(join(dir, name))) {
        return { kind: "shim", name };
      }
    }
  }

  return undefined;
}

/** Where `name` is in the first directory on the Windows PATH that `env` gives the child. */
async function findOnWindowsPath(name: string, env: CcusageEnv): Promise<string | undefined> {
  for (const dir of windowsPathDirs(env)) {
    const path = join(dir, name);
    if (await isFile(path)) {
      return path;
    }
  }

  return undefined;
}

function windowsPathDirs(env: CcusageEnv): string[] {
  return (windowsEnvValue(env, "PATH") ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir.length > 0);
}

/** Windows spells it Path or ComSpec; a copied environment keeps whatever case it had. */
function windowsEnvValue(env: Record<string, string | undefined>, name: string) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The code a refused spawn carries (`EINVAL`, `ERR_INVALID_ARG_VALUE`), safe to report. */
function spawnErrorCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown error";
}

function isMissingCommand(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "ENOENT";
}

export {
  CcusageRunError,
  ccusageCommandInvocations,
  ccusageRunDiagnostic,
  ccusageStderrReason,
  dailyCcusageCommand,
  execCcusage,
  findWindowsBun,
  killProcessTree,
  runCcusageDailyReport,
  runCcusageSessionReport,
  sessionCcusageCommand,
  stderrTail,
};

export type { CcusageReportKind, CcusageRunErrorCode, RunOptions, WindowsBun };
