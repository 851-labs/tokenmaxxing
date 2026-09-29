# Changelog

All notable changes to tokenmaxxing are documented here. Versions are anchored to the
`cli-v*` release tags because the CLI is the project's current released artifact.

## Unreleased

### Changed

- `tokenmaxxing service doctor` now exits 1 when any check is `WARN` or `FAIL`, and 0 when every
  check is `OK` or `INFO`, so scripts and CI can gate on it. It used to exit 0 whatever it found.
  A new `FAIL` level marks what stops scheduled syncs (scheduler missing or inactive, a missing
  definition, wrapper or launcher, a broken runner, no stored login); `WARN` is for what doesn't.
  `--json` adds `health` (`ok`, `warn` or `fail`) and a `fix` for each problem check; `status`
  still only says the doctor ran. Fine states stay `INFO` and exit 0: never synced yet, a lock held
  by a running sync, or a lock left by a run that died, which the next run takes over.
- `service doctor` lines now say what's good when `OK` and what's wrong plus the one command that
  fixes it when `WARN` or `FAIL`. `OK active` no longer says "repair with tokenmaxxing service
  repair" and names what's active (for example `loaded in launchd (gui/501/sh.tokenmaxxing.sync)`).
  With nothing installed for the config dir, doctor says to run `tokenmaxxing service install`
  (not `service repair`, which refuses) and skips the checks of files that don't exist.
- `service status` and `service doctor` word the lock, auto-update and scheduler the same way.
  `status` no longer tells you to upgrade the CLI when only the runner auto-updated past it. Both
  show the first line of the last run's error instead of the whole multi-line message.

### Fixed

- A scheduled sync no longer fails on one dropped login check (`/me`). It retries network errors,
  timeouts, server errors (5xx) and rate limits (429, waiting out a `Retry-After` of up to 10 s)
  3 times, 1 s then 4 s apart, so a run that starts while a Mac is still waking from sleep gets
  through. `sync` and `whoami` retry once, after half a second (not after a timeout). A revoked
  token (`Unauthorized`) is never retried and is handled as before.
- A failed login check now says what happened instead of only "failed to validate stored login":
  a timeout, a network error with its code (`network unavailable (ENOTFOUND)`,
  `network error (ECONNRESET)`), the HTTP status plus the error's `_tag`, or a response the CLI
  couldn't read, and how many attempts it made. The service log line gets a `loginCheck` field
  (`attempts`, `kind`, `code`, `status`, `tag`, `timeoutMs`), `sync --json` errors get the same
  `loginCheck` object, and the service's last error ends in "will retry next run" when the next
  run can succeed (no repair is scheduled for those). Other API errors (upload, whoami, login)
  also name the network error code or HTTP status when they have no more specific wording.
