# CLI e2e

Real-OS checks for the CLI, run by
[`.github/workflows/cli-e2e.yml`](../../../.github/workflows/cli-e2e.yml) on
GitHub-hosted runners. Unit tests cannot see what these catch: a scheduler
that never starts the job, a unit file that mis-parses the config path, a
deferred repair that never runs, a console window that flashes on every
Windows sync, or an upgrade that installs the wrong dist-tag.

| Job                       | Runners                                                                        | Harness                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Service** (Windows)     | `windows-latest`, `windows-11-arm`                                             | [`windows/`](windows/README.md) (PowerShell: Task Scheduler + window watcher) |
| **Service** (macOS/Linux) | `macos-latest` (launchd), `ubuntu-latest`, `ubuntu-24.04-arm` (systemd --user) | [`posix/service-e2e.ts`](posix/service-e2e.ts)                                |
| **Shims** (Windows)       | `windows-latest`, `windows-11-arm`                                             | [`windows/run-shim-matrix.ps1`](windows/run-shim-matrix.ps1)                  |
| **Shims** (macOS/Linux)   | `macos-latest`, `ubuntu-latest`, `ubuntu-24.04-arm`                            | [`posix/shim-matrix.ts`](posix/shim-matrix.ts)                                |
| **Upgrade**               | all five                                                                       | [`upgrade/upgrade-e2e.ts`](upgrade/upgrade-e2e.ts)                            |

## Layout and why

One workflow, one path filter, one concurrency group. The Windows service
suite stays PowerShell: it is built around Win32 window watching and
`schtasks`, and it already works. Everything else is TypeScript run with
`bun`, so the pieces every OS needs exist once, in [`shared/`](shared/):

- `build-packages.ts` builds this checkout the way a release does (native
  runner package + main package) for the host, under any version.
- `registry-server.ts` is a local npm registry: several versions per package,
  dist-tags that the suites move mid-run, a switch that takes the version
  endpoints (or everything) down, and a request log. No uplink.
- `fakes/` hold the fake `bun` that scheduled runs find first on `PATH`, so
  syncs get fixed ccusage output.
- `harness.ts` has result rows, process helpers, the API sandbox
  ([`apps/api/script/sandbox-server.ts`](../../api/script/sandbox-server.ts)),
  the registry, and the production block. `scheduler.ts` drives launchd,
  systemd --user and Task Scheduler. `service.ts` has sandbox profiles and
  observed scheduled runs. `summarize.ts` renders results for every suite,
  PowerShell ones included.

The CLI reads `TOKENMAXXING_NPM_REGISTRY` (default
`https://registry.npmjs.org`) for its version checks and runner downloads, and
the service captures it into the scheduled wrapper. That is how the suites
point `upgrade` and the runner's auto-update at the local registry.

## Service (macOS / Linux)

Installs the build with `npm i -g` from the local registry and drives the real
scheduler against the API sandbox:

