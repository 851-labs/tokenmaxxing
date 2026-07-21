# @851-labs/tokenmaxxing

CLI for [tokenmaxxing](https://tokenmaxxing.sh) — the social leaderboard
for LLM token usage. Parses your local agent usage (Claude Code, Codex,
OpenCode, Antigravity CLI, legacy Gemini CLI, Copilot CLI) via
[ccusage](https://github.com/ryoppippi/ccusage) and a dedicated local
Antigravity collector, then pushes daily aggregates
to your public profile.

## Usage

```bash
npm install -g @851-labs/tokenmaxxing@latest
tokenmaxxing login              # sign in in the browser, approves this device
tokenmaxxing sync               # parse local usage and push it
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
Use `tokenmaxxing service status` for the last run and `tokenmaxxing service
doctor` to inspect scheduler files, auth, auto-update, locks, and recent logs.

Run `sync` as often as you like, from as many machines as you like —
profiles aggregate across devices. Useful flags: `--dry-run`,
`--since YYYY-MM-DD`, `--sources claude,codex`, `--json`.

Antigravity CLI usage is read locally from current SQLite conversations under
`~/.gemini/antigravity-cli/conversations/` and stored as `antigravity-cli`.
Deprecated Gemini CLI history remains a separate `gemini` source. You can select
either explicitly with `--sources antigravity-cli,gemini`.

### What gets uploaded (privacy)

Daily aggregates only: date, model name, agent name, token counts, and the
API-equivalent cost — never prompts, file paths, project names, or session
content. Revoke access anytime with `tokenmaxxing logout` or from
[settings](https://tokenmaxxing.sh/settings).

## License

MIT
