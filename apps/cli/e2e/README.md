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
- `fakes/` hold the fake `bun` (and, on macOS/Linux, `npx`) that scheduled
  runs find first on `PATH`, so syncs get fixed ccusage output.
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

| Scenario          | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup             | macOS: the runner has an Aqua session and a `gui/<uid>` launchd domain (fails loudly otherwise). Linux: lingering starts `user@<uid>.service`, `systemctl --user` answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| core              | Install writes the definition and the scheduler loads it: plist (`Label`, `ProgramArguments` = wrapper, `StartInterval` 300, log paths; `launchctl print` shows it loaded from that path every 300 s) or units (`Type=oneshot`, quoted `ExecStart`; timer `OnBootSec`/`OnUnitActiveSec` 5min, `Persistent`, enabled and active; `systemctl show` parses `ExecStart` back to the wrapper path; `systemd-analyze --user verify`). The wrapper is executable, parses, and captures the config dir, source roots, registry and `PATH`. The runner pointer points to this build. Runs started by the scheduler (kickstart / `systemctl --user start`) exit 0, log a successful sync, check in and ingest; rows land in the sandbox; auto-update reports `not-needed`. `status --json` and `doctor` are all OK, and `doctor` exits 0 with `health: "ok"` under `--json`. A `service install --refresh` that changes nothing keeps the definition and wrapper (same inode and mtime, which macOS Background Task Management watches) and does not reload the job (launchd run count kept; no `daemon-reload` in the user journal, with a positive control). `service repair` re-registers a job that was booted out or disabled while its files stayed the same. A missing runner pointer or runner exits 127. A revoked token fails the run and its deferred service-failure repair succeeds. A template mismatch makes the run report `reloadRequired` and its deferred repair restores the template; the next run is clean. Uninstall unloads the job and removes the definition, wrapper, metadata, state and runners, and keeps the login. |
| hanging ccusage   | A full run (no `service-sources.json`, as after every CLI update) whose ccusage hangs the way npx does on a black-holed network: the fake `bun` stays the parent of a `sleep` that never exits. The run stops after the first 180 s timeout instead of waiting out one per source, exits nonzero, logs the timed-out source and the rest as skipped (`runner_timed_out`), records the error in the state (doctor warns and exits 1), leaves no hung process or lock behind, and the next run syncs the skipped sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| bun without bun x | A full run whose `bun` takes the `x` of `bun x` for a script name and prints `error: Script not found "x"` (the fake `bun` with `no-bun-x`), as one Linux device's did on every run through 0.7.4. Every ccusage run falls back to the fake `npx`, and the run syncs without an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| path cases        | Install, run, reload-required repair, run, uninstall under `~/Library/Application Support/Zoë (Work)/tm` (macOS) or `~/.config/Zoë (Work) 100%/tm` (Linux), and `Zoë O'Neil (Work) & Co 100%/tm`. On Linux these caught two unit-file bugs: systemd expands `%` specifiers inside quotes, and it refuses an `ExecStart` executable containing a quote or backslash at all (so such wrappers run as `/bin/sh`'s argument). A third case, `O'Neil "dq" \back $HOME/tm`, runs a `daemon-reload` while the deferred repair is still pending on Linux: systemd re-parses the transient unit then, and 0.7.0's could not load a runner path with a quote or backslash. The repair must also start within a few seconds of the run. A config dir with a tab is refused by `service install` and `service repair` (`service_config_dir_unsupported`), and an existing install elsewhere keeps its definition and keeps running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| legacy upgrade    | Installs the pinned `0.7.0-alpha.0` release (template 5) and runs it, then stages this build's runner the way an auto-update does. The next run reports `reloadRequired` and its deferred repair migrates the service files; the run after is clean. `service repair` migrates a second legacy install at once; on launchd it re-bootstraps the agent only if the plist changed (the run count resets), and otherwise leaves the loaded job alone (the run count is kept).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

| Scenario                                | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stable follows latest                   | `0.6.8` → `0.6.9` via `npm install -g …@0.6.9 --prefer-online` (always an exact version); then skipped (`command: null`, `targetVersion: null`). No `.tokenmaxxing-<hash>` staging dir is left in the npm prefix after that second run (on Windows npm can't delete the one holding the exe that ran the upgrade; the next run removes it).                                                                                                      |
| prerelease follows its channel          | `0.7.0-alpha.1` → `0.7.0-alpha.9` by exact version; never "updates" to the lower `latest` 0.6.9; ignores the `alpha` tag moving back to `alpha.1`; moves to stable once `latest=0.7.0`; then follows `latest` only, with no npm staging dir left.                                                                                                                                                                                                |
| registry unreachable                    | Nothing listens on the registry URL. A prerelease fails with `upgrade_prerelease_version_check`, a stable install with `upgrade_version_check`; neither changes.                                                                                                                                                                                                                                                                                 |
| version check fails, packages reachable | The dist-tag endpoints answer 503. Both a prerelease and a stable install refuse and ask npm for nothing.                                                                                                                                                                                                                                                                                                                                        |
| stale npm cache after a publish         | npm caches the packument before `0.7.0` exists (`max-age=300`, as registry.npmjs.org sends); then `0.7.0` is published as `latest`. Control: a plain `npm install -g …@0.7.0` fails with `ETARGET`. `upgrade` installs `0.7.0` anyway (`--prefer-online`) and verifies it.                                                                                                                                                                       |
| packument lags the dist-tags            | The CLI's dist-tag check sees `0.7.0`, but npm's packument still says `latest=0.6.9` without `0.7.0`. `upgrade` fails as `upgrade_failed` and shows npm's `ETARGET`. It never installs the stale `0.6.9`, and the install stays on `0.6.8`.                                                                                                                                                                                                      |
| auto-update: stable runner              | A service installed at `0.6.8`. The OS scheduler starts each run, and the runner updates itself to `0.6.9` (pointer, `service.json` and `--version` agree), then reports `not-needed`. With the registry down it reports `download-failed`, stays on `0.6.9`, and still syncs. A `.tokenmaxxing-<hash>` staging dir planted in the npm prefix is removed by the next scheduled run on Windows (the live package stays) and left alone elsewhere. |
| auto-update: prerelease runner          | Installed at `0.7.0-alpha.1`: updates to `alpha.9`, is `not-needed` against the lower `latest`, stays put when the `alpha` tag moves back, reports `download-failed` with the registry down, and moves to `0.7.0` once `latest` is higher.                                                                                                                                                                                                       |

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
  npm prefix and package-manager global dirs. The scheduler definition is not
  in the config dir but under `HOME` (the launchd plist in
  `~/Library/LaunchAgents`, the systemd units in `~/.config/systemd/user`),
  one per user. `upgrade` refreshes the installed service only when that
  definition runs its config dir's wrapper, but a local run should still
  isolate `HOME` as well; see
  [Running the CLI against a scratch setup](../CONTRIBUTING.md#running-the-cli-against-a-scratch-setup).
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
