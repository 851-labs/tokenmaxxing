# tokenmaxxing

The social leaderboard for LLM token usage. Sync your local agent usage
(Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, Pi), climb the board at
[tokenmaxxing.sh](https://tokenmaxxing.sh).

Built on [ccusage](https://github.com/ryoppippi/ccusage) for local usage
parsing, [Effect](https://effect.website) v4 end to end, and deployed to
Cloudflare (Workers + D1) with [Alchemy](https://alchemy.run) v2.

## Quick start

```bash
npm install -g @851-labs/tokenmaxxing@latest
tokenmaxxing login              # sign in with OAuth, approves this device
tokenmaxxing sync               # parse local usage via ccusage and push it
tokenmaxxing service install    # optional: sync automatically every 5 minutes
tokenmaxxing upgrade            # upgrade the global CLI and refresh the service
```

You can also install globally with `bun add -g --trust @851-labs/tokenmaxxing@latest`,
`pnpm add -g @851-labs/tokenmaxxing@latest`, or
`yarn global add @851-labs/tokenmaxxing@latest`.

The background service uses the global `tokenmaxxing` binary and syncs every
5 minutes. It auto-updates through the package manager that installed the
global binary (bun, npm, pnpm, or yarn) when that package manager can be
detected.
After an upgrade or auto-update, installed services are refreshed automatically so scheduler
files stay current.
Use `tokenmaxxing service status` for the last run and `tokenmaxxing service
doctor` to inspect scheduler files, auth, auto-update, locks, and recent logs.

`sync` aggregates one row per (day × model × agent) and upserts — run it as
often as you like, from as many machines as you like; profiles aggregate
across all your devices. `--dry-run` shows what would be pushed, `--since
YYYY-MM-DD` bounds the range, `--sources claude,codex` picks agents.

### What gets uploaded (privacy)

Daily aggregates only: date, model name, agent name, token counts, and the
API-equivalent cost — never prompts, file paths, project names, or session
content. Profiles and the leaderboard are public; device hostnames appear
on your own settings page and in your per-device breakdown.

CLI tokens never expire. Revoke them with `tokenmaxxing logout` or from
[settings](https://tokenmaxxing.sh/settings).

## Layout

- `apps/api` — Effect HttpApi server on a Cloudflare Worker (D1)
- `apps/www` — TanStack Start site: leaderboard + profile dashboards
- `apps/cli` — `@851-labs/tokenmaxxing`, the `tokenmaxxing` CLI
- `packages/api-contract` — shared HttpApi contract (end-to-end types)
- `packages/db` — drizzle schema + D1 migrations

## Development

```bash
bun install
bun run dev        # alchemy dev: api :8788 + www :3002 on *.tokenmaxxing.localhost
bun run typecheck
bun run test
```

Run local development from the repo root; app-level Vite dev/preview scripts are
intentionally omitted because the web app depends on Alchemy/Cloudflare bindings.

Copy `.env.example` to `.env` and fill in the GitHub and Google OAuth pairs.
Dev callbacks are `http://api.tokenmaxxing.localhost:8788/auth/github/callback`
and `http://api.tokenmaxxing.localhost:8788/auth/google/callback`.
Run the CLI against the dev stack with
`TOKENMAXXING_ENV=development bun apps/cli/src/index.ts <command>`.

## Deploys

Every push to `main` deploys via GitHub Actions (typecheck + tests gate
it). Deploy state lives on a Cloudflare state-store worker
(`alchemy cloudflare bootstrap`), shared between CI and local machines —
`bun run deploy` does the same deploy locally, reading the prod OAuth pairs
from `.env.production`. Required repo secrets: `CLOUDFLARE_API_TOKEN`,
`TMX_GITHUB_CLIENT_ID`, `TMX_GITHUB_CLIENT_SECRET`,
`TMX_GOOGLE_CLIENT_ID`, `TMX_GOOGLE_CLIENT_SECRET`.

## CLI Releases

The CLI publishes to npm from the `Release CLI` GitHub Actions workflow.
Publishing is tag-based: bump `apps/cli/package.json`, commit the bump to
`main`, then push a tag named `cli-vX.Y.Z` that exactly matches the package
version.

```bash
git tag cli-vX.Y.Z
git push origin main
git push origin cli-vX.Y.Z
```

Before the first release from this workflow, configure npm trusted
publishing for package `@851-labs/tokenmaxxing` with repository
`851-labs/tokenmaxxing` and workflow `.github/workflows/release-cli.yml`.

## License

MIT
