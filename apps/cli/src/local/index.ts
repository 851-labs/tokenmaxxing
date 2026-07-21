import { dirname } from "node:path";

import { Data, Effect, Option } from "effect";

import type { UsageSource } from "../ccusage/sources";
import { getConfigPath } from "../services/config";
import { collectAntigravityUsage } from "./antigravity";
import type { LocalUsageReport } from "./grok";
import { collectGrokUsage } from "./grok";

/**
 * Effect-facing glue for the native collectors (grok, antigravity). Both
 * read local data files directly — no subprocess — and emit claude-dialect
 * day rows so the sync pipeline and the server-side parser treat them
 * exactly like ccusage output. Fail-soft like the ccusage runner: one
 * broken source must never abort the whole sync.
 */

class LocalCollectError extends Data.TaggedError("LocalCollectError")<{
  readonly cause: unknown;
  readonly source: string;
}> {}

type LocalUsageSource = Extract<UsageSource, { collector: "antigravity" | "grok" }>;

interface RunOptions {
  /** YYYY-MM-DD lower bound on the local-time day buckets. */
  since?: string | undefined;
}

function runLocalUsageReport(
  source: LocalUsageSource,
  options: RunOptions = {},
): Effect.Effect<Option.Option<LocalUsageReport>, LocalCollectError> {
  const collect =
    source.collector === "grok"
      ? collectGrokUsage({ since: options.since })
      : collectAntigravityUsage({
          cacheDir: dirname(getConfigPath()),
          since: options.since,
        });

  return Effect.tryPromise({
    catch: (cause) => new LocalCollectError({ cause, source: source.source }),
    try: () => collect,
  }).pipe(
    Effect.map(Option.some),
    // Missing tool, no data dir, unreadable files: skip the source.
    Effect.catchCause(() => Effect.succeedNone),
  );
}

/** Informational stand-in for the ccusage command, stored with the report. */
function localDailyCommand(source: LocalUsageSource, options: RunOptions = {}): string[] {
  const args = ["tokenmaxxing-local", source.source, "daily"];
  if (options.since !== undefined) {
    args.push("--since", options.since.replaceAll("-", ""));
  }

  return args;
}

function localSessionCommand(source: LocalUsageSource): string[] {
  return ["tokenmaxxing-local", source.source, "session"];
}

export { localDailyCommand, localSessionCommand, runLocalUsageReport };

export type { LocalUsageSource };
