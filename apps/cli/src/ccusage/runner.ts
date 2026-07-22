import { execFile } from "node:child_process";

import { Data, Effect } from "effect";

import type { CcusageDailyReport, CcusageSessionReport } from "./schema";
import { decodeDailyReport, decodeSessionReport } from "./schema";
import type { CcusageSource } from "./sources";

/**
 * Shells out to `bun x ccusage@^20.0.17 <source> daily --json --breakdown` (npx
 * fallback only when bun itself is missing). Runner and report failures stay
 * typed so the sync layer can distinguish them from valid empty reports.
 */

const CCUSAGE_SPEC = "ccusage@^20.0.17";
const RUN_TIMEOUT_MS = 180_000;

class CcusageRunError extends Data.TaggedError("CcusageRunError")<{
  readonly cause: unknown;
  readonly code: CcusageRunErrorCode;
  readonly report: CcusageReportKind;
  readonly source: string;
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
  const [primary, fallback] = ccusageCommandInvocations(args, options.platform ?? process.platform);
  const runInvocation = (invocation: CcusageCommandInvocation) =>
    run(invocation.command, invocation.args).pipe(
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

  return runInvocation(primary).pipe(
    Effect.catch((error: CcusageRunError) =>
      error.code === "command_not_found" ? runInvocation(fallback) : Effect.fail(error),
    ),
  );
}

function makeCcusageCommandRunner(source: string, report: CcusageReportKind): CcusageCommandRunner {
  return (command, commandArgs) =>
    Effect.callback<string, CcusageRunError>((resume) => {
      const child = execFile(
        command,
        commandArgs,
        { maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resume(
              Effect.fail(
                new CcusageRunError({
                  cause: error,
                  code: isMissingCommand(error) ? "command_not_found" : "command_failed",
                  report,
                  source,
                }),
              ),
            );
          } else {
            resume(Effect.succeed(stdout));
          }
        },
      );

      return Effect.sync(() => {
        child.kill();
      });
    });
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
  runCcusageDailyReport,
  runCcusageSessionReport,
  sessionCcusageCommand,
};

export type { CcusageReportKind, CcusageRunErrorCode, RunOptions };
