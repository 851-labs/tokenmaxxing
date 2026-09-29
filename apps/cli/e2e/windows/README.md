# Windows e2e

Real-Windows checks for the CLI's Task Scheduler service and its global-install
shims: the Windows jobs of [`.github/workflows/cli-e2e.yml`](../../../../.github/workflows/cli-e2e.yml),
on `windows-latest` (x64) and `windows-11-arm`. See [the e2e overview](../README.md) for
the macOS/Linux jobs and the upgrade suite that also runs here. Unit tests cannot see what these
catch: a console window that flashes up on every scheduled sync, `cmd.exe`
misparsing a profile path, or a deferred repair that never runs.

GitHub's hosted Windows runners log `runneradmin` on at the console. A task
registered by `schtasks` runs in that interactive session, so any window it
opens is really on screen and the watcher can see it. The first step asserts
this and fails the job if the session isn't interactive.

## When it runs

- On pull requests and pushes to `main` that touch the service
  (`apps/cli/src/commands/service*.ts`, `service-runner-targets.ts`), ccusage
  (`apps/cli/src/ccusage/**`), packaging (`apps/cli/script/**`,
  `apps/cli/package.json`), the API contract (`packages/api-contract/**`), the
  sandbox API, or the harness and workflow themselves.
- By hand: Actions → **CLI e2e** → **Run workflow**, or
  `gh workflow run cli-e2e.yml --ref <branch>` (`-f suites=service` for just the
  service jobs). Tick **artifacts** to keep logs and screenshots from a passing
  run as well.

It is not a required check. It only runs on some paths, and a required check
that is skipped would block merges. Each job takes about 10 minutes.

## Jobs

**Service** (`run-service-e2e.ps1` → `service-e2e.ps1`) builds this checkout
the way a release does (`../shared/build-packages.ts`). It serves the build from a local
registry (`../shared/registry-server.ts`) and installs it with `npm install -g`. Then it
runs these scenarios against the real API over sqlite
(`apps/api/script/sandbox-server.ts`), with a fake `bun` first on `PATH` so
scheduled runs get fixed ccusage output (`../shared/fakes/`):

