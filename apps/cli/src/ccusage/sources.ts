import { USAGE_SOURCES, type UsageSource } from "@tokenmaxxing/api-contract";

/**
 * Per-source invocation strategy. Every supported agent maps to one focused
 * `ccusage <subcommand> daily` run; rows get tagged with `source` by the
 * aggregator. The unified `ccusage daily` is never used — it mixes agents
 * into untagged rows.
 */

/**
 * Sources ccusage has no subcommand of their own for. Oh My Pi writes
 * Pi-format sessions, so it runs the `pi` adapter pointed at OMP's
 * directories (see `ccusageSourceArgs`).
 */
const SUBCOMMAND_OVERRIDES: Partial<Record<UsageSource, string>> = { omp: "pi" };

interface CcusageSource {
  /** ccusage subcommand. */
  subcommand: string;
  /** The source tag stored server-side and shown on profiles. */
  source: UsageSource;
}

// The canonical source list lives in the API contract so the server rejects
// anything the CLI would never send; a source's subcommand is its name unless
// overridden above.
const CCUSAGE_SOURCES: readonly CcusageSource[] = USAGE_SOURCES.map((source) => ({
  source,
  subcommand: SUBCOMMAND_OVERRIDES[source] ?? source,
}));

const DEFAULT_SOURCE_NAMES = CCUSAGE_SOURCES.map((entry) => entry.source);

function resolveSources(names: readonly string[]): {
  invalid: string[];
  sources: CcusageSource[];
} {
  const bySource = new Map<string, CcusageSource>(
    CCUSAGE_SOURCES.map((entry) => [entry.source, entry]),
  );
  const sources: CcusageSource[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    const entry = bySource.get(name.trim().toLowerCase());
    if (entry === undefined) {
      invalid.push(name);
    } else if (!sources.includes(entry)) {
      sources.push(entry);
    }
  }

  return { invalid, sources };
}

export { DEFAULT_SOURCE_NAMES, resolveSources };

export type { CcusageSource };
