# @851-labs/tokenmaxxing

CLI for [tokenmaxxing](https://tokenmaxxing.sh) — the social leaderboard
for LLM token usage. Parses your local agent usage (Claude Code, Codex,
OpenCode, Gemini CLI, Copilot CLI, Hermes, Pi) via
[ccusage](https://github.com/ryoppippi/ccusage) and pushes daily aggregates
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
detected. Custom log roots (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`)
are captured at `tokenmaxxing service install` or `tokenmaxxing service
repair`; rerun one of those after changing them. Without `HERMES_HOME`, Hermes
usage includes every named profile under `~/.hermes/profiles/`.
Use `tokenmaxxing service status` for the last run and `tokenmaxxing service
doctor` to inspect scheduler files, auth, auto-update, locks, and recent logs.

Run `sync` as often as you like, from as many machines as you like —
profiles aggregate across devices. Useful flags: `--dry-run`,
`--since YYYY-MM-DD`, `--sources claude,codex`, `--json`. `sync` exits
non-zero when no agent's usage could be collected; if only some agents fail,
it still uploads the rest and exits 0 with `"status": "partial"` in `--json`
output.

### What gets uploaded (privacy)

Daily aggregates only: date, model name, agent name, token counts, and the
API-equivalent cost — never prompts, file paths, project names, or session
content. Revoke access anytime with `tokenmaxxing logout` or from
[settings](https://tokenmaxxing.sh/settings).

## License

MIT