| Scenario       | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| window watcher | The watcher sees a hidden `cmd.exe` that lives for milliseconds (and no window for it), and a visible one together with its console window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| core           | Install registers the task: `/XML`, a `wscript.exe //B` Command, the launcher in Arguments, the config dir as WorkingDirectory, an interactive token. The `.vbs` is ASCII with CRLF. A scheduled run gives Last Result 0, a `service.log` entry, a check-in and ingest, and rows stored in the sandbox. A missing runner pointer or runner gives 127, and a missing wrapper or launcher gives a nonzero result. `doctor` exits 0 with no WARN or FAIL check on the healthy install. `status --json` and `doctor` report the launcher as missing (FAIL, exit 1) or outdated (WARN), and `service repair` restores it. A lock left by a dead process (`taskkill /F`, a crash) is taken over by the next run, and `doctor` says so (INFO, exit 0). The service-failure repair (revoked token) and the reload-required repair (template mismatch) both run hidden. Uninstall removes the task, `.vbs` and `.cmd`. |
| overlapping    | A run whose `service.log` another process holds (the way `cmd`'s `>>` holds it for a whole run) logs to `service-overlap-1.log`, leaves the held log and its rotations alone, and still syncs. Then the task, a second `schtasks /Run` while it runs, and two launcher runs by hand start together: the second `/Run` starts nothing (`MultipleInstancesPolicy` `IgnoreNew`), exactly one run syncs, the other two each log a locked skip in a side log, nothing shows a window, and `doctor` stays clean.                                                                                                                                                                                                                                                                                                                                                                                                    |
| path cases     | Install, run, the reload-required repair, another run and uninstall, under `Tm (Work)`, `Tm & Co's`, `Zoë` and `Zoë O'Neil (Work) & Co 100%`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| legacy upgrade | Installs the pinned release `0.7.0-alpha.0` (template 5, whose task runs the `.cmd` directly), then swaps in this build's runner the way an auto-update does. The next scheduled run's hidden repair re-registers the task through `wscript` without rewriting the running wrapper, and the following run shows no window. `service repair` migrates a second legacy install directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Every task run is recorded by `window-watch.ps1`. It polls nothing:
process starts come from WMI's `Win32_ProcessStartTrace` (the kernel's process
trace, so no start is missed however short the process lives), and windows and
focus from `SetWinEventHook` (`EVENT_OBJECT_SHOW`, `EVENT_OBJECT_UNCLOAKED`,
`EVENT_SYSTEM_FOREGROUND`), described in the callback before they can close
(`lib/watch-events.ps1`, inline C#). The process trace needs an administrator
token, which the hosted runners have. Before a run starts, the watcher proves
both sources live with a self-test window and a probe process, and before it
stops it waits for one more probe so every start is in.

A new visible window or a foreground change fails the check when it belongs
to the run's process tree: the task's action (or, for a control, the process
the harness started) and everything it starts, from the parent pids the
process trace records. Windows Terminal and its OpenConsole count too, since a
console of ours lands there when it is the default terminal. Anything else is
ignored but listed in the check with its process and parent: the
windows-11-arm image runs `wsl.exe --update` in a console now and then. Two
things keep the watcher from passing blind:

- Each run must show the processes it is known to start: the task's action
  (the `wscript.exe` launcher, or `cmd.exe` for the legacy `.cmd` task) and
  every deferred repair it spawns (a `wscript.exe` started by the runner),
  however briefly they lived. WMI hands process starts over in batches about a
  second apart, so a command line is only there for a process still running
  by then; the check goes by the process tree, not the command line.
- Positive controls: the window watcher scenario's visible `cmd.exe`, and the
  legacy task's console, must both be caught.

Nothing reaches production. The hosts file sends `api.tokenmaxxing.sh`,
`tokenmaxxing.sh`, `www.tokenmaxxing.sh` and `registry.npmjs.org` to `0.0.0.0`
after setup, and a probe confirms each one is unreachable. Blocking the
registry also keeps runner auto-update and the `npx ccusage` fallback from
pulling real releases. The only network fetch is the pinned legacy runner
package, which happens before the block.

**Shims** (`run-shim-matrix.ps1`) installs the build with `npm i -g`,
`bun add -g` and `bun add -g --trust`. It runs `tokenmaxxing --version` through
`cmd.exe`, `pwsh` and Windows PowerShell 5.1 for each. To extend it, add a row
to `$Installers` or `$Shells`. To land a check before its fix, list the installer in
`$KnownIssues`: it records XFAIL while it fails. Once it passes it records
XPASS, which fails the job, so the entry is removed together with the fix.
`bun add -g --trust` was listed there until
[#107](https://github.com/851-labs/tokenmaxxing/pull/107) fixed
[#28](https://github.com/851-labs/tokenmaxxing/pull/28); the table is empty now.

## Results

Each job writes `results.jsonl` (one row per check: suite, scenario, check,
status, detail) and `../shared/summarize.ts` renders it to the job summary, the
same way as the TypeScript suites. Failures come first, then
every check in a collapsed table. When a job fails, the whole output
directory is uploaded as an artifact: results, logs, task XML, the generated
`.vbs`/`.cmd`, per-run window-watch events and screenshots, and the sandbox
request log.

## Trimmed from the original harness

- Only four path cases. Plain spaces and `Zoë (Work)` are covered by the
  others.
- One scheduled run before the error paths instead of two. The runs after
  repair cover repeated runs.
- No pre-launcher "baseline" variant of the whole suite. The pinned legacy
  release plays that role in the upgrade scenario and as the watcher's positive
  control.
- The shim checks run as a separate job and no longer decide which install
  the service job uses. The service job always installs with `npm i -g`.

## Running it elsewhere

The scripts register the machine-wide `tokenmaxxing-sync` task, edit the
hosts file and install global packages. Outside CI they refuse to run unless
you pass `-Force`, so only do that on a throwaway Windows VM with an
interactive session:

```powershell
bun install
bun apps/cli/e2e/shared/build-packages.ts --out $env:TEMP\tmx-e2e\pkgs --version 99.0.0-e2e.0
apps/cli/e2e/windows/session-probe.ps1 -OutDir $env:TEMP\tmx-e2e\out
apps/cli/e2e/windows/run-service-e2e.ps1 -BuildJson $env:TEMP\tmx-e2e\pkgs\build.json -Force
```
