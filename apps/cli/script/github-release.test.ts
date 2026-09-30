import { describe, expect, it } from "vite-plus/test";

import { changelogSection } from "./changelog-section";
import {
  cliTagVersion,
  compareVersions,
  gitLogNotes,
  isLatestStableVersion,
  isPrereleaseVersion,
  releaseBody,
  releaseTitle,
  sortVersions,
} from "./github-release-notes";

const changelog = `# Changelog

## Unreleased

## 0.4.18 - 2026-06-22

### Fixed

- Stable fix.

## 0.4.18-alpha.1 - 2026-06-22

### Added

- Alpha feature.

### Fixed

- Alpha fix.

## 0.4.17 - 2026-06-21

## 0.4.16
- Undated entry.
`;

describe("changelogSection", () => {
  it("returns the body of an exact version section without its heading", () => {
    expect(changelogSection(changelog, "0.4.18")).toEqual({
      body: "### Fixed\n\n- Stable fix.",
      date: "2026-06-22",
    });
  });

  it("keeps ### subsections and stops at the next ## heading", () => {
    expect(changelogSection(changelog, "0.4.18-alpha.1")?.body).toBe(
      "### Added\n\n- Alpha feature.\n\n### Fixed\n\n- Alpha fix.",
    );
  });

  it("reads the last section to the end of the file and allows an undated heading", () => {
    expect(changelogSection(changelog, "0.4.16")).toEqual({
      body: "- Undated entry.",
      date: undefined,
    });
  });

  it("treats missing and empty sections as missing", () => {
    expect(changelogSection(changelog, "0.4.18-alpha.0")).toBeNull();
    expect(changelogSection(changelog, "0.4.17")).toBeNull();
    expect(changelogSection(changelog, "0.4.1")).toBeNull();
  });

  it("does not treat regex metacharacters in the version as wildcards", () => {
    expect(changelogSection("## 0x4x18 - 2026-06-22\n\n- Nope.\n", "0.4.18")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    expect(changelogSection("## 1.0.0 - 2026-01-01\r\n\r\n- Yes.\r\n", "1.0.0")?.body).toBe(
      "- Yes.",
    );
  });
});

describe("github release versions", () => {
  it("parses cli tags only", () => {
    expect(cliTagVersion("cli-v0.7.0-alpha.5")).toBe("0.7.0-alpha.5");
    expect(cliTagVersion("cli-v0.7")).toBeNull();
    expect(cliTagVersion("v0.7.0")).toBeNull();
  });

  it("sorts by semver precedence, prereleases before their stable version", () => {
    expect(
      sortVersions([
        "0.7.0",
        "0.4.18",
        "0.7.0-alpha.10",
        "0.4.2",
        "0.7.0-alpha.2",
        "0.4.18-alpha.6",
        "0.4.10",
        "0.7.0-beta.0",
      ]),
    ).toEqual([
      "0.4.2",
      "0.4.10",
      "0.4.18-alpha.6",
      "0.4.18",
      "0.7.0-alpha.2",
      "0.7.0-alpha.10",
      "0.7.0-beta.0",
      "0.7.0",
    ]);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("marks alpha, beta and rc versions as prereleases", () => {
    expect(isPrereleaseVersion("0.7.0-alpha.0")).toBe(true);
    expect(isPrereleaseVersion("0.7.0-beta.1")).toBe(true);
    expect(isPrereleaseVersion("0.7.0-rc.1")).toBe(true);
    expect(isPrereleaseVersion("0.7.0")).toBe(false);
  });

  it("marks only the highest stable version as latest", () => {
    const all = ["0.6.0", "0.7.0-alpha.5", "0.7.0", "0.7.1-alpha.0"];
    expect(isLatestStableVersion("0.7.0", all)).toBe(true);
    expect(isLatestStableVersion("0.6.0", all)).toBe(false);
    expect(isLatestStableVersion("0.7.1-alpha.0", all)).toBe(false);
    // A 0.6.x patch published after 0.7.0 never takes Latest.
    expect(isLatestStableVersion("0.6.1", [...all, "0.6.1"])).toBe(false);
    // The version being released counts even before its tag is listed.
    expect(isLatestStableVersion("0.7.1", all)).toBe(true);
  });
});

describe("github release notes", () => {
  it("titles releases consistently", () => {
    expect(releaseTitle("0.7.0")).toBe("v0.7.0");
  });

  it("appends the install command and npm link to the changelog notes", () => {
    expect(releaseBody("### Fixed\n\n- A fix.\n", "0.7.0-alpha.1")).toBe(
      [
        "### Fixed",
        "",
        "- A fix.",
        "",
        "---",
        "",
        "Install:",
        "",
        "```sh",
        "npm install -g @851-labs/tokenmaxxing@0.7.0-alpha.1",
        "```",
        "",
        "npm: [@851-labs/tokenmaxxing@0.7.0-alpha.1](https://www.npmjs.com/package/@851-labs/tokenmaxxing/v/0.7.0-alpha.1)",
        "",
      ].join("\n"),
    );
  });

  it("says when notes fall back to the git log and caps long logs", () => {
    const notes = gitLogNotes(
      Array.from({ length: 32 }, (_, index) => `commit ${index}`),
      "cli-v0.4.1",
    );
    expect(notes.split("\n")[0]).toBe(
      "_CHANGELOG.md has no section for this version; these notes list the commits since `cli-v0.4.1`._",
    );
    expect(notes).toContain("- commit 29\n- …and 2 more");
    expect(notes).not.toContain("commit 30");
    expect(gitLogNotes([], undefined)).toContain("commits up to this tag");
  });
});
