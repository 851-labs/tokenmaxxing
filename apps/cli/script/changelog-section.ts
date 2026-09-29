#!/usr/bin/env bun

import { readFileSync } from "node:fs";

interface ChangelogSection {
  body: string;
  date: string | undefined;
}

// Finds the `## X.Y.Z - YYYY-MM-DD` section for an exact version and returns
// its body without the heading, up to the next `## ` heading. `## 0.4.18`
// never matches `## 0.4.18-alpha.0`. Returns null when the section is missing
// or empty, so callers never publish empty notes.
function changelogSection(markdown: string, version: string): ChangelogSection | null {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^## ${escapeRegExp(version)}(?: - (\\d{4}-\\d{2}-\\d{2}))?\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return null;
  }

  const date = heading.exec(lines[start]!)?.[1];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : { body, date };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main(argv: readonly string[]): void {
  const [version, file = "CHANGELOG.md"] = argv;
  if (version === undefined) {
    console.error("usage: changelog-section.ts <version> [CHANGELOG.md]");
    process.exit(2);
  }

  const section = changelogSection(readFileSync(file, "utf8"), version);
  if (section === null) {
    console.error(`${file} has no non-empty "## ${version} - YYYY-MM-DD" section.`);
    process.exit(1);
  }
  console.log(section.body);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

export { changelogSection };
export type { ChangelogSection };
