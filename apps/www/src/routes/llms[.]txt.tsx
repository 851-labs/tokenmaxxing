import { createFileRoute } from "@tanstack/react-router";

const SITE_URL = "https://tokenmaxxing.sh";
const GITHUB_URL = "https://github.com/851-labs/tokenmaxxing";
const DISCORD_URL = "https://discord.gg/WzX6BpfaRH";
const X_URL = "https://x.com/pondorasti";

/** Curated llms.txt for answer engines and coding agents. Copy is sourced from
 * the homepage FAQ and the privacy page so it stays accurate to the product. */
const LLMS_TXT = `# tokenmaxxing.sh

> The social leaderboard for LLM coding-agent token usage. tokenmaxxing syncs your local usage from supported coding agents, turns it into daily token and spend totals, and lets you compare with other users on a public leaderboard.

## How to join

Install the CLI, then run the bootstrap command. Bootstrap signs you in, syncs your usage, and can set up automatic syncing.

\`\`\`
npm install -g @851-labs/tokenmaxxing
tokenmaxxing bootstrap
\`\`\`

## Supported agents

Usage is parsed locally via [ccusage](https://ccusage.com/). Only daily aggregates (date, model name, agent source, token counts, and API-equivalent cost) are uploaded — prompts, file paths, project names, and session content are never uploaded.

- Claude Code
- OpenAI Codex
- Cursor
- OpenCode
- Gemini CLI

## Links

- [Site](${SITE_URL})
- [Privacy](${SITE_URL}/privacy)
- [Terms](${SITE_URL}/terms)
- [GitHub](${GITHUB_URL})
- [Discord](${DISCORD_URL})
- [X](${X_URL})
`;

const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(LLMS_TXT, {
          headers: {
            "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
            "content-type": "text/markdown; charset=utf-8",
          },
        }),
    },
  },
});

export { Route };
