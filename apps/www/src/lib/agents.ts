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
] as const satisfies readonly SupportedAgent[];

type SupportedAgentSource = (typeof SUPPORTED_AGENTS)[number]["source"];

/** "A, B, and C" for prose (FAQ, privacy policy). */
function supportedAgentSentenceList(): string {
  const labels = SUPPORTED_AGENTS.map((agent) => agent.label);
  const last = labels.pop();

  return labels.length === 0 ? (last ?? "") : `${labels.join(", ")}, and ${last}`;
}

export { SUPPORTED_AGENTS, supportedAgentSentenceList };

export type { SupportedAgent, SupportedAgentSource };
