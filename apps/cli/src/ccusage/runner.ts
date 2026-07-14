import { execFile } from "node:child_process";

import { Data, Effect, Option } from "effect";

import type { CcusageDailyReport, CcusageSessionReport } from "./schema";
import { decodeDailyReport, decodeSessionReport } from "./schema";
import type { CcusageSource } from "./sources";

/**
 * Shells out to `bunx ccusage@^20.0.17 <source> daily --json --breakdown` (npx
 * fallback only when bunx itself is missing). A source that fails, is not
 * installed, or has no local data resolves to none — one broken agent must
 * never abort the whole sync.
 */

const CCUSAGE_SPEC = "ccusage@^20.0.17";
const RUN_TIMEOUT_MS = 180_000;

class CcusageRunError extends Data.TaggedError("CcusageRunError")<{
  readonly cause: unknown;
  readonly source: string;
}> {}

interface RunOptions {
  /** YYYY-MM-DD; forwarded to ccusage as compact YYYYMMDD. */
  since?: string | undefined;
}

function runCcusageDailyReport(
  source: CcusageSource,
  options: RunOptions = {},
): Effect.Effect<Option.Option<CcusageDailyReport>> {
  // calculate mode prices every token at current list rates ("API-equivalent
  // cost") — auto mode trusts pre-recorded costs, which subscription usage
  // records as $0 and would zero out codex/opencode on the leaderboard.
  const args = dailyCcusageArgs(source, options);

  return Effect.gen(function* () {
    const stdout = yield* execCcusage(args, source.source);
    const report = yield* decodeDailyReport(JSON.parse(stdout)).pipe(
      Effect.mapError((cause) => new CcusageRunError({ cause, source: source.source })),
    );

    return Option.some(report);
  }).pipe(
    // Missing runner, no data dir, malformed output: skip the source.
    Effect.catchCause(() => Effect.succeedNone),
  );
}

function runCcusageSessionReport(
  source: CcusageSource,
  options: RunOptions = {},
): Effect.Effect<Option.Option<CcusageSessionReport>> {
  const args = sessionCcusageArgs(source, options);

  return Effect.gen(function* () {
    const stdout = yield* execCcusage(args, source.source);
    const report = yield* decodeSessionReport(JSON.parse(stdout)).pipe(
      Effect.mapError((cause) => new CcusageRunError({ cause, source: source.source })),
    );

    return Option.some(report);
  }).pipe(
    // Missing runner, no session support, no data dir, malformed output:
    // show an unknown session count without failing usage sync.
    Effect.catchCause(() => Effect.succeedNone),
  );
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

function execCcusage(args: string[], source: string): Effect.Effect<string, CcusageRunError> {
  const run = (command: string, commandArgs: string[]) =>
    Effect.callback<string, CcusageRunError>((resume) => {
      const child = execFile(
        command,
        commandArgs,
        { maxBuffer: 256 * 1024 * 1024, timeout: RUN_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            resume(Effect.fail(new CcusageRunError({ cause: error, source })));
          } else {
            resume(Effect.succeed(stdout));
          }
        },
      );

      return Effect.sync(() => {
        child.kill();
      });
    });

  return run("bunx", [CCUSAGE_SPEC, ...args]).pipe(
    Effect.catch((error: CcusageRunError) =>
      isMissingCommand(error.cause)
        ? run("npx", ["-y", CCUSAGE_SPEC, ...args])
        : Effect.fail(error),
    ),
  );
}

function isMissingCommand(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "ENOENT";
}

export {
  dailyCcusageCommand,
  runCcusageDailyReport,
  runCcusageSessionReport,
  sessionCcusageCommand,
};

export type { RunOptions };
