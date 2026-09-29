#!/usr/bin/env bun

// One-off backfill of GitHub releases for every `cli-v*` tag, oldest first.
// Idempotent: existing releases are updated in place, tags are never touched.
//
//   bun apps/cli/script/backfill-github-releases.ts --dry-run [--verbose] [--only 0.7.0,0.6.0]
//   bun apps/cli/script/backfill-github-releases.ts
//
// Notes come from the CHANGELOG at the tag's own commit (the 0.7.0 release
// folded the 0.7.0-alpha.N sections on main), then from the CHANGELOG at
// --fallback-ref (default origin/main, which has sections written after the
// fact for tags that predate CHANGELOG.md), then from `git log` since the
// previous tag.

import { $ } from "bun";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { changelogSection } from "./changelog-section";
import { githubRelease, remoteCliVersions, upsertGitHubRelease } from "./github-release";
import { cliTag, gitLogNotes, sortVersions } from "./github-release-notes";

type NotesSource = "fallback-changelog" | "git-log" | "tag-changelog";

interface BackfillOptions {
  dryRun: boolean;
  fallbackRef: string;
  only: string[] | undefined;
  verbose: boolean;
}

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(cliDir, "../..");

function parseArgs(argv: readonly string[]): BackfillOptions {
  const options: BackfillOptions = {
    dryRun: false,
    fallbackRef: "origin/main",
    only: undefined,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--fallback-ref" || arg === "--only") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--only") {
        options.only = value.split(",").map((version) => version.replace(/^cli-v/, ""));
      } else {
        options.fallbackRef = value;
      }
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function changelogAt(ref: string): Promise<string | null> {
  const result = await $`git show ${`${ref}:CHANGELOG.md`}`.cwd(repoDir).nothrow().quiet();
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

async function commitSubjects(tag: string, previousTag: string | undefined): Promise<string[]> {
  const range = previousTag === undefined ? tag : `${previousTag}..${tag}`;
  const output = await $`git log --no-merges --format=%s ${range}`.cwd(repoDir).text();
  return output
    .split("\n")
    .filter((subject) => subject !== "" && !subject.startsWith("chore: release cli"));
}

async function releaseNotes(
  version: string,
  previousVersion: string | undefined,
  fallbackChangelog: string | null,
): Promise<{ notes: string; source: NotesSource }> {
  const tag = cliTag(version);
  const tagChangelog = await changelogAt(tag);
  const fromTag = tagChangelog === null ? null : changelogSection(tagChangelog, version);
  if (fromTag !== null) {
    return { notes: fromTag.body, source: "tag-changelog" };
  }
  const fromFallback =
    fallbackChangelog === null ? null : changelogSection(fallbackChangelog, version);
  if (fromFallback !== null) {
    return { notes: fromFallback.body, source: "fallback-changelog" };
  }
  const previousTag = previousVersion === undefined ? undefined : cliTag(previousVersion);
  return {
    notes: gitLogNotes(await commitSubjects(tag, previousTag), previousTag),
    source: "git-log",
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const versions = sortVersions(await remoteCliVersions());
  for (const version of versions) {
    const result = await $`git rev-parse --verify --quiet ${`refs/tags/${cliTag(version)}`}`
      .cwd(repoDir)
      .nothrow()
      .quiet();
    if (result.exitCode !== 0) {
      throw new Error(`${cliTag(version)} is on origin but not local; run git fetch --tags origin`);
    }
  }
  const fallbackChangelog = await changelogAt(options.fallbackRef);
  if (fallbackChangelog === null) {
    throw new Error(`no CHANGELOG.md at ${options.fallbackRef}`);
  }

  const counts: Record<string, number> = {};
  const gitLogTags: string[] = [];
  for (const [index, version] of versions.entries()) {
    if (options.only !== undefined && !options.only.includes(version)) {
      continue;
    }
    const { notes, source } = await releaseNotes(version, versions[index - 1], fallbackChangelog);
    const release = githubRelease(version, notes, versions);
    console.log(
      `${release.tag.padEnd(20)} notes=${source.padEnd(18)} prerelease=${String(release.prerelease).padEnd(5)} latest=${release.latest}`,
    );
    if (options.verbose) {
      console.log(`\n${release.body}\n${"=".repeat(80)}`);
    }
    const outcome = await upsertGitHubRelease(release, { dryRun: options.dryRun });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (source === "git-log") {
      gitLogTags.push(release.tag);
    }
    if (outcome === "created") {
      // Stay well clear of GitHub's secondary rate limit on content creation.
      await Bun.sleep(1_000);
    }
  }

  console.log(`\n${JSON.stringify(counts)}`);
  console.log(`git-log fallback: ${gitLogTags.length === 0 ? "none" : gitLogTags.join(", ")}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
