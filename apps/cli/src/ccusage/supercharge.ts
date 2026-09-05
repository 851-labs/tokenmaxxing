import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Data, Effect } from "effect";

import type { CcusageDay } from "./schema";

/**
 * Native collector for Supercharge sessions. Supercharge records completed
 * turns as `turn_completed` entries in `sessions/<project>/<session>/updates.jsonl`
 * under the Supercharge data home, with per-model usage in `modelUsage`.
 *
 * Only records carrying usage are counted; everything is aggregated into the
 * shared ccusage daily-report shape so the rest of the sync pipeline is
 * unchanged. This source is collected directly, not through ccusage.
 */

const COST_USD_TICKS_PER_USD = 1e10;

export interface SuperchargeModelUsage {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export class SuperchargeCollectError extends Data.TaggedError("SuperchargeCollectError")<{
  readonly cause: unknown;
}> {}

interface SuperchargeOptions {
  /** Injectable for tests. */
  listSessionFiles?: () => Effect.Effect<string[], SuperchargeCollectError>;
  readUpdates?: (path: string) => Effect.Effect<string, SuperchargeCollectError>;
}

function superchargeDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SUPERCHARGE_HOME?.trim();
  return override !== undefined && override !== "" ? override : join(homedir(), ".supercharge");
}

/** Recursively collect every `updates.jsonl` under the sessions root. */
function sessionFiles(root: string): Effect.Effect<string[], SuperchargeCollectError> {
  return Effect.tryPromise({
    catch: (cause) => new SuperchargeCollectError({ cause }),
    try: async () => {
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(path);
          } else if (entry.isFile() && entry.name === "updates.jsonl") {
            files.push(path);
          }
        }
      };
      await walk(root);
      return files;
    },
  });
}

function readUpdates(path: string): Effect.Effect<string, SuperchargeCollectError> {
  return Effect.tryPromise({
    catch: (cause) => new SuperchargeCollectError({ cause }),
    try: () => readFile(path, "utf8"),
  });
}

interface ParsedDay {
  date: string;
  model: string;
  usage: SuperchargeModelUsage;
}

interface CollectResult {
  days: ParsedDay[];
  sessions: number;
}

function parseUpdates(content: string): ParsedDay[] {
  const days: ParsedDay[] = [];
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.includes('"turn_completed"')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const params = record?.params;
    const update = params?.update;
    const usage = update?.usage;
    if (update?.sessionUpdate !== "turn_completed" || usage === undefined) continue;

    const timestampMs =
      typeof params?._meta?.agentTimestampMs === "number" && params._meta.agentTimestampMs > 0
        ? params._meta.agentTimestampMs
        : typeof record?.timestamp === "number" && record.timestamp > 0
          ? record.timestamp * 1000
          : 0;
    if (timestampMs === 0) continue;
    const date = new Date(timestampMs).toISOString().slice(0, 10);

    for (const entry of modelUsageRows(usage)) {
      const dedupeKey = [
        params?.sessionId ?? "",
        params?._meta?.eventId ?? "",
        timestampMs,
        entry.model,
        entry.usage.inputTokens,
        entry.usage.outputTokens,
      ].join("|");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      days.push({ date, model: entry.model, usage: entry.usage });
    }
  }
  return days;
}

function modelUsageRows(usage: any): { model: string; usage: SuperchargeModelUsage }[] {
  const map = usage?.modelUsage;
  if (map === undefined || map === null || typeof map !== "object") return [];
  return Object.entries(map)
    .filter(([model, entry]: [string, any]) => model.trim() !== "" && hasTokens(entry))
    .map(([model, entry]: [string, any]) => ({
      model,
      usage: {
        cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        cacheReadTokens: entry.cachedReadTokens ?? 0,
        costUsd: (entry.costUsdTicks ?? 0) / COST_USD_TICKS_PER_USD,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        reasoningTokens: entry.reasoningTokens ?? 0,
      },
    }));
}

function hasTokens(entry: any): boolean {
  return (
    (entry?.inputTokens ?? 0) > 0 ||
    (entry?.outputTokens ?? 0) > 0 ||
    (entry?.cachedReadTokens ?? 0) > 0
  );
}

function collectSuperchargeDays(
  options: SuperchargeOptions = {},
): Effect.Effect<CollectResult, SuperchargeCollectError> {
  const root = superchargeDataHome();
  const sessionsRoot = join(root, "sessions");
  const listSessionFiles = options.listSessionFiles ?? (() => sessionFiles(sessionsRoot));
  const readUpdatesFor = options.readUpdates ?? readUpdates;

  return listSessionFiles().pipe(
    Effect.flatMap((files) =>
      Effect.forEach(files, (file) => readUpdatesFor(file), { concurrency: "unbounded" }),
    ),
    Effect.map((contents) => {
      const days = contents.flatMap(parseUpdates);
      const sessions = new Set<string>();
      for (const content of contents) {
        for (const line of content.split("\n")) {
          if (!line.includes('"turn_completed"')) continue;
          try {
            const sessionId = JSON.parse(line)?.params?.sessionId;
            if (sessionId) sessions.add(sessionId);
          } catch {
            // skip malformed lines
          }
        }
      }
      return { days, sessions: sessions.size };
    }),
  );
}

/** Aggregate parsed turns into the ccusage daily-report shape (one row per date+model). */
function superchargeDailyReport(days: readonly ParsedDay[]): { daily: CcusageDay[] } {
  const byKey = new Map<string, CcusageDay>();
  for (const { date, model, usage } of days) {
    const key = `${date}|${model}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUSD: usage.costUsd,
        date,
        inputTokens: usage.inputTokens,
        modelBreakdowns: [
          {
            cacheCreationTokens: usage.cacheCreationTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cost: usage.costUsd,
            inputTokens: usage.inputTokens,
            modelName: model,
            outputTokens: usage.outputTokens,
          },
        ],
        modelsUsed: [model],
        outputTokens: usage.outputTokens,
        totalCost: usage.costUsd,
        totalTokens:
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheCreationTokens +
          usage.cacheReadTokens,
      });
      continue;
    }
    const prev = existing.modelBreakdowns?.[0];
    byKey.set(key, {
      ...existing,
      inputTokens: (existing.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (existing.outputTokens ?? 0) + usage.outputTokens,
      cacheCreationTokens: (existing.cacheCreationTokens ?? 0) + usage.cacheCreationTokens,
      cacheReadTokens: (existing.cacheReadTokens ?? 0) + usage.cacheReadTokens,
      totalCost: (existing.totalCost ?? 0) + usage.costUsd,
      costUSD: (existing.costUSD ?? 0) + usage.costUsd,
      totalTokens: (existing.totalTokens ?? 0) + usage.inputTokens + usage.outputTokens,
      modelBreakdowns:
        prev === undefined
          ? undefined
          : [
              {
                cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + usage.cacheCreationTokens,
                cacheReadTokens: (prev.cacheReadTokens ?? 0) + usage.cacheReadTokens,
                cost: (prev.cost ?? 0) + usage.costUsd,
                inputTokens: (prev.inputTokens ?? 0) + usage.inputTokens,
                modelName: prev.modelName,
                outputTokens: (prev.outputTokens ?? 0) + usage.outputTokens,
              },
            ],
    });
  }
  return { daily: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export { collectSuperchargeDays, superchargeDailyReport };
export type { ParsedDay };
