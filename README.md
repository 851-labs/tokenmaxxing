<div align="center">
  <h1><b>tokenmaxxing</b></h1>
  <p>
    The best place to track token usage<br>
    A local CLI, built on ccusage, that syncs your token usage with everyone else.
  </p>
</div>

<div align="center">
  <a href="https://tokenmaxxing.sh">
    <img src="https://img.shields.io/website?url=https%3A%2F%2Ftokenmaxxing.sh&label=tokenmaxxing.sh&style=flat" alt="tokenmaxxing.sh">
  </a>
  <a href="https://www.npmjs.com/package/@851-labs/tokenmaxxing">
    <img src="https://img.shields.io/npm/v/%40851-labs%2Ftokenmaxxing?label=npm&style=flat" alt="npm version">
  </a>
  <a href="https://www.npmjs.com/package/@851-labs/tokenmaxxing">
    <img src="https://img.shields.io/npm/dm/%40851-labs%2Ftokenmaxxing?label=downloads&style=flat" alt="npm downloads">
  </a>
  <a href="https://github.com/851-labs/tokenmaxxing">
    <img src="https://img.shields.io/github/stars/851-labs/tokenmaxxing?style=flat" alt="GitHub stars">
  </a>
  <a href="https://discord.gg/WzX6BpfaRH">
    <img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white&style=flat" alt="Join the tokenmaxxing Discord">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT License">
  </a>
</div>

<br>

<div align="center">
  <a href="https://tokenmaxxing.sh">
    <img src="docs/screenshots/leaderboard.png" alt="tokenmaxxing bootstrap command and public leaderboard">
  </a>
</div>

## Installation

```bash
npm install -g @851-labs/tokenmaxxing@latest
tokenmaxxing bootstrap
```

`bootstrap` signs you in, syncs the usage already on your machine, optionally
installs automatic syncing, and opens your public profile.

You can also install with
`bun add -g --trust @851-labs/tokenmaxxing@latest`,
`pnpm add -g @851-labs/tokenmaxxing@latest`, or
`yarn global add @851-labs/tokenmaxxing@latest`.

## How it works

tokenmaxxing uses [ccusage](https://ccusage.com/) to read local coding-agent
usage, turn it into daily token and API-equivalent spend totals, and sync those
aggregates to your public profile. The leaderboard lets you compare spend or
tokens over the last 7 days, 30 days, or all time.

Sync is idempotent and profiles aggregate across devices, so you can run
`tokenmaxxing bootstrap` on every machine and sync as often as you like.

## Supported agents

- Claude Code
- OpenAI Codex
- OpenCode
- Gemini CLI
- GitHub Copilot CLI
- Pi

## Usage

```bash
tokenmaxxing sync                         # Sync all local usage
tokenmaxxing sync --dry-run               # Preview exactly what would be sent
tokenmaxxing sync --since 2026-01-01      # Only sync usage on or after a date
tokenmaxxing sync --sources claude,codex  # Only sync selected agents

tokenmaxxing service install              # Sync automatically every 5 minutes
tokenmaxxing service status               # Show service health and the last run
tokenmaxxing service doctor               # Inspect auth, scheduler, locks, and logs

tokenmaxxing whoami                        # Show the signed-in account
tokenmaxxing upgrade                       # Upgrade the CLI and refresh the service
tokenmaxxing logout                        # Revoke this device's CLI token
```

The background service supports macOS, Linux, and Windows. It uses the global
`tokenmaxxing` binary and keeps itself current through the package manager that
installed the CLI when that package manager can be detected.

## Privacy

Only daily aggregates are uploaded: date, model name, agent name, token counts,
and API-equivalent cost. tokenmaxxing never uploads prompts, file paths, project
names, code, or session content. Preview the exact payload anytime with
`tokenmaxxing sync --dry-run`.

Profiles and leaderboard totals are public. Device hostnames are visible only
to you in settings and your per-device breakdown. CLI tokens do not expire
automatically; revoke one with `tokenmaxxing logout` or from
[settings](https://tokenmaxxing.sh/settings).

## Support

Join the [Discord](https://discord.gg/WzX6BpfaRH), follow
[@pondorasti](https://x.com/pondorasti), or
[open an issue](https://github.com/851-labs/tokenmaxxing/issues).
If you like tokenmaxxing, please consider giving the project a star.

## License

This project is released under the [MIT License](LICENSE).
