import { execFile } from "node:child_process";

import { Data, Effect, Option } from "effect";

import type { CcusageDailyReport, CcusageSessionReport } from "./schema";
import { decodeDailyReport, decodeSessionReport } from "./schema";
import type { CcusageSource } from "./sources";

/**
 * Shells out to `bun x ccusage@^20.0.17 <source> daily --json --breakdown` (npx
 * fallback only when bun itself is missing). A source that fails, is not
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

interface CcusageCommandInvocation {
  args: string[];
  command: string;
}

interface ExecCcusageOptions {
  platform?: NodeJS.Platform | undefined;
  run?: CcusageCommandRunner | undefined;
}

type CcusageCommandRunner = (
  command: string,
  args: string[],
) => Effect.Effect<string, CcusageRunError>;

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

function execCcusage(
  args: string[],
  source: string,
  options: ExecCcusageOptions = {},
): Effect.Effect<string, CcusageRunError> {
  const run = options.run ?? makeCcusageCommandRunner(source);
  const [primary, fallback] = ccusageCommandInvocations(args, options.platform ?? process.platform);

  return run(primary.command, primary.args).pipe(
    Effect.catch((error: CcusageRunError) =>
      isMissingCommand(error.cause) ? run(fallback.command, fallback.args) : Effect.fail(error),
    ),
  );
}

function makeCcusageCommandRunner(source: string): CcusageCommandRunner {
  return (command, commandArgs) =>
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

export type { RunOptions };
