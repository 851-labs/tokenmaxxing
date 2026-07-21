/**
 * Per-source invocation strategy. Existing agents map to one focused
 * `ccusage <subcommand> daily` run, while Antigravity uses its local database
 * collector. The unified `ccusage daily` is never used because it mixes
 * agents into untagged rows.
 */

interface CcusageSource {
  kind: "ccusage";
  /** ccusage subcommand. */
  subcommand: string;
  /** The source tag stored server-side and shown on profiles. */
  source: string;
}

interface AntigravitySource {
  kind: "antigravity";
  source: "antigravity-cli";
}

type UsageSource = AntigravitySource | CcusageSource;

const USAGE_SOURCES: readonly UsageSource[] = [
  { kind: "ccusage", source: "claude", subcommand: "claude" },
  { kind: "ccusage", source: "codex", subcommand: "codex" },
  { kind: "ccusage", source: "opencode", subcommand: "opencode" },
  { kind: "antigravity", source: "antigravity-cli" },
  { kind: "ccusage", source: "gemini", subcommand: "gemini" },
  { kind: "ccusage", source: "copilot", subcommand: "copilot" },
];

const DEFAULT_SOURCE_NAMES = USAGE_SOURCES.map((entry) => entry.source);

function resolveSources(names: readonly string[]): {
  invalid: string[];
  sources: UsageSource[];
} {
  const bySource = new Map(USAGE_SOURCES.map((entry) => [entry.source, entry]));
  const antigravity = bySource.get("antigravity-cli");
  if (antigravity !== undefined) {
    bySource.set("antigravity", antigravity);
  }
  const sources: UsageSource[] = [];
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

export type { AntigravitySource, CcusageSource, UsageSource };