- When ccusage fails for every agent (for example `node` missing from the service's `PATH`), the
  error names only the agents with logs on this machine and counts the rest ("ccusage failed for
  claude, codex and 16 agents without logs") instead of listing all 18.

## 0.7.0-alpha.4 - 2026-09-29

### Upgrading from 0.7.0-alpha.2 or earlier

- On Windows, reinstall an `npm install -g --prefix <dir>` install once by hand:
  `npm install -g --prefix <dir> @851-labs/tokenmaxxing@latest`. `tokenmaxxing upgrade` from
  alpha.2 or earlier installs into npm's default prefix instead, so the copy on `PATH` stays old.
- Upgrade the global CLI before running `tokenmaxxing service repair`. A repair from an alpha.2 or
  older global CLI can briefly move the service back to that version; the service updates itself
  again on its next run.

### Changed

- `tokenmaxxing service repair` and `service install --refresh` now refuse to run when the
  installed service's template is newer than the CLI's (an auto-update already moved the service
  forward), instead of moving it back. `service status` and `service doctor` say "the service is
  newer than this CLI (template 8 vs 7); upgrade the CLI" instead of "Reload required: yes". This
  helps from 0.7.0 on; older CLIs can't know about it.
- `tokenmaxxing upgrade --json` errors now include the command that ran and the package manager's
  output (`command`, `output`), or for an upgrade that didn't take effect, `command`,
  `commandPath`, `expectedVersion` and `installedVersion`. The JSON used to drop everything but
  the first line and the hint.

### Fixed

- A service run no longer blocks automatic sync for 30 minutes when ccusage hangs (for example
  `npx ccusage` on a network that drops packets). Each source waited out its own 180 s timeout, so
  a full run (the first after every CLI update) of 18 sources took 54 minutes; systemd killed it
  after 30 with nothing recorded. After a ccusage timeout a run now skips the remaining sources
  (`runner_timed_out`), and no source starts more than 10 minutes into a run (`run_deadline`); the
  next run picks the skipped sources up. The service log and state record what was skipped, so
  `service doctor` shows it.
- On Windows, `service repair` and `service install --refresh` from a shell whose
  `TOKENMAXXING_CONFIG_DIR` differs from the installed one only in case no longer re-register the
  task and rewrite the service files in the new spelling. They keep the installed spelling and
  change nothing.
- On Windows, `service doctor` no longer reports a changed source root for an agent data
  directory whose path contains `%`.
- `tokenmaxxing login` no longer waits forever for an API that accepts the connection but never
  answers: starting a login gives up after 15 s, and a login check that takes longer is retried
  within the login's usual time limit.
- `tokenmaxxing login` now says how long to wait when starting a login is rate limited by
  something in front of the API (an HTML 429 with `Retry-After`), instead of "check your network".
- A server error (HTTP 5xx) from the API now says it's a server error and to try again later,
  instead of "check your network" (for example "failed to validate stored login").
- `service doctor` no longer says a lock from another machine (a config dir on a synced drive)
  will be taken over on the next run because its pid isn't running here. It names the machine
  instead.
- `service status` now flags a missing, empty or broken service runner instead of printing the
  version `service.json` records.
- `tokenmaxxing service repair --json` run by hand now reports its own reason (`manual` when
  nothing needed repair), not the reason of the last automatic repair.

## 0.7.0-alpha.3 - 2026-09-29

### Changed

- `tokenmaxxing upgrade` now installs the exact version the registry reports (for example
  `npm install -g @851-labs/tokenmaxxing@0.7.0 --prefer-online`, `bun add -g …@0.7.0 --no-cache`),
  never a dist-tag. When the registry can't be reached it now stops for stable installs too,
  as it already did for prereleases. Before, it ran `@latest` without knowing which version
  that would install.

### Fixed

- `tokenmaxxing upgrade` could install an older release and still report success. npm resolved
  `@latest` from a packument it had cached before the release, and `bun update -g --latest` could
  do nothing. Upgrade now checks `tokenmaxxing --version` after installing. If the new version
  isn't what runs, it fails with `upgrade_verification` instead of reporting `updated: true`.
  Right after a release it also no longer fails with npm's `ETARGET` for up to 5 minutes.
- When the package manager fails, `tokenmaxxing upgrade` now shows the command it ran and the
  package manager's own error output (for example npm's `ETARGET`), instead of only "failed to
  upgrade tokenmaxxing".
- `tokenmaxxing upgrade` no longer refreshes a service that another config dir installed. The
  launchd plist and systemd units live under `HOME`, so an upgrade run with a different
  `TOKENMAXXING_CONFIG_DIR` rewrote them to point at that config dir.
- `tokenmaxxing sync` no longer hangs on "Uploading usage" when the API accepts the connection
  but never answers. An upload now times out after 60 s, the same limit each scheduled attempt
  already had. Checking the stored login times out after 15 s.
- When the API rate-limits a request (HTTP 429), `sync`, `login` and `whoami` now say how long
  to wait ("try again in 60 s"). Before, they told you to check your network or log in again.
- A `config.json` that is valid JSON but not a config (`null`, or `{"apiUrl": 123}`) now fails
  with "CLI config is not valid" and the file's path, instead of "unexpected CLI failure".
- `tokenmaxxing sync` now says when neither bun nor npx is installed, and how to fix it, instead
  of only "ccusage failed for …". When ccusage fails for another reason, the error names the
  reason for each agent.
- `tokenmaxxing` now exits with 128 + the signal number when a signal stops it, for example 143
  for `SIGTERM` (it used to exit 130 for every signal). It also handles `SIGHUP`, which used to
  kill it without stopping the running ccusage process.
- A ccusage run that hangs no longer keeps the service running forever. ccusage now runs in its own
  process group, and a timeout or interruption stops the whole group; before, a `node` that npx
  or bun had started kept running. The CLI also exits as soon as its work is done. On Linux, a
  scheduled run's unit then finishes (it stayed "activating" and blocked the timer). The systemd
  unit also gets `TimeoutStartSec=30min` as a backstop.
- A run killed by `SIGKILL`, the OOM killer or a power loss no longer blocks automatic sync for 2
  hours. The next run takes over a lock whose process is gone. `service doctor` says whether a held
  lock's process is still running, and how to clear it.
- `tokenmaxxing service repair` or `service install` from an older global CLI no longer moves an
  auto-updated service runner back to the CLI's own, older version.
- A scheduled run in which every agent's ccusage failed now exits non-zero, so systemd, launchd
  and Task Scheduler record a failure. The log and `sync --json` include the end of ccusage's
  stderr (for example `/usr/bin/env: 'node': No such file or directory`).
- On Linux, automatic sync keeps working after a reboot for services installed from an fnm shell
  by 0.7.0-alpha.0 or alpha.1. Their script ran node from a per-shell fnm directory under
  `/run/user`, which a reboot deletes. The service template moves to version 7, so each service
  rewrites its script once, now pointing at fnm's default alias. On macOS this shows
  "“tokenmaxxing.sh” can run in the background" one more time.
- `service doctor` now reports a broken service runner (a missing, empty or non-executable runner,
  or a pointer file that doesn't name one) instead of "OK", and says when `service.json` is missing
  (auto-update is off until `service repair`). `service status` no longer says "service not
  installed" in that case.
- `service run` and `service repair` failures now name their cause (for example a read-only config
  dir), in the terminal and in the service log. Before, `service repair` printed "unexpected CLI
  failure".
- Scheduled uploads that get HTTP 429 now wait for the time in `Retry-After`. When that is more
  than a minute they stop retrying and leave it to the next run.
- A failed scheduled run's log line no longer repeats the previous run's rows and `syncStatus`.
- `service install --refresh` keeps the original `installedAt`, so an unchanged `service.json` is
  no longer rewritten.
- On Windows, `service install --refresh` (run by every upgrade) and `service repair` no longer
  re-register the scheduled task when it is unchanged. Re-registering rewrote the task and
  restarted its schedule from that moment. A refresh during a sync no longer fails with `EPERM`,
  because an unchanged service runner is no longer copied over itself.
- A scheduled run that fails because the API is unreachable, slow, rate-limited or answering
  5xx no longer schedules a repair (on Windows, a new task every 5 minutes while offline). The
  repair after any other failed run no longer re-registers a scheduler that is active and current.
- `tokenmaxxing service repair` no longer installs a service when none is installed for its
  config dir. It also no longer re-points a scheduler that another config dir installed, for
  example when run from a shell without that service's `TOKENMAXXING_CONFIG_DIR`. It stops with
  `service_not_installed` or `service_owned_elsewhere` instead. `upgrade` applies the same check
  on Windows.
- `tokenmaxxing upgrade` of an `npm install -g --prefix <dir>` install now updates it in that
  prefix. Before, npm installed a second copy into its default prefix and the one on `PATH`
  stayed old.
- On Windows, `service install` and `service repair` refuse to run elevated ("Run as
  administrator", or an administrator's SSH session) when UAC gives the user a limited token
  day to day. A task registered from such a shell can only be changed from one, so every later
  refresh or repair failed with "Access is denied". That error now says how to fix it. The
  built-in Administrator account, and machines with UAC off, are not refused.

## 0.7.0-alpha.2 - 2026-09-28

### Added

- `TOKENMAXXING_NPM_REGISTRY` points the CLI's version checks and service-runner downloads at
  another npm registry (a mirror, or the CLI e2e's local registry). A service install captures
  it for scheduled syncs.

### Changed

- `tokenmaxxing login` now waits out the server's new per-network login rate limit (HTTP 429,
  honouring its retry delay) instead of failing mid-login, and explains a rate-limited start.

### Fixed

- `tokenmaxxing upgrade` now works for npm global installs on Windows. Their shim sits directly
  in the npm prefix, so the install method was not detected and upgrade stopped with "could not
  detect how tokenmaxxing was globally installed".
- On Linux, automatic sync now runs when the config directory contains `%`, a quote or a
  backslash (for example `/home/o'neil`). systemd refused to load the unit (`bad-setting`), so
  the timer never synced even though `service install` reported success. Run
  `tokenmaxxing service repair` to rewrite an affected unit.
- On macOS, updating the CLI (and later, restarts or other apps' login items changing) no
  longer shows "“tokenmaxxing.sh” can run in the background" again. Every update rewrote the
  launchd plist and the service script with the same content and reloaded the job, and macOS
  treats any rewritten file as a new background item. Service refreshes and repairs now leave
  unchanged files alone and only reload the scheduler (launchd or systemd) when its definition
  changed or it is not running what is on disk. The script also keeps the same `PATH` from any
  terminal: per-shell fnm directories resolve to fnm's default alias, and temporary, agent
  session, project `node_modules/.bin` and app-bundle directories are left out.
- On macOS and Linux, a Ctrl+C or `kill` that arrives while `tokenmaxxing` is still starting
  is now passed on to the native binary instead of killing only the npm launcher and leaving
  the binary running.

## 0.7.0-alpha.1 - 2026-09-26

### Added

- Added Grok Build CLI, Antigravity, ZCode, Amp, Qwen Code, Kimi CLI, Kilo Code, Goose, Droid,
  Codebuff, and OpenClaw as supported sources (`--sources grok,antigravity,zcode,amp,qwen,kimi,`
  `kilo,goose,droid,codebuff,openclaw`), each read through its focused ccusage subcommand.
- Scheduled syncs now keep custom data directories for those agents (`GROK_HOME`,
  `ANTIGRAVITY_DATA_DIR`, `ZCODE_HOME`, `AMP_DATA_DIR`, `QWEN_DATA_DIR`, `KIMI_DATA_DIR`,
  `KILO_DATA_DIR`, `GOOSE_PATH_ROOT`, `DROID_SESSIONS_DIR`, `CODEBUFF_DATA_DIR`, `OPENCLAW_DIR`).

### Changed

- Required ccusage 20.0.22 or newer, the first release with every supported adapter (Antigravity
  and ZCode arrived in 20.0.21) and with `claude-fable-5-1` usage counted again.

### Fixed

- Scheduled syncs now carry custom `CLAUDE_CONFIG_DIR` and `CODEX_HOME` log roots, like
  `HERMES_HOME`, so the background service reads the same Claude and Codex usage as a manual
  `sync`. Rerun `tokenmaxxing service repair` after changing a root; `service doctor` now warns
  when the service's roots differ from your shell. Thanks @maxmoneycash (#71).
- Hermes usage now includes named profiles (`~/.hermes/profiles/<name>/state.db`) alongside the
  default root when `HERMES_HOME` is unset, in both `sync` and scheduled runs. Thanks @kvnloo (#68).
- On Windows, the scheduled sync no longer opens a console window or steals focus every five
  minutes: the task runs through a hidden `wscript` launcher, existing installs migrate
  automatically, and config paths with spaces, `&`, `'`, parentheses or non-ASCII characters now
  work. Thanks @sybrengg (#38) and @tanqyry (#72); fixes #57.
- `bun add -g --trust` (and `yarn global add`) installs now work on Windows: the package `bin` is
  a small launcher that runs the verified native binary. Thanks @Iydah (#28).
- `tokenmaxxing upgrade` and the service's auto-updater never downgrade: prerelease installs follow
  their channel (e.g. `alpha`) and move to `latest` only when it is newer. `upgrade --json`
  reports `command: null` when nothing runs and adds `channel`/`channelVersion`.
- Scheduled syncs skip sources whose logs haven't changed and only rebuild session counts on the
  6-hourly reconcile, cutting background CPU for large Codex logs. `service run --force` runs every
  source. Thanks @NubsCarson for the report (#69).

### Server

- The API accepts the new sources on `/usage/ingest` and `/usage/sync`, and the site labels them
  on the stats page, home page, FAQ, privacy policy, and llms.txt.
- Re-syncing unchanged usage no longer re-prices history: stored cost is kept unless token counts
  change (ccusage prices older Codex sessions from your current Fast/Standard config).
- The production API only trusts `https://tokenmaxxing.sh` for CORS and sign-out.

## 0.7.0-alpha.0 - 2026-09-23

### Changed

- `tokenmaxxing login` now uses a device-code flow: only the CLI that started a login can collect
  its token, and the browser asks you to confirm the device before approving. Older CLIs keep
  working with the previous flow until 2027-11-01.
- Scheduled syncs re-send the last 21 days every 6 hours (and on the first run after upgrading),
  so past days that ccusage later re-counts are corrected on the leaderboard. Override the window
  with `TOKENMAXXING_SYNC_WINDOW_DAYS` (1–90).

### Fixed

- Fixed every command failing with "Missing required flag" (for example `--json`) in builds from
  the updated CLI framework, including the scheduled `service run --scheduled`.
- `sync` now exits non-zero when every source fails, and rejects `--since` values that are not a
  real `YYYY-MM-DD` date.
- Login and sync errors now show the server's message (for example an expired login code).
- A stored token is only cleared when the server says it is invalid, not on transient errors.

### Server

- Usage uploads are validated more strictly (dates, token counts, sources, sizes); future-dated
  days are dropped instead of counted, and bad rows from older CLIs no longer reject a whole sync.
- API errors now return a consistent JSON body with a `_tag` and `message`.

## 0.6.0 - 2026-08-05

### Added

- Added Hermes Agent as a supported ccusage source.

### Fixed

- Preserved day-level reasoning tokens that ccusage omits from per-model breakdowns.
- Carried custom `HERMES_HOME` locations into scheduled syncs.

## 0.5.1 - 2026-07-30

### Fixed

- Required ccusage 20.0.19 or newer to prevent replayed Codex subagent history from inflating usage totals.
- Treat successful raw daily reports as authoritative device/day/source slices so corrected
  backfills remove stale model rows, and run one full Codex replay after service upgrades.

## 0.5.0 - 2026-07-22

### Added

- Added Pi as a supported ccusage source.

### Changed

- Changed sync to upload daily reports plus source-level session counts instead of raw session payloads.
- Normalized source-prefixed model labels while preserving raw model names in usage charts.
- Removed the unsupported Cursor source.

### Fixed

- Surfaced per-source ccusage failures without discarding successful source results.
- Fixed ccusage launching on Windows by using Bun's executable runner and the Windows npm launcher fallback.

## 0.4.23 - 2026-07-14

### Added

- Added GPT-5.6 tier tracking by using a ccusage release with GPT-5.6 pricing support.
- Added aggregate public stats for tracked spend, tokens, models, sources, users, and devices.
- Added internal shadow-ban moderation controls to remove selected accounts from public surfaces.

## 0.4.22 - 2026-06-27

### Fixed

- Fixed Windows native CLI startup by removing the module guard and accepting standalone executable argv shape.

## 0.4.21 - 2026-06-27

### Fixed

- Fixed Windows native CLI executables exiting without output by using Bun's native entrypoint signal.

## 0.4.20 - 2026-06-27

### Fixed

- Fixed Windows npm installs so generated command shims launch the native CLI executable instead of asking Node to parse it.

## 0.4.19 - 2026-06-23

### Changed

- Made generated npm installs run native postinstall through Bun when available, with Node as a fallback.
- Updated Bun install guidance to use `bun add -g --trust @851-labs/tokenmaxxing`.

### Fixed

- Made the npm-installed CLI fall back to the installed native optional package when lifecycle scripts are blocked.
- Improved failed native install diagnostics for script-blocked and shadowed global installs.

## 0.4.18 - 2026-06-22

### Added

- Added native npm CLI packages for supported platforms while keeping scheduled sync pinned to a config-owned runner snapshot.

### Changed

- Changed scheduled sync auto-update to use verified registry runner packages instead of ambient Node/npm/vite-plus paths.
- Bumped the service template so installed schedulers repair onto the native runner wrapper and template metadata.
- Made internal admin outdated labels compare prerelease clients against their matching npm release channel.

### Fixed

- Fixed service repair for native npm installs so it copies nested platform package runners correctly.
- Prevented prerelease runner auto-updates from downgrading or crossing release channels.

## 0.4.18-alpha.6 - 2026-06-22

### Changed

- Bumped the service template version to force installed schedulers through the repair/reload path for alpha validation.

## 0.4.18-alpha.5 - 2026-06-22

### Fixed

- Fixed service repair for native npm installs so it copies the nested platform package runner instead of keeping an older config-owned runner.

## 0.4.18-alpha.4 - 2026-06-22

### Changed

- Changed npm installs to materialize a native `tokenmaxxing` binary from generated `@851-labs/tokenmaxxing-<target>` packages.
- Renamed generated native packages away from the alpha-only `@851-labs/tokenmaxxing-service-<target>` package family.

## 0.4.18-alpha.3 - 2026-06-22

### Changed

- Reissued the service-runner alpha to validate channel-aware runner updates end to end before the stable release.

## 0.4.18-alpha.2 - 2026-06-22

### Fixed

- Made registry-based service runner auto-updates follow the installed runner's release channel and reject downgrades or cross-channel candidates.
- Made service install and repair registry fallback fetch the exact runner version for the current CLI build.

## 0.4.18-alpha.1 - 2026-06-22

### Changed

- Reissued the alpha service-runner release through GitHub Actions trusted publishing after bootstrapping the generated runner packages.

## 0.4.18-alpha.0 - 2026-06-22

### Added

- Added native, config-owned service runners for scheduled syncs so launchd, systemd, and Windows Task Scheduler no longer depend on ambient Node, npm, Bun, or vite-plus paths.
- Added generated platform runner package publishing with npm prerelease dist-tags.

### Changed

- Changed scheduled service auto-update to fetch verified runner packages from the npm registry and atomically advance the service runner pointer.

### Fixed

- Hardened service install, repair, and runner update locking so concurrent repairs and updates cannot overlap.
- Prevented deferred launchd repairs from reloading the active launchd job from inside itself.

## 0.4.17 - 2026-06-21

### Fixed

- Made scheduled Linux service repairs use `systemd-run --user` so reload-required repairs survive systemd oneshot cleanup.

## 0.4.16 - 2026-06-21

### Changed

- Removed the service auto-update opt-out so scheduled services always attempt CLI updates when package-manager metadata is available.
- Bumped the service template so installed schedulers refresh away from legacy auto-update metadata.

### Fixed

- Made service install and repair keep working when the package manager cannot be detected, while reporting the missing manager through auto-update telemetry.

## 0.4.15 - 2026-06-21

### Added

- Added structured auto-update telemetry for scheduled service check-ins so fleet status can show update-blocked devices with concrete reasons.

### Changed

- Made scheduled service auto-update verify the installed CLI version after package-manager updates before reporting success.

## 0.4.14 - 2026-06-21

### Added

- Added automatic service repair telemetry for scheduled sync check-ins and internal fleet details.

### Changed

- Made scheduled service runs retry deferred scheduler repair when the scheduler is inactive, the service template is stale, auto-update changes the CLI, or the service run fails.

### Fixed

- Fixed inline command snippets so CLI flags render with visible spacing instead of font ligatures.

## 0.4.13 - 2026-06-21

### Added

- Added `tokenmaxxing service repair` to refresh service files and re-register native schedulers.
- Added automatic sync service check-ins for scheduler health and repair-needed fleet status.
- Added a homepage bootstrap hero with a copyable install-and-bootstrap command.
- Added `/terms` and `/privacy` pages.
- Added avatars to the internal admin fleet page.

### Changed

- Changed automatic sync to run every 5 minutes.
- Deferred native scheduler repair after scheduled auto-updates so the active job is not reloaded by itself.
- Made service install prefer durable command paths for transient FNM multishell shims.
- Refactored web route data loading to TanStack Query suspense with SSR preloading.
- Made the API client forward auth cookies during SSR.
- Simplified the custom web server setup and removed unused route exports/tests.
- Switched route search parameter parsing to Zod.
- Hid revoked CLI tokens from the settings API response and settings UI.
- Updated internal/admin and profile page spacing, table, and surface styling.
- Defaulted the leaderboard to 30 days and stripped default search params from URLs.
- Improved automatic sync observability, check-in display, and log rotation.
- Added shared `cn` support with `clsx` and `tailwind-merge`.

## 0.4.12 - 2026-06-19

### Added

- Added the homepage FAQ.
- Added the internal admin fleet dashboard.

### Changed

- Refined page shell and route section spacing.
- Simplified internal admin tables.

## 0.4.11 - 2026-06-18

### Fixed

- Restored hourly service sync scheduling.

## 0.4.10 - 2026-06-18

### Changed

- Hid Google from login pages.
- Improved sync upload, browser-open, logout, and async CLI progress output.
- Stabilized CLI URL formatting expectations in tests.

### Fixed

- Fixed the published CLI to run on Node.

## 0.4.9 - 2026-06-17

### Added

- Added the CLI bootstrap flow.

### Changed

- Improved CLI auth status output and CLI login status copy.
- Deduplicated CLI auth validation.
- Fixed Cloudflare local resource naming.

### Fixed

- Standardized CLI status punctuation.

## 0.4.8 - 2026-06-17

### Fixed

- Removed underlines from CLI command hints.
- Resolved the `whoami` spinner with the signed-in account label.
- Streamlined sync clack output.

## 0.4.7 - 2026-06-17

### Fixed

- Polished CLI login hints.

## 0.4.6 - 2026-06-17

### Changed

- Polished CLI clack output.

## 0.4.5 - 2026-06-17

### Fixed

- Fixed CLI clack failure output.

## 0.4.4 - 2026-06-17

### Changed

- Improved CLI upgrade version checks.
- Formatted CLI URLs consistently.

## 0.4.3 - 2026-06-17

### Added

- Framed CLI command output in the human output style.

## 0.4.2 - 2026-06-17

### Changed

- Moved `@clack/prompts` to CLI dev dependencies.

## 0.4.1 - 2026-06-17

### Changed

- Republished the CLI with no user-facing changes after the 0.4.0 release correction.

## 0.4.0 - 2026-06-17

### Added

- Added the modern framed CLI output system.

### Changed

- Renamed the CLI `update` command to `upgrade`.
- Modernized CLI output.
- Added reference repo submodules.

### Fixed

- Corrected the CLI release lockfile.

## 0.3.5 - 2026-06-16

### Added

- Added the daily tokens chart.
- Added raw usage report ingestion.

### Changed

- Polished the ranked daily-spend legend and weekday chart.

### Fixed

- Aligned the empty profile stat cell.

## 0.3.4 - 2026-06-16

### Added

- Added the profile "Most Active Time" weekday chart.
- Added the original CLI update command.

## 0.3.3 - 2026-06-16

### Changed

- Simplified service scheduling.

## 0.3.2 - 2026-06-16

### Fixed

- Fixed the macOS service wrapper name.

## 0.3.1 - 2026-06-16

### Fixed

- Prompted for login during service install when needed.

## 0.3.0 - 2026-06-16

### Added

- Added the automatic sync service.
- Added edge-to-edge site footer and real session counts on profiles.
- Added a Base UI menu component to the design system.

### Changed

- Auto-approved CLI login after sign-in.
- Reworked the visual system with square corners and edge-to-edge hairline grids.
- Expanded profile stats, full-year heatmap, chart breakdowns, and chart tooltip polish.
- Swapped icons from Lucide to Phosphor.
- Hardened CLI browser login and opened profiles after sync.
- Polished CLI sync output and used real session counts in sync output.
- Updated D1 database names to be stage-specific.

## 0.2.3 - 2026-06-15

### Added

- Added Google OAuth account linking.
- Merged verified OAuth account duplicates.

### Changed

- Updated the production domain and kept legacy domains as aliases during migration.
- Followed the user's system color scheme.

### Fixed

- Fixed CLI legacy domain configuration.

## 0.2.2 - 2026-06-14

### Added

- Added UI primitives and the `/design` kitchen sink.
- Added device data deletion.

### Changed

- Redirected unauthenticated settings visits to login.
- Renamed query option helpers.
- Moved CLI login under the login route.

## 0.2.1 - 2026-06-13

### Changed

- Formatted CLI sync spend totals.
- Redirected the default login flow to the user's profile.

## 0.2.0 - 2026-06-13

### Added

- Added the monorepo skeleton with Bun workspaces, Turbo, Effect v4, and Alchemy v2.
- Added the D1 schema, shared HttpApi contract, API worker, and Cloudflare deployment stack.
- Added GitHub OAuth, sessions, authorization middleware, and CLI device login.
- Added the CLI with login, logout, whoami, sync, and release workflow support.
- Added ccusage-based usage sync, idempotent ingestion, leaderboard API, and profile API.
- Added the initial leaderboard page and profile dashboard with custom charts.
- Added production deploy documentation, CI deploys, OG metadata, and npm README content.

### Changed

- Priced usage with ccusage calculate mode and handled per-source dialects.
- Preserved CLI auth redirects after login and started login from sync.
- Polished profile copy, stat cards, chart subtitles, and chart hover tooltips.

### Fixed

- Redirected plain HTTP web hits to HTTPS and set HSTS.
- Set `CLOUDFLARE_ACCOUNT_ID` in the deploy workflow.
