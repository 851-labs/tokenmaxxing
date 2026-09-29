#!/usr/bin/env bun

import { $ } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { changelogSection } from "./changelog-section";
import {
  cliTag,
  cliTagVersion,
  isLatestStableVersion,
  isPrereleaseVersion,
  releaseBody,
  releaseTitle,
} from "./github-release-notes";

interface GitHubRelease {
  body: string;
  latest: boolean;
  prerelease: boolean;
  tag: string;
  title: string;
}

type GitHubReleaseResult = "created" | "dry-run" | "updated";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(cliDir, "../..");

// Every `cli-v*` tag on origin, not just the local ones: a shallow CI checkout
// only has the tag it was started for.
async function remoteCliVersions(): Promise<string[]> {
  const pattern = "refs/tags/cli-v*";
  const output = await $`git ls-remote --tags --refs origin ${pattern}`.cwd(repoDir).text();
  return output
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace("refs/tags/", ""))
    .map((tag) => (tag === undefined ? null : cliTagVersion(tag)))
    .filter((version): version is string => version !== null);
}

function githubRelease(version: string, notes: string, allVersions: readonly string[]) {
  return {
    body: releaseBody(notes, version),
    latest: isLatestStableVersion(version, allVersions),
    prerelease: isPrereleaseVersion(version),
    tag: cliTag(version),
    title: releaseTitle(version),
  } satisfies GitHubRelease;
}

async function releaseExists(tag: string): Promise<boolean> {
  const result = await $`gh release view ${tag} --json tagName`.cwd(repoDir).nothrow().quiet();
  if (result.exitCode === 0) {
    return true;
  }
  const stderr = result.stderr.toString();
  if (stderr.includes("release not found")) {
    return false;
  }
  throw new Error(`gh release view ${tag} failed: ${stderr.trim()}`);
}

// Creates the release for an existing tag, or updates it when it already
// exists (a re-run of the Release CLI workflow). `--verify-tag` stops gh from
// ever creating a tag.
async function upsertGitHubRelease(
  release: GitHubRelease,
  options: { dryRun?: boolean | undefined } = {},
): Promise<GitHubReleaseResult> {
  const exists = await releaseExists(release.tag);
  const flags = [
    "--title",
    release.title,
    `--prerelease=${release.prerelease}`,
    `--latest=${release.latest}`,
    "--verify-tag",
  ];

  if (options.dryRun === true) {
    console.log(`would ${exists ? "update" : "create"} ${release.tag}: ${flags.join(" ")}`);
    return "dry-run";
  }

  const notesDir = await mkdtemp(join(tmpdir(), "tokenmaxxing-release-notes-"));
  try {
    const notesFile = join(notesDir, "notes.md");
    await Bun.write(notesFile, release.body);
    if (exists) {
      await $`gh release edit ${release.tag} ${flags} --notes-file ${notesFile}`
        .cwd(repoDir)
        .quiet();
      return "updated";
    }
    await $`gh release create ${release.tag} ${flags} --notes-file ${notesFile}`
      .cwd(repoDir)
      .quiet();
    return "created";
  } finally {
    await rm(notesDir, { force: true, recursive: true });
  }
}

// Release CLI workflow entry: the checkout is the tagged commit, so the
// CHANGELOG on disk is the one that shipped with the tag.
async function main(argv: readonly string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const tag = argv.find((arg) => !arg.startsWith("--")) ?? process.env.GITHUB_REF_NAME;
  const version = tag === undefined ? null : cliTagVersion(tag);
  if (tag === undefined || version === null) {
    throw new Error(`expected a cli-vX.Y.Z tag, got ${JSON.stringify(tag)}`);
  }

  const changelog = await readFile(join(repoDir, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  if (section === null) {
    console.error(
      `CHANGELOG.md at ${tag} has no "## ${version} - YYYY-MM-DD" section, so no GitHub release was created.`,
    );
    console.error(
      "npm publishing already succeeded. Create the release by hand; see the release-cli skill's troubleshooting section.",
    );
    process.exit(1);
  }

  const allVersions = await remoteCliVersions();
  const release = githubRelease(version, section.body, [...allVersions, version]);
  const result = await upsertGitHubRelease(release, { dryRun });
  console.log(
    `${result} GitHub release ${tag} (prerelease=${release.prerelease}, latest=${release.latest})`,
  );
  if (dryRun) {
    console.log(release.body);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

export { githubRelease, remoteCliVersions, upsertGitHubRelease };
export type { GitHubRelease, GitHubReleaseResult };
