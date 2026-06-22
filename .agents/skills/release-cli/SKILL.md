---
name: release-cli
description: Release a new version of the tokenmaxxing CLI to npm. Use when explicitly asked to release or publish @851-labs/tokenmaxxing, including checking main, bumping apps/cli/package.json, updating CHANGELOG.md, committing, tagging cli-vX.Y.Z, pushing, monitoring generated runner package publishing, and smoke testing the published packages.
---

# CLI Release Process

Follow these steps to release a new version of the `@851-labs/tokenmaxxing` CLI. Only perform mutating release actions when the user explicitly asks to release or publish a new CLI version.

## Pre-flight Checks

Verify `main` is clean and current.

```sh
git status --short --branch
git branch --show-current
git pull origin main
```

If the working tree has unrelated changes, stop and ask before staging or committing.

## Step 1: Choose And Bump Version

Decide the bump from the requested change scope: `patch`, `minor`, `major`, or a prerelease variant when explicitly requested.

Update only `apps/cli/package.json` for the new version unless the lockfile changes after install. Do not add generated service runner packages to the source workspace; release publishing generates those package manifests from the CLI version. For alpha/beta/rc releases, use a prerelease version such as `X.Y.Z-alpha.0`; the publish script derives the npm dist-tag from the prerelease identifier unless `--tag` is passed explicitly.

```sh
$EDITOR apps/cli/package.json
bun install --lockfile-only
node -p "JSON.parse(require('node:fs').readFileSync('apps/cli/package.json', 'utf8')).version"
```

Use the printed version as `X.Y.Z` below.

## Step 2: Update Changelog

Update `CHANGELOG.md` before running checks.

1. Move the relevant `Unreleased` entries into a new `## X.Y.Z - YYYY-MM-DD` section.
2. Keep a fresh empty `## Unreleased` section at the top.
3. Keep entries concise and user-facing; do not paste raw commit logs.
4. Include all notable CLI changes in the release section. Include web/API changes only when they
   shipped since the previous CLI release and are user-visible or operationally important.

Use today's date in `YYYY-MM-DD` format.

## Step 3: Run Checks

Run the existing checks directly.

```sh
bun --filter @851-labs/tokenmaxxing typecheck
bun --filter @851-labs/tokenmaxxing test
bun run lint
bun run fmt
bun --filter @851-labs/tokenmaxxing build
bun --filter @851-labs/tokenmaxxing build:service-runners --single
```

Fix failures before continuing.

## Step 4: Commit Version Bump

Stage only the release files.

```sh
git add CHANGELOG.md apps/cli/package.json bun.lock
git commit -m "chore: release cli vX.Y.Z"
```

If `bun.lock` did not change, omit it from `git add`. Before committing, confirm `CHANGELOG.md`
contains `## X.Y.Z - YYYY-MM-DD`.

## Step 5: Create And Push Tag

```sh
git tag cli-vX.Y.Z
git push origin main
git push origin cli-vX.Y.Z
```

The `cli-vX.Y.Z` tag starts the `Release CLI` GitHub Actions workflow. The workflow builds generated service runner packages first, publishes those packages, then publishes the generated `@851-labs/tokenmaxxing` package with matching optional dependencies. Stable versions publish with `latest`; prerelease versions such as `X.Y.Z-alpha.0` publish with the matching dist-tag such as `alpha`.

## Step 6: Monitor Publish Workflow

Wait for the workflow run to appear and watch it.

```sh
gh run list --workflow "Release CLI" --limit 1
gh run watch
```

If no run appears yet, wait and retry.

```sh
sleep 10
gh run list --workflow "Release CLI" --limit 1
```

If the workflow fails, inspect logs.

```sh
gh run view --log-failed
```

## Step 7: Smoke Test Published Packages

Use `npx` for exact-version install resolution, confirm npm latest, then check the host service runner package. Replace the runner package name with the current host target when needed.

```sh
npx @851-labs/tokenmaxxing@X.Y.Z --help
npx @851-labs/tokenmaxxing-service-darwin-arm64@X.Y.Z --version
bun pm view @851-labs/tokenmaxxing version
bun pm view @851-labs/tokenmaxxing-service-darwin-arm64 version
```

Confirm both `bun pm view` commands return `X.Y.Z`.

## Troubleshooting

### Checks Fail

Fix failing checks before releasing.

### Tag Already Exists

Delete the local and remote tag, then retry.

```sh
git tag -d cli-vX.Y.Z
git push origin :refs/tags/cli-vX.Y.Z
```

### Push Rejected

Pull latest and retry.

```sh
git pull --rebase origin main
```

### Publish Workflow Fails After Tag Push

Fix the failure on `main`, delete the failed tag locally and remotely, then create a new tag from the corrected commit.
