#!/usr/bin/env bun
/**
 * Renders <outDir>/results.jsonl (and session.json / environment.json, if
 * present) as Markdown into <outDir>/summary.md and, in GitHub Actions, the
 * job's step summary. Every suite uses it, including the Windows PowerShell
 * ones.
 *
 *   bun apps/cli/e2e/shared/summarize.ts --out <dir> --title "<title>"
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJson, readResults, requiredFlag } from "./harness";

const icon: Record<string, string> = {
  FAIL: "❌",
  INFO: "ℹ️",
  PASS: "✅",
  XFAIL: "⚠️",
  XPASS: "❗",
};

function summarize(outDir: string, title: string): string {
  const rows = readResults(join(outDir, "results.jsonl"));
  const failed = rows.filter((row) => row.status === "FAIL" || row.status === "XPASS");
  const cell = (text: string | undefined, max = 400) => {
    const flat = (text ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };

  const md: string[] = [];
  const verdict =
    rows.length === 0
      ? "❌ no results"
      : failed.length > 0
        ? `❌ ${failed.length} failed`
        : "✅ passed";
  md.push(
    `## ${title} on ${process.env.RUNNER_OS ?? process.platform}/${process.env.RUNNER_ARCH ?? process.arch}: ${verdict}`,
    "",
  );

  const session = readJson<Record<string, string>>(join(outDir, "session.json"));
  if (session !== null) {
    md.push(
      `${session.os} · image ${session.image} · ${session.whoami} in session ${session.selfSessionId} (console ${session.activeConsoleSessionId}) · ${session.windowStation}\\${session.inputDesktop}`,
      "",
    );
  }
  const environment = readJson<Record<string, string>>(join(outDir, "environment.json"));
  if (environment !== null) {
    md.push(
      Object.entries(environment)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" · "),
      "",
    );
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  md.push(
    `**Checks:** ${[...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${icon[status] ?? ""} ${status} ${count}`)
      .join(" · ")}`,
    "",
  );

  if (failed.length > 0) {
    md.push("### Failures", "", "| | scenario | check | detail |", "|---|---|---|---|");
    for (const row of failed) {
      md.push(
        `| ${icon[row.status]} | ${cell(row.scenario)} | ${cell(row.check)} | ${cell(row.detail, 1500)} |`,
      );
    }
    md.push("", "Logs and the files each scenario kept are in this run's artifacts.", "");
  }

  md.push(
    "<details><summary>All checks by scenario</summary>",
    "",
    "| | scenario | check | detail |",
    "|---|---|---|---|",
  );
  for (const row of rows) {
    md.push(
      `| ${icon[row.status] ?? ""} | ${cell(row.scenario)} | ${cell(row.check)} | ${cell(row.detail)} |`,
    );
  }
  md.push("", "</details>", "");

  const text = md.join("\n");
  writeFileSync(join(outDir, "summary.md"), text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  return text;
}

if (import.meta.main) {
  console.log(summarize(requiredFlag("out"), requiredFlag("title")));
}

export { summarize };
