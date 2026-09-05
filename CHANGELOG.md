# Changelog

All notable changes to tokenmaxxing are documented here. Versions are anchored to the
`cli-v*` release tags because the CLI is the project's current released artifact.

## Unreleased

### Added

- Added Amp, Codebuff, Droid, Goose, Grok Build CLI, Kilo Code, Kimi, OpenClaw, Qwen Code, and
  Supercharge as supported sources. Supercharge is collected natively from its own session store
  under the Supercharge data home (`SUPERCHARGE_HOME`, default `~/.supercharge`), independently of
  ccusage.
- Carried custom agent data-directory environment variables (`GROK_HOME`, `SUPERCHARGE_HOME`,
  `AMP_DATA_DIR`, `QWEN_DATA_DIR`, `KIMI_DATA_DIR`, `KILO_DATA_DIR`, `GOOSE_PATH_ROOT`,
  `DROID_SESSIONS_DIR`, `CODEBUFF_DATA_DIR`, `OPENCLAW_DIR`) into scheduled syncs.

### Changed

- Required ccusage 20.0.20 or newer, which adds the Grok Build CLI adapter.

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
