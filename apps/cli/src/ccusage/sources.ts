/**
 * Per-source collection strategy. ccusage-backed agents map to one focused
 * `ccusage <subcommand> daily` run; grok and antigravity have no ccusage
 * support and are read from their local data files directly (see
 * ../local). Rows get tagged with `source` by the aggregator. The unified
 * `ccusage daily` is never used — it mixes agents into untagged rows.
 *
 * kimi ships as a ccusage subcommand already — if ccusage adds grok or
 * antigravity later, those can flip to ccusage collectors too.
 */

interface CcusageUsageSource {
  collector: "ccusage";
  /** The source tag stored server-side and shown on profiles. */
  source: string;
  /** ccusage subcommand. */
  subcommand: string;
}

interface LocalUsageSource {
  collector: "antigravity" | "grok";
  /** The source tag stored server-side and shown on profiles. */
  source: string;
}

/** How a source's local usage gets collected, and what it is called. */
type UsageSource = CcusageUsageSource | LocalUsageSource;

const USAGE_SOURCES: readonly UsageSource[] = [
  { collector: "ccusage", source: "claude", subcommand: "claude" },
  { collector: "ccusage", source: "codex", subcommand: "codex" },
  { collector: "ccusage", source: "opencode", subcommand: "opencode" },
  { collector: "ccusage", source: "gemini", subcommand: "gemini" },
  { collector: "ccusage", source: "copilot", subcommand: "copilot" },
  { collector: "ccusage", source: "kimi", subcommand: "kimi" },
  { collector: "grok", source: "grok" },
  { collector: "antigravity", source: "antigravity" },
];

/** Alternate spellings accepted by --sources, mapped to the canonical tag. */
const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  agy: "antigravity",
};

const DEFAULT_SOURCE_NAMES = USAGE_SOURCES.map((entry) => entry.source);

function resolveSources(names: readonly string[]): {
  invalid: string[];
  sources: UsageSource[];
} {
  const bySource = new Map(USAGE_SOURCES.map((entry) => [entry.source, entry]));
  const sources: UsageSource[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    const canonical = SOURCE_ALIASES[normalized] ?? normalized;
    const entry = bySource.get(canonical);
    if (entry === undefined) {
      invalid.push(name);
    } else if (!sources.includes(entry)) {
      sources.push(entry);
    }
  }

  return { invalid, sources };
}

export { DEFAULT_SOURCE_NAMES, resolveSources };

export type { UsageSource };
