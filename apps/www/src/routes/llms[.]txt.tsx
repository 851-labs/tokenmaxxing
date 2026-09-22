import { createFileRoute } from "@tanstack/react-router";

import { SUPPORTED_AGENTS } from "../lib/agents";
import { textResponse } from "../lib/http";
import {
  CCUSAGE_URL,
  DISCORD_URL,
  GITHUB_URL,
  NPM_INSTALL_COMMAND,
  SITE_NAME,
  siteUrl,
  X_URL,
} from "../lib/site";

/** Curated llms.txt for answer engines and coding agents. Copy is sourced from
 * the homepage FAQ and the privacy page so it stays accurate to the product. */
function buildLlmsTxt(): string {
  return `# ${SITE_NAME}

> The social leaderboard for LLM coding-agent token usage. tokenmaxxing syncs your local usage from supported coding agents, turns it into daily token and spend totals, and lets you compare with other users on a public leaderboard.

## How to join

Install the CLI, then run the bootstrap command. Bootstrap signs you in, syncs your usage, and can set up automatic syncing.

\`\`\`
${NPM_INSTALL_COMMAND}
tokenmaxxing bootstrap
\`\`\`

## Supported agents

Usage is parsed locally via [ccusage](${CCUSAGE_URL}). Only daily aggregates (date, model name, agent source, token counts, and API-equivalent cost) are uploaded — prompts, file paths, project names, and session content are never uploaded.

${SUPPORTED_AGENTS.map((agent) => `- ${agent.label}`).join("\n")}

## Links

- [Site](${siteUrl("/")})
- [Stats](${siteUrl("/stats")})
- [Privacy](${siteUrl("/privacy")})
- [Terms](${siteUrl("/terms")})
- [GitHub](${GITHUB_URL})
- [Discord](${DISCORD_URL})
- [X](${X_URL})
`;
}

const LLMS_TXT = buildLlmsTxt();

const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        textResponse(LLMS_TXT, {
          cacheControl: "public, max-age=3600, stale-while-revalidate=86400",
          contentType: "text/markdown; charset=utf-8",
        }),
    },
  },
});

export { buildLlmsTxt, Route };
