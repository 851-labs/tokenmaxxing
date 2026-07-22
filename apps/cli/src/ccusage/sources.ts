/**
 * Per-source invocation strategy. Every supported agent maps to one focused
 * `ccusage <subcommand> daily` run; rows get tagged with `source` by the
 * aggregator. The unified `ccusage daily` is never used — it mixes agents
 * into untagged rows.
 */

interface CcusageSource {
  /** ccusage subcommand. */
  subcommand: string;
  /** The source tag stored server-side and shown on profiles. */
  source: string;
}

const CCUSAGE_SOURCES: readonly CcusageSource[] = [
  { source: "claude", subcommand: "claude" },
  { source: "codex", subcommand: "codex" },
  { source: "opencode", subcommand: "opencode" },
  { source: "gemini", subcommand: "gemini" },
  { source: "copilot", subcommand: "copilot" },
  { source: "pi", subcommand: "pi" },
];

const DEFAULT_SOURCE_NAMES = CCUSAGE_SOURCES.map((entry) => entry.source);

function resolveSources(names: readonly string[]): {
  invalid: string[];
  sources: CcusageSource[];
} {
  const bySource = new Map(CCUSAGE_SOURCES.map((entry) => [entry.source, entry]));
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
