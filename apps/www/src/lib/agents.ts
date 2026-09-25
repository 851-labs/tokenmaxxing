/**
 * Agents the CLI syncs, keyed by the `source` tag it stores. Mirrors
 * `apps/cli/src/ccusage/sources.ts`; `agents.test.ts` fails if they drift.
 */

interface SupportedAgent {
  label: string;
  source: string;
}

const SUPPORTED_AGENTS = [
  { label: "Claude Code", source: "claude" },
  { label: "OpenAI Codex", source: "codex" },
  { label: "OpenCode", source: "opencode" },
  { label: "Gemini CLI", source: "gemini" },
  { label: "GitHub Copilot CLI", source: "copilot" },
  { label: "Hermes Agent", source: "hermes" },
  { label: "Pi", source: "pi" },
  { label: "Grok Build CLI", source: "grok" },
  { label: "Antigravity", source: "antigravity" },
  { label: "ZCode", source: "zcode" },
  { label: "Amp", source: "amp" },
  { label: "Qwen Code", source: "qwen" },
  { label: "Kimi CLI", source: "kimi" },
  { label: "Kilo Code", source: "kilo" },
  { label: "Goose", source: "goose" },
  { label: "Droid", source: "droid" },
  { label: "Codebuff", source: "codebuff" },
  { label: "OpenClaw", source: "openclaw" },
] as const satisfies readonly SupportedAgent[];

type SupportedAgentSource = (typeof SUPPORTED_AGENTS)[number]["source"];

const AGENT_LABELS = new Map<string, string>(
  SUPPORTED_AGENTS.map((agent) => [agent.source, agent.label]),
);

/** Display name for a stored `source` tag; unknown tags render as-is. */
function agentLabel(source: string): string {
  return AGENT_LABELS.get(source) ?? source;
}

/**
 * "A, B, and C" for prose (FAQ, privacy policy). With `limit`, names only the
 * first agents and counts the rest ("A, B, and 3 more agents").
 */
function supportedAgentSentenceList(options: { limit?: number } = {}): string {
  const labels = SUPPORTED_AGENTS.map((agent) => agent.label);
  const limit = options.limit ?? labels.length;
  if (limit < labels.length) {
    const rest = labels.length - limit;
    return `${labels.slice(0, limit).join(", ")}, and ${rest} more agent${rest === 1 ? "" : "s"}`;
  }
  const last = labels.pop();

  return labels.length === 0 ? (last ?? "") : `${labels.join(", ")}, and ${last}`;
}

export { agentLabel, SUPPORTED_AGENTS, supportedAgentSentenceList };

export type { SupportedAgent, SupportedAgentSource };
