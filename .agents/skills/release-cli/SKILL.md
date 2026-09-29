---
name: release-cli
description: Release a new version of the tokenmaxxing CLI to npm. Use when explicitly asked to release or publish @851-labs/tokenmaxxing, including checking main, bumping apps/cli/package.json, updating CHANGELOG.md, committing, tagging cli-vX.Y.Z, pushing, monitoring generated native package publishing and the GitHub release, and smoke testing the published packages.
---

# CLI Release Process

Follow these steps to release a new version of the `@851-labs/tokenmaxxing` CLI. Only perform mutating release actions when the user explicitly asks to release or publish a new CLI version.

npm versions are immutable and a pushed `cli-v*` tag may already have published packages, so a version is spent once its tag reaches `origin`. Never move or re-point a pushed tag to different code; see [Publish Workflow Fails After Tag Push](#publish-workflow-fails-after-tag-push).

## Pre-flight Checks

Release from a fresh worktree off `origin/main`, never from the user's main checkout. The lefthook pre-commit hook runs `bun run check` and `bun run test` over the whole checkout, so unrelated untracked files there (for example an `outputs/` folder) can fail the release commit. Do not work around that with `--no-verify` or by touching unrelated files.

```sh
git fetch origin main --tags
release_dir="$(mktemp -d)/tokenmaxxing-release"
git worktree add --detach "$release_dir" origin/main
cd "$release_dir"
bun install --frozen-lockfile
git status --short
```

`git status --short` must print nothing. After choosing the version in Step 1, confirm it is unused on npm and in git. Each command below must print nothing:

```sh
npm view @851-labs/tokenmaxxing@X.Y.Z version 2>/dev/null
git ls-remote --tags origin cli-vX.Y.Z
```

If either prints something, the version is taken: pick the next one, or see [Tag Already Exists](#tag-already-exists).

## Step 1: Choose And Bump Version

Decide the bump from the requested change scope: `patch`, `minor`, `major`, or a prerelease variant when explicitly requested.

Update only `apps/cli/package.json` for the new version unless the lockfile changes after install. Do not add generated native packages to the source workspace; release publishing generates those package manifests from the CLI version. For alpha/beta/rc releases, use a prerelease version such as `X.Y.Z-alpha.0`; the publish script derives the npm dist-tag from the prerelease identifier unless `--tag` is passed explicitly.

```sh
$EDITOR apps/cli/package.json
bun install --lockfile-only
node -p "JSON.parse(require('node:fs').readFileSync('apps/cli/package.json', 'utf8')).version"
```

Use the printed version as `X.Y.Z` below.

### Promoting A Prerelease To Stable

A prerelease such as `0.7.0-alpha.1` becomes `0.7.0` through a normal release: set the version to `0.7.0` and follow every step. It gets its own `cli-v0.7.0` tag and publishes with the stable dist-tag `latest`. In Step 2, fold the `Unreleased` entries and every `## 0.7.0-alpha.N` section into a single `## 0.7.0 - YYYY-MM-DD` section, merging entries under one `Added`/`Changed`/`Fixed` set.

`npm dist-tag add @851-labs/tokenmaxxing@<version> latest` is an emergency lever only, for example repointing `latest` at a known-good version after a bad stable release. It is not the promotion path, it moves only the main package (native versions are pinned exactly through `optionalDependencies`), and it needs npm owner credentials, so leave it to the user.

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
bun run check
bun run vp test --project cli
bun --filter @851-labs/tokenmaxxing build
bun --filter @851-labs/tokenmaxxing build:native-packages --single
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

Verify the release commit sits directly on the current `origin/main`, so the tag always lands on `main`:

```sh
git fetch origin main
test "$(git rev-parse HEAD^)" = "$(git rev-parse origin/main)" && echo "parent ok"
```

If it does not print `parent ok`, `main` moved: `git rebase origin/main`, rerun Step 3, and check again.

Tag, then push the branch and tag in one atomic push. Either both refs update or neither does, so a rejected `main` push can never leave a tag (and a publish) on a commit that is not on `main`. The worktree is detached because `main` is usually checked out in the main clone, hence `HEAD:main`.

```sh
git tag cli-vX.Y.Z
git push --atomic origin HEAD:main cli-vX.Y.Z
```

The `cli-vX.Y.Z` tag starts the `Release CLI` GitHub Actions workflow. The workflow builds generated native packages first, publishes those packages, then publishes the generated `@851-labs/tokenmaxxing` package with matching optional dependencies. Stable versions publish with `latest`; prerelease versions such as `X.Y.Z-alpha.0` publish with the matching dist-tag such as `alpha`.

After publishing succeeds, the workflow's `Create GitHub release` job creates the `cli-vX.Y.Z` GitHub release (`apps/cli/script/github-release.ts`): title `tokenmaxxing vX.Y.Z`, the `## X.Y.Z` section of `CHANGELOG.md` at the tag plus the install command, marked prerelease for `-alpha`/`-beta`/`-rc`, and marked Latest only when it is the highest stable version.

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

If the workflow fails, inspect logs and follow [Publish Workflow Fails After Tag Push](#publish-workflow-fails-after-tag-push), or [GitHub Release Missing Or Wrong](#github-release-missing-or-wrong) when only the `Create GitHub release` job failed.

```sh
gh run view --log-failed
```

Once the run succeeds, confirm the GitHub release exists with the right title and flags:

```sh
gh release view cli-vX.Y.Z --json name,isPrerelease,url
gh release list --limit 3
```

A stable release that is the highest version should show `Latest` in `gh release list`; prereleases show `Pre-release`.

## Step 7: Smoke Test Published Packages

Use `npx` for exact-version install resolution, confirm npm latest, then check the host native package. Replace the native package name with the current host target when needed.

```sh
npx @851-labs/tokenmaxxing@X.Y.Z --help
npx @851-labs/tokenmaxxing-darwin-arm64@X.Y.Z --version
bun pm view @851-labs/tokenmaxxing version
bun pm view @851-labs/tokenmaxxing-darwin-arm64 version
```

Confirm both `bun pm view` commands return `X.Y.Z` (for prereleases, check `npm view @851-labs/tokenmaxxing dist-tags` instead).

Then remove the release worktree from the main clone: `git worktree remove "$release_dir"`.

## Troubleshooting

### Checks Fail

Fix failing checks before releasing. If the fix is unrelated to the release itself, land it through a normal PR first, then restart from a fresh worktree.

### Check npm State For A Version

Run from a checkout of the tagged commit so the native target list matches what the workflow published:

```sh
bun -e 'import { serviceRunnerPublishOrder } from "./apps/cli/src/service-runner-targets"; for (const p of serviceRunnerPublishOrder("@851-labs/tokenmaxxing")) console.log(p)' |
  while read -r pkg; do v=$(npm view "$pkg@X.Y.Z" version 2>/dev/null); echo "$pkg ${v:-unpublished}"; done
```

The list covers every native package and the main package, in publish order.

### GitHub Release Missing Or Wrong

The GitHub release is separate from the tag and from npm: re-creating or editing it never touches either, so never move or re-push the tag to fix a release.

- **The `Create GitHub release` job failed** (for example `CHANGELOG.md` at the tag has no `## X.Y.Z - YYYY-MM-DD` section): npm publishing already succeeded. For a flake, re-run only the failed job with `gh run rerun <run-id> --failed`; it updates an existing release instead of failing. A missing changelog section cannot be fixed on the tag, so add the section to `CHANGELOG.md` on `main` through a normal PR, then create the release from an up-to-date `main` checkout with the same script. Preview with `--dry-run` first:

  ```sh
  bun apps/cli/script/github-release.ts cli-vX.Y.Z --dry-run
  bun apps/cli/script/github-release.ts cli-vX.Y.Z
  ```

  The script reads `CHANGELOG.md` from the checkout, derives the prerelease and Latest flags from the `cli-v*` tags on `origin`, and creates or updates the release with `--verify-tag`, so it never creates a tag.

- **Wrong notes, title or flags**: edit in place, for example `gh release edit cli-vX.Y.Z --notes-file notes.md`, `--prerelease=false`, or `--latest`. Re-running the script above also rewrites notes and flags.

- **Start over**: `gh release delete cli-vX.Y.Z --yes` deletes only the release (never pass `--cleanup-tag`), then re-create it with the script. Deleting and re-creating notifies repo watchers again, so prefer editing.

`apps/cli/script/backfill-github-releases.ts --dry-run` shows what every `cli-v*` release would look like; running it without `--dry-run` creates missing releases and updates existing ones, oldest first.

### Tag Already Exists

Do not delete it by default. First find out what it is:

```sh
git ls-remote --tags origin cli-vX.Y.Z
git rev-parse "cli-vX.Y.Z^{commit}"
git merge-base --is-ancestor cli-vX.Y.Z origin/main && echo "on main"
npm view @851-labs/tokenmaxxing@X.Y.Z version 2>/dev/null
gh run list --workflow "Release CLI" --branch cli-vX.Y.Z
```

- The tag is on `origin`: the version is spent. If its release run failed, follow [Publish Workflow Fails After Tag Push](#publish-workflow-fails-after-tag-push); otherwise release the next version.
- The tag is local only (`git ls-remote` printed nothing), for example left behind by a rejected atomic push: nothing was published from it, so `git tag -d cli-vX.Y.Z` is safe.

### Push Rejected

With `--atomic`, a rejection updates neither `main` nor the tag. Confirm `git ls-remote --tags origin cli-vX.Y.Z` prints nothing, drop the local tag, rebase, and redo Steps 3 to 5:

```sh
git tag -d cli-vX.Y.Z
git fetch origin main
git rebase origin/main
```

### Publish Workflow Fails After Tag Push

Never delete, move or re-create a pushed tag to publish different code under the same version. The failed run may already have published some packages, npm will not let them be replaced, and other clones keep the old tag. Inspect the failure and [check npm state](#check-npm-state-for-a-version), then:

- **Infrastructure or flake, code is fine** (npm or GitHub outage, network error, runner or OIDC hiccup): re-run the same run on the same tag. This is safe because `publish.ts` checks the registry before each package and skips versions that are already published (`already published <pkg>@X.Y.Z`), so a re-run publishes only the missing packages from the same commit.

  ```sh
  gh run rerun <run-id> --failed
  ```

  If a re-run fails with npm refusing to publish over an existing version, the registry check was briefly stale; re-run again.

- **Code needs a fix**: never reuse the version. Leave the tag alone, land the fix on `main` through a normal PR, then release the next version (next patch, or `-alpha.N+1` for prereleases). In that release's changelog, fold the unpublished `X.Y.Z` section into the new one. Native packages published for the abandoned version are orphans that nothing depends on.

Deleting a pushed tag is acceptable only after confirming that no workflow run published anything for that version: no run for the tag is still in progress, and the npm state check shows `unpublished` for the main package and every native package. Only then:

```sh
git push origin :refs/tags/cli-vX.Y.Z
git tag -d cli-vX.Y.Z
```

Other clones still hold the old tag until they run `git fetch --prune --prune-tags origin`; tell the user.
