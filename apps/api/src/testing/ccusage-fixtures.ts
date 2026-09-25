import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { UsageSource } from "@tokenmaxxing/api-contract";

/**
 * Real `ccusage <source> daily --json --breakdown --mode calculate` output from
 * ccusage 20.0.24, one file per source under `usage/fixtures/ccusage/`. Grok is
 * trimmed from a real machine; the others ran against small synthetic data
 * directories written in each agent's on-disk format.
 */

interface CcusageFixtureBreakdown {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  inputTokens: number;
  modelName: string;
  outputTokens: number;
}

interface CcusageFixtureDay {
  date: string;
  modelBreakdowns: CcusageFixtureBreakdown[];
  totalCost: number;
  totalTokens: number;
}

interface CcusageFixtureReport {
  daily: CcusageFixtureDay[];
}

const CCUSAGE_FIXTURE_SOURCES = [
  "grok",
  "antigravity",
  "zcode",
  "amp",
  "qwen",
  "kimi",
  "kilo",
  "goose",
  "droid",
  "codebuff",
  "openclaw",
] as const satisfies readonly UsageSource[];

type CcusageFixtureSource = (typeof CCUSAGE_FIXTURE_SOURCES)[number];

function ccusageDailyFixture(source: CcusageFixtureSource): CcusageFixtureReport {
  const path = join(import.meta.dirname, "../usage/fixtures/ccusage", `${source}.daily.json`);

  return JSON.parse(readFileSync(path, "utf8")) as CcusageFixtureReport;
}

function ccusageDailyCommand(source: CcusageFixtureSource): string[] {
  return ["ccusage@^20.0.22", source, "daily", "--json", "--breakdown", "--mode", "calculate"];
}

export { CCUSAGE_FIXTURE_SOURCES, ccusageDailyCommand, ccusageDailyFixture };

export type { CcusageFixtureDay, CcusageFixtureReport, CcusageFixtureSource };