| Scenario       | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup          | macOS: the runner has an Aqua session and a `gui/<uid>` launchd domain (fails loudly otherwise). Linux: lingering starts `user@<uid>.service`, `systemctl --user` answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| core           | Install writes the definition and the scheduler loads it: plist (`Label`, `ProgramArguments` = wrapper, `StartInterval` 300, log paths; `launchctl print` shows it loaded from that path every 300 s) or units (`Type=oneshot`, quoted `ExecStart`; timer `OnBootSec`/`OnUnitActiveSec` 5min, `Persistent`, enabled and active; `systemctl show` parses `ExecStart` back to the wrapper path; `systemd-analyze --user verify`). The wrapper is executable, parses, and captures the config dir, source roots, registry and `PATH`. The runner pointer points to this build. Runs started by the scheduler (kickstart / `systemctl --user start`) exit 0, log a successful sync, check in and ingest; rows land in the sandbox; auto-update reports `not-needed`. `status --json` and `doctor` are all OK. A missing runner pointer or runner exits 127. A revoked token fails the run and its deferred service-failure repair succeeds. A template mismatch makes the run report `reloadRequired` and its deferred repair restores the template; the next run is clean. Uninstall unloads the job and removes the definition, wrapper, metadata, state and runners, and keeps the login. |
| path cases     | Install, run, reload-required repair, run, uninstall under `~/Library/Application Support/Zoë (Work)/tm` (macOS) or `~/.config/Zoë (Work) 100%/tm` (Linux), and `Zoë O'Neil (Work) & Co 100%/tm`. On Linux these caught two unit-file bugs: systemd expands `%` specifiers inside quotes, and it refuses an `ExecStart` executable containing a quote or backslash at all (so such wrappers run as `/bin/sh`'s argument).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| legacy upgrade | Installs the pinned `0.7.0-alpha.0` release (template 5) and runs it, then stages this build's runner the way an auto-update does. The next run reports `reloadRequired` and its deferred repair migrates the service files; the run after is clean. `service repair` migrates a second legacy install at once and re-registers it (launchd: the run count resets after bootout/bootstrap).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Positive controls.** Checks that files exist or commands succeed would pass
even if the scheduler never ran anything. So each OS proves the scheduler ran
the job by itself. On Linux the timer's `OnBootSec` has long passed on a CI
runner, so enabling it starts a run nobody asked for: the suite waits for that
run (`LastTriggerUSec`, the service's exit timestamp, the log and sandbox
check-in) before it starts anything. On macOS the agent has no `RunAtLoad`
(`runs = 0` after bootstrap), and the suite waits for launchd to start it on its
`StartInterval`, about 300 s after the last run (launchd counts the interval from
the job's last start, kickstarts included), and checks that run's log and
check-in. The error-path checks (exit 127, failed sync) show the run checks can
fail.

## Shims (macOS / Linux)

Installs the build with `npm i -g`, `bun add -g`, `bun add -g --trust`,
`pnpm add -g`, `pnpm add -g --allow-build` and `yarn global add`, each into its
own global dir, then runs `tokenmaxxing --version` through bash, sh and pwsh
and checks that exit codes pass through. It also checks what
`bin/tokenmaxxing` is after install, per
[#107](https://github.com/851-labs/tokenmaxxing/pull/107): npm and trusted Bun
installs swap the launcher for the verified native binary (their bins are
plain symlinks), and every other install keeps the JS launcher. pnpm and yarn
are pinned (`pnpm@10.34.5`, `yarn@1.22.22`) and installed before the block.
`knownIssues` works like the Windows `$KnownIssues`: XFAIL while it fails, and
XPASS (which fails the job) once it passes.

## Upgrade (all OSes)

Builds this checkout as `0.6.8`, `0.6.9`, `0.7.0-alpha.1`, `0.7.0-alpha.9` and
`0.7.0` and serves them all, starting with `latest=0.6.9` and
`alpha=0.7.0-alpha.9`:

| Scenario                                | Checks                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stable follows latest                   | `0.6.8` → `0.6.9` via `npm install -g …@latest`; then skipped (`command: null`, `targetVersion: null`).                                                                                                                                                                        |
| prerelease follows its channel          | `0.7.0-alpha.1` → `0.7.0-alpha.9` by exact version; never "updates" to the lower `latest` 0.6.9; ignores the `alpha` tag moving back to `alpha.1`; moves to stable once `latest=0.7.0`; then follows `latest` only.                                                            |
| registry unreachable                    | Nothing listens on the registry URL. A prerelease fails with `upgrade_prerelease_version_check` and does not change. A stable install still runs `@latest`, which fails in npm (`upgrade_failed`).                                                                             |
| version check fails, packages reachable | The dist-tag endpoints answer 503. A prerelease refuses and asks npm for nothing. A stable install runs `@latest` and lands on 0.6.9 (`versionCheck: "unavailable"`, `targetVersion: null`).                                                                                   |
| auto-update: stable runner              | A service installed at `0.6.8`. The OS scheduler starts each run, and the runner updates itself to `0.6.9` (pointer, `service.json` and `--version` agree), then reports `not-needed`. With the registry down it reports `download-failed`, stays on `0.6.9`, and still syncs. |
| auto-update: prerelease runner          | Installed at `0.7.0-alpha.1`: updates to `alpha.9`, is `not-needed` against the lower `latest`, stays put when the `alpha` tag moves back, reports `download-failed` with the registry down, and moves to `0.7.0` once `latest` is higher.                                     |

Every `upgrade --json` field that the no-downgrade rules depend on is
asserted: `channel`, `channelVersion`, `latestVersion`, `distTag`,
`targetVersion`, `command`, `skipped`, `updated`, `versionCheck` and `service`.

**Canary.** A version-selection regression must fail this suite. Pushes to
`e2e/canary-*` branches run only this suite, for exactly that check. In
[#111](https://github.com/851-labs/tokenmaxxing/pull/111), a branch that forced
an update whenever any version was known failed on every OS with real
downgrades (`0.7.0-alpha.9` → `0.7.0-alpha.1`, for both `upgrade` and the
runner). A branch whose comparison ignored prerelease identifiers left alpha
installs stuck. Both branches were then deleted.

## Guardrails

- **No production.** After setup the hosts file sends `api.tokenmaxxing.sh`,
  `tokenmaxxing.sh`, `www.tokenmaxxing.sh`, `registry.npmjs.org` and
  `registry.yarnpkg.com` to `0.0.0.0`, and a probe records that each one is
  unreachable. The only downloads (the pinned `0.7.0-alpha.0` runner package,
  pinned pnpm/yarn) happen before the block.
- **Isolated state.** Every scenario uses its own `TOKENMAXXING_CONFIG_DIR`,
  npm prefix and package-manager global dirs. `upgrade` refreshes the service
  in the config dir it resolves, so it must never see a real one.
- **Refuses to run outside CI** unless you pass `--force`. The suites edit the
  hosts file, register the scheduler job and install global packages, so only
  use `--force` on a throwaway VM.
- Path-filtered, not a required check, and superseded PR runs are cancelled.
  Results go to the job summary. On failure (or with the **artifacts** input)
  the output directory is uploaded: results, logs, the definitions and
  wrappers each scenario kept, the sandbox and registry request logs, and on
  Linux the user journal.

## Results

Each job writes `results.jsonl` (one row per check: suite, scenario, check,
status, detail) and `shared/summarize.ts` renders it into the job summary:
failures first, then every check in a collapsed table.

## Running it

```bash
gh workflow run cli-e2e.yml --ref <branch>
```

Add `-f suites=upgrade` (or `service`, `shims`) to run one suite. On a
disposable machine:

```bash
bun install
bun apps/cli/e2e/shared/build-packages.ts --out /tmp/tmx-e2e/pkgs --version 99.0.0-e2e.0
bun apps/cli/e2e/posix/service-e2e.ts --build /tmp/tmx-e2e/pkgs/build.json --force
bun apps/cli/e2e/upgrade/upgrade-e2e.ts --force
```
