import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { CcusageDay } from "../ccusage/schema";
import { roundUsd } from "./cost";
import { localDay, onOrAfter } from "./dates";

/**
 * Grok CLI (xAI) keeps one directory per session under
 * ~/.grok/sessions/<url-encoded-cwd>/<session-id>/ with an updates.jsonl
 * ACP stream. Lines whose params.update.sessionUpdate is "turn_completed"
 * carry the turn's token usage — split per model under usage.modelUsage —
 * plus a vendor-computed cost in costUsdTicks (nano-USD).
 *
 * Grok's inputTokens include cachedReadTokens; the claude dialect emitted
 * here reports them separately, so cached tokens are subtracted from input.
 * Streamed line-by-line with a substring pre-filter: updates.jsonl files
 * reach tens of MB and mostly hold conversation content, which must never
 * leave the machine.
 */

const TICKS_PER_USD = 1_000_000_000;

interface GrokModelUsage {
  cachedReadTokens?: number;
  costUsdTicks?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface GrokTurnUsage {
  modelUsage: Record<string, GrokModelUsage>;
  ts: number;
}

interface LocalUsageReport {
  days: CcusageDay[];
  sessionIds: string[];
}

interface CollectOptions {
  dayOf?: ((epochSeconds: number) => string) | undefined;
  home?: string | undefined;
  since?: string | undefined;
}

/** Pure: bucket per-turn usage into claude-dialect days. */
function aggregateGrokTurns(
  turns: readonly GrokTurnUsage[],
  options: Pick<CollectOptions, "dayOf" | "since"> = {},
): CcusageDay[] {
  interface ModelTotals {
    cacheReadTokens: number;
    costUsdTicks: number;
    inputTokens: number;
    outputTokens: number;
  }

  const dayOf = options.dayOf ?? localDay;
  const byDay = new Map<string, Map<string, ModelTotals>>();

  for (const turn of turns) {
    const date = dayOf(turn.ts);
    if (!onOrAfter(date, options.since)) {
      continue;
    }

    for (const [model, usage] of Object.entries(turn.modelUsage)) {
      const input = usage.inputTokens ?? 0;
      const cacheRead = Math.min(usage.cachedReadTokens ?? 0, input);
      if (input === 0 && (usage.outputTokens ?? 0) === 0 && cacheRead === 0) {
        continue;
      }

      let dayModels = byDay.get(date);
      if (dayModels === undefined) {
        dayModels = new Map();
        byDay.set(date, dayModels);
      }
      const merged = dayModels.get(model) ?? {
        cacheReadTokens: 0,
        costUsdTicks: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      dayModels.set(model, {
        cacheReadTokens: merged.cacheReadTokens + cacheRead,
        costUsdTicks: merged.costUsdTicks + (usage.costUsdTicks ?? 0),
        inputTokens: merged.inputTokens + input,
        outputTokens: merged.outputTokens + (usage.outputTokens ?? 0),
      });
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, models]) => {
      const modelBreakdowns = [...models.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelName, usage]) => ({
          cacheCreationTokens: 0,
          cacheReadTokens: usage.cacheReadTokens,
          cost: roundUsd(usage.costUsdTicks / TICKS_PER_USD),
          inputTokens: usage.inputTokens - usage.cacheReadTokens,
          modelName,
          outputTokens: usage.outputTokens,
        }));

      return {
        date,
        modelBreakdowns,
        totalCost: roundUsd(modelBreakdowns.reduce((sum, entry) => sum + entry.cost, 0)),
      };
    });
}

/** One session's updates.jsonl -> its turn_completed usage entries. */
async function readGrokTurns(filePath: string): Promise<GrokTurnUsage[]> {
  const turns: GrokTurnUsage[] = [];
  const lines = createInterface({ input: createReadStream(filePath) });

  for await (const line of lines) {
    if (!line.includes('"turn_completed"')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        params?: { update?: { sessionUpdate?: string; usage?: { modelUsage?: unknown } } };
        timestamp?: unknown;
      };
      if (parsed.params?.update?.sessionUpdate !== "turn_completed") {
        continue;
      }

      const ts = parsed.timestamp;
      const modelUsage = parsed.params.update.usage?.modelUsage;
      if (
        typeof ts !== "number" ||
        ts <= 0 ||
        ts >= 1e12 ||
        modelUsage === undefined ||
        modelUsage === null ||
        typeof modelUsage !== "object"
      ) {
        continue;
      }

      turns.push({ modelUsage: modelUsage as Record<string, GrokModelUsage>, ts });
    } catch {
      // Partial/garbled line — skip it.
    }
  }

  return turns;
}

/** Every session under ~/.grok (or $GROK_HOME), aggregated. */
async function collectGrokUsage(options: CollectOptions = {}): Promise<LocalUsageReport> {
  const home = options.home ?? process.env["GROK_HOME"] ?? join(homedir(), ".grok");
  const sessionsRoot = join(home, "sessions");

  const days: CcusageDay[] = [];
  const sessionIds: string[] = [];
  let projectDirs;
  try {
    projectDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return { days, sessionIds };
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    let sessionDirs;
    try {
      sessionDirs = await readdir(join(sessionsRoot, projectDir.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) {
        continue;
      }

      let turns: GrokTurnUsage[];
      try {
        turns = await readGrokTurns(
          join(sessionsRoot, projectDir.name, sessionDir.name, "updates.jsonl"),
        );
      } catch {
        continue;
      }

      // Sessions count only when they have turns in the requested range.
      const dayOf = options.dayOf ?? localDay;
      const inRange = turns.filter((turn) => onOrAfter(dayOf(turn.ts), options.since));
      if (inRange.length === 0) {
        continue;
      }

      sessionIds.push(sessionDir.name);
      days.push(...aggregateGrokTurns(inRange, options));
    }
  }

  return { days: mergeDays(days), sessionIds };
}

/** Sessions each produce disjoint day rows; merge them back together. */
function mergeDays(days: readonly CcusageDay[]): CcusageDay[] {
  const byDay = new Map<string, CcusageDay>();

  for (const day of days) {
    const existing = byDay.get(day.date);
    if (existing === undefined) {
      byDay.set(day.date, { ...day, modelBreakdowns: [...(day.modelBreakdowns ?? [])] });
      continue;
    }

    const breakdowns = [...(existing.modelBreakdowns ?? [])];
    for (const breakdown of day.modelBreakdowns ?? []) {
      const index = breakdowns.findIndex((entry) => entry.modelName === breakdown.modelName);
      if (index === -1) {
        breakdowns.push({ ...breakdown });
      } else {
        const match = breakdowns[index]!;
        breakdowns[index] = {
          ...match,
          cacheCreationTokens:
            (match.cacheCreationTokens ?? 0) + (breakdown.cacheCreationTokens ?? 0),
          cacheReadTokens: (match.cacheReadTokens ?? 0) + (breakdown.cacheReadTokens ?? 0),
          cost: roundUsd((match.cost ?? 0) + (breakdown.cost ?? 0)),
          inputTokens: (match.inputTokens ?? 0) + (breakdown.inputTokens ?? 0),
          outputTokens: (match.outputTokens ?? 0) + (breakdown.outputTokens ?? 0),
        };
      }
    }
    byDay.set(day.date, {
      ...existing,
      modelBreakdowns: breakdowns,
      totalCost: roundUsd((existing.totalCost ?? 0) + (day.totalCost ?? 0)),
    });
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export { aggregateGrokTurns, collectGrokUsage, readGrokTurns };

export type { GrokModelUsage, GrokTurnUsage, LocalUsageReport };
