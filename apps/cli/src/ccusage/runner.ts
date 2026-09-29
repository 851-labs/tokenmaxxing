import { type ChildProcess, execFile, spawn } from "node:child_process";

import { Data, Effect } from "effect";

import type { CcusageDailyReport, CcusageSessionReport } from "./schema";
import { decodeDailyReport, decodeSessionReport } from "./schema";
import type { CcusageSource } from "./sources";
import { type CcusageEnv, ccusageSourceEnv } from "./source-env";

/**
 * Shells out to `bun x ccusage@^20.0.22 <source> daily --json --breakdown` (npx
 * fallback only when bun itself is missing). Runner and report failures stay
 * typed so the sync layer can distinguish them from valid empty reports.
 */

// 20.0.21 added the Antigravity and ZCode adapters; 20.0.22 stopped dropping
// claude-fable-5-1 usage. Earlier v20 releases also carry the Codex replay fix.
const CCUSAGE_SPEC = "ccusage@^20.0.22";
const RUN_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 2_000;
const MAX_STDOUT_BYTES = 256 * 1024 * 1024;
const STDERR_MAX_LINES = 5;
const STDERR_MAX_CHARS = 500;
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

class CcusageRunError extends Data.TaggedError("CcusageRunError")<{
  readonly cause: unknown;
  readonly code: CcusageRunErrorCode;
  readonly report: CcusageReportKind;
  readonly source: string;
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
  const [primary, fallback] = ccusageCommandInvocations(args, platform);
  const runInvocation = (invocation: CcusageCommandInvocation, env: CcusageEnv) =>
    run(invocation.command, invocation.args, env).pipe(
      Effect.timeout(`${Math.max(1, options.timeoutMs ?? RUN_TIMEOUT_MS)} millis`),
      Effect.mapError((error) =>
        error instanceof CcusageRunError
          ? error
          : new CcusageRunError({
              cause: error,
              code: "command_timed_out",
              report,
              source,
            }),
      ),
    );

  return Effect.promise(() => ccusageSourceEnv(source, options.env ?? process.env, platform)).pipe(
    Effect.flatMap((env) =>
      runInvocation(primary, env).pipe(
        Effect.catch((error: CcusageRunError) =>
          error.code === "command_not_found" ? runInvocation(fallback, env) : Effect.fail(error),
        ),
      ),
    ),
  );
}

function makeCcusageCommandRunner(source: string, report: CcusageReportKind): CcusageCommandRunner {
  return (command, commandArgs, env) =>
    Effect.callback<string, CcusageRunError>((resume) => {
      const fail = (cause: unknown, stderr?: string) =>
        resume(
          Effect.fail(
            new CcusageRunError({
              cause,
              code: isMissingCommand(cause) ? "command_not_found" : "command_failed",
              report,
              source,
              stderr: stderrTail(stderr),
            }),
          ),
        );
      // Its own process group on POSIX, so stopping it stops everything it
      // started: npx runs ccusage's node as a child, which would otherwise
      // outlive a timeout and keep this process's stdio pipes open, so the
      // CLI (and a oneshot systemd unit) never finished. Never on Windows,
      // where `detached` opens a console window. (execFile drops `detached`.)
      const child = spawn(command, commandArgs, {
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      child.on("error", (error) => fail(error, Buffer.concat(stderr).toString("utf8")));
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

function stderrTail(stderr: string | Buffer | undefined): string | undefined {
  const lines = String(stderr ?? "")
    .replaceAll(ANSI_ESCAPE_SEQUENCE, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-STDERR_MAX_LINES)
    .join("\n");
  if (lines.length === 0) {
    return undefined;
  }

  return lines.length > STDERR_MAX_CHARS ? `…${lines.slice(-STDERR_MAX_CHARS)}` : lines;
}

function ccusageCommandInvocations(
  args: string[],
  platform: NodeJS.Platform = process.platform,
): [CcusageCommandInvocation, CcusageCommandInvocation] {
  return [
    { args: ["x", CCUSAGE_SPEC, ...args], command: "bun" },
    {
      args: ["-y", CCUSAGE_SPEC, ...args],
      // The published Windows CLI is Bun-compiled, whose execFile implementation
      // can launch npm's command shim directly. A Node runtime would need cmd.exe.
      command: platform === "win32" ? "npx.cmd" : "npx",
    },
  ];
}

function isMissingCommand(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "ENOENT";
}

export {
  CcusageRunError,
  ccusageCommandInvocations,
  dailyCcusageCommand,
  execCcusage,
  killProcessTree,
  runCcusageDailyReport,
  runCcusageSessionReport,
  sessionCcusageCommand,
  stderrTail,
};

export type { CcusageReportKind, CcusageRunErrorCode, RunOptions };
