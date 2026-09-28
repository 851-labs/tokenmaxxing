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
