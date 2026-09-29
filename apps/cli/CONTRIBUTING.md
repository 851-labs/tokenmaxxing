# Contributing to the CLI

`README.md` ships with the npm package. Notes for working on the CLI go here.

## Checks

`bun run check` and `bun run test` from the repo root cover the CLI along
with everything else.

## CLI e2e

Changes to the background service (`src/commands/service*.ts`), upgrades
(`src/commands/upgrade.ts`, `src/cli-version.ts`), ccusage (`src/ccusage/**`),
packaging (`script/**`, `package.json`), the API contract or the e2e itself
trigger the **CLI e2e** workflow on your PR. It builds this checkout the way a
release does and runs it on real runners:

- **Service**: the scheduler each OS really uses. Task Scheduler on
  `windows-latest` and `windows-11-arm` (no visible window, awkward profile
  paths, upgrade from an older release). launchd on `macos-latest`. systemd
  --user on `ubuntu-latest` and `ubuntu-24.04-arm`. Each installs the service,
  proves the scheduler itself ran the job, syncs to a local API sandbox, and
  covers status/doctor, the deferred repairs, the template migration from
  `0.7.0-alpha.0`, and paths with spaces and non-ASCII.
- **Shims**: global installs with npm, bun (with and without `--trust`),
  pnpm (with and without `--allow-build`) and yarn, then `tokenmaxxing --version`
  from every shell.
- **Upgrade**, on all five: `tokenmaxxing upgrade` and the service runner's
  auto-update against a local registry with fabricated versions and moving
  dist-tags. It checks that stable follows `latest`, prereleases follow their
  channel and never downgrade, and what happens when the registry is
  unreachable.

Production and the public npm registries are blocked on the runner. The check
is not required. If it fails, the job summary lists the failed checks, and the
artifacts hold the logs. To run it on any branch:

```bash
gh workflow run cli-e2e.yml --ref <branch>
```

Pass `-f suites=upgrade` (or `service`, `shims`) to run one suite. See
[e2e/README.md](e2e/README.md) for what each suite covers and how it works, and
[e2e/windows/README.md](e2e/windows/README.md) for the Windows service suite.

The CLI reads `TOKENMAXXING_NPM_REGISTRY` (default `https://registry.npmjs.org`)
for its version checks and service-runner downloads, and a service install
captures it. The e2e uses it to point the CLI at its local registry.

## macOS background item notifications

macOS Background Task Management (BTM) tracks the launchd plist
(`~/Library/LaunchAgents/sh.tokenmaxxing.sync.plist`) and the program it runs
(`tokenmaxxing.sh`). Measured on macOS 27.2 with a throwaway agent (2026-09-28):

- BTM re-checks every agent whenever anything in `~/Library/LaunchAgents`
  changes (any app's plist, not just ours). A `launchctl
bootout` + `bootstrap` with no file change triggers nothing.
- An unsigned item counts as modified when either file is replaced (atomic
  rewrite, new inode) or its mtime changes, **even with identical bytes**. A
  `chmod` (ctime only) does not count. Each modification gets a new record,
  marked "not notified", and posts "“tokenmaxxing.sh” can run in the
  background". After three posts BTM logs `Exceeded max notifications` and goes
  quiet for that item.
- A restart runs the same check at login: an agent whose program was touched
  before the restart notified after it, while unchanged agents (notified,
  "not notified", or past the cap) stayed silent. Restarts surface earlier
  rewrites; they do not re-notify on their own.
- A Developer ID-signed program is grouped under its developer. Changing the
  plist or replacing the binary with a new build signed by the same team logs
  `updated item with same LWCR` and posts nothing.

So the service only writes a file whose bytes differ, keeps the captured `PATH`
the same from any shell (`src/commands/service-path.ts`), and reloads the job
only when its definition changed or the loaded job differs from it. Any change
to the wrapper's bytes (a template bump, a changed source root) still shows the
notification once.

To watch BTM yourself (no sudo needed):

```bash
sfltool dumpbtm | grep -B4 -A10 'sh.tokenmaxxing'
```

```bash
/usr/bin/log stream --predicate 'process == "backgroundtaskmanagementd" OR process == "BackgroundTaskManagementAgent"'
```

Test with your own label and plist, and see below before running `service` or
`upgrade` locally.

## Running the CLI against a scratch setup

A local `service`, `upgrade` or `bootstrap` run acts on your real service
unless both of its halves are isolated:

- `TOKENMAXXING_CONFIG_DIR` holds the login, `service.json`, the wrapper and
  the runners.
- `HOME` holds the scheduler definition: `~/Library/LaunchAgents/sh.tokenmaxxing.sync.plist`
  (launchd) or `~/.config/systemd/user/tokenmaxxing-sync.*` (systemd, or
  under `XDG_CONFIG_HOME`). There is one per user, whatever the config dir.

With only the config dir isolated, `service install` rewrites the real plist
to run the scratch wrapper. `upgrade` checks that the installed definition
runs this config dir's wrapper and otherwise leaves it alone ("the installed
service uses another config dir"), but older CLIs do not. So set both, point
the package manager at a scratch prefix (`npm_config_prefix`, `BUN_INSTALL`,
`PNPM_HOME`), and use the API sandbox (`bun apps/api/script/sandbox-server.ts`)
rather than production:

```bash
export HOME="$(mktemp -d)" TOKENMAXXING_CONFIG_DIR="$(mktemp -d)"
```

Windows Task Scheduler tasks are per user too (`tokenmaxxing-sync`), so on
Windows use a throwaway VM or user.
