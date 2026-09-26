# Contributing to the CLI

`README.md` ships with the npm package. Notes for working on the CLI go here.

## Checks

`bun run check` and `bun run test` from the repo root cover the CLI along
with everything else.

## Windows e2e

Changes to the background service (`src/commands/service*.ts`), ccusage
(`src/ccusage/**`), packaging (`script/**`, `package.json`) or the API contract
trigger the **Windows e2e** workflow on your PR. It runs on real
`windows-latest` and `windows-11-arm` runners. It installs this checkout,
registers the scheduled task, and checks that every run finishes without a
visible window or a focus change, across awkward profile paths and an upgrade
from an older release. A second job checks the global-install shims.

It is not a required check. If it fails, the job summary lists the failed
checks, and the artifacts hold the logs and screenshots. To run it on any
branch:

```bash
gh workflow run windows-e2e.yml --ref <branch>
```

See [e2e/windows/README.md](e2e/windows/README.md) for what it covers and how
it works.
