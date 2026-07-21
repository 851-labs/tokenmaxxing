import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CcusageDay } from "../ccusage/schema";
import { roundUsd } from "./cost";
import { localDay, onOrAfter } from "./dates";
import type { LocalUsageReport } from "./grok";
import type { LoadPricingOptions, PricingTable } from "./openrouter";
import { estimateCost, loadOpenRouterPricing, matchPricing } from "./openrouter";
import { fieldMessage, fieldNumber, fieldString, findField, readProtoFields } from "./protobuf";

/**
 * Antigravity (agy) keeps one SQLite database per conversation under
 * ~/.gemini/antigravity-cli/conversations/<uuid>.db. The gen_metadata table
 * holds one protobuf blob per model generation; field numbers below were
 * reverse-engineered from agy 1.1.x and are validated shape-first, so a
 * future schema change degrades to "no data" instead of bad numbers:
 *
 *   .1        generation record
 *   .1.4      usage message: 2 = input tokens, 3 = output tokens, 5 = cached
 *   .1.9.4.1  generation timestamp (unix seconds)
 *   .1.19     model id (e.g. "claude-sonnet-4-6", "gemini-3.6-flash")
 *
 * Input tokens exclude cached tokens already (claude-style). No cost is
 * recorded locally, so costs are estimated from OpenRouter list prices —
 * unknown models degrade to cost 0 and report tokens only.
 */

interface AntigravityGeneration {
  cacheReadTokens: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  ts: number;
}

interface TokenTotals {
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface CollectOptions extends LoadPricingOptions {
  cacheDir?: string | undefined;
  dayOf?: ((epochSeconds: number) => string) | undefined;
  home?: string | undefined;
  since?: string | undefined;
}

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/ -]{2,63}$/i;

/**
 * node:sqlite under Node (the shipped CLI), bun:sqlite under Bun (dev and
 * the compiled service runners). The specifier is built at runtime so
 * `bun build --target node` doesn't try to resolve it statically.
 */
interface SqliteDatabase {
  close(): void;
  prepare(sql: string): { all(): unknown[] };
}

type OpenDatabase = (path: string) => SqliteDatabase;

async function loadSqlite(): Promise<OpenDatabase | undefined> {
  if (process.versions.bun !== undefined) {
    const module = (await import("bun:sqlite").catch(() => undefined)) as
      | { Database?: new (path: string, options?: { readonly?: boolean }) => SqliteDatabase }
      | undefined;
    const Database = module?.Database;
    return Database === undefined
      ? undefined
      : (path) => openReadOnly(path, (p) => new Database(p, { readonly: true }));
  }

  const module = (await import("node:sqlite").catch(() => undefined)) as
    | { DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase }
    | undefined;
  const DatabaseSync = module?.DatabaseSync;
  return DatabaseSync === undefined
    ? undefined
    : (path) => openReadOnly(path, (p) => new DatabaseSync(p, { readOnly: true }));
}

/**
 * Read-only, falling back to an immutable open: agy checkpoints and deletes
 * the -wal/-shm files on close, and a WAL-mode database without them cannot
 * be opened plain-readonly (SQLite would need to create the shm file).
 * bun:sqlite opens lazily, so a probe query forces the file open here.
 */
function openReadOnly(path: string, open: (path: string) => SqliteDatabase): SqliteDatabase {
  for (const candidate of [path, `file:${encodeURI(path)}?immutable=1`]) {
    try {
      const db = open(candidate);
      db.prepare("SELECT 1").all();
      return db;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`cannot open ${path}`);
}

/** One gen_metadata blob -> one generation, or null when the shape drifts. */
function parseGenMetadata(data: Uint8Array): AntigravityGeneration | null {
  const record = fieldMessage(findField(readProtoFields(data), 1));
  if (record.length === 0) {
    return null;
  }

  const model = fieldString(findField(record, 19));
  const usage = fieldMessage(findField(record, 4));
  const inputTokens = fieldNumber(findField(usage, 2));
  const outputTokens = fieldNumber(findField(usage, 3));
  const cacheReadTokens = fieldNumber(findField(usage, 5)) ?? 0;
  const timing = fieldMessage(findField(record, 9));
  const timestamp = fieldNumber(findField(fieldMessage(findField(timing, 4)), 1));

  if (
    model === undefined ||
    !MODEL_ID_PATTERN.test(model) ||
    timestamp === undefined ||
    timestamp < 1e9 ||
    timestamp >= 1e12 ||
    (inputTokens === undefined && outputTokens === undefined)
  ) {
    return null;
  }

  return {
    cacheReadTokens,
    inputTokens: inputTokens ?? 0,
    model,
    outputTokens: outputTokens ?? 0,
    ts: timestamp,
  };
}

/** Pure: bucket generations into claude-dialect days, pricing cost from OpenRouter. */
function aggregateGenerations(
  generations: readonly AntigravityGeneration[],
  options: {
    dayOf?: ((epochSeconds: number) => string) | undefined;
    pricing?: PricingTable | undefined;
    since?: string | undefined;
  } = {},
): CcusageDay[] {
  const dayOf = options.dayOf ?? localDay;
  const pricing = options.pricing ?? {};
  const byDay = new Map<string, Map<string, { cost: number; tokens: TokenTotals }>>();

  for (const generation of generations) {
    const date = dayOf(generation.ts);
    if (!onOrAfter(date, options.since)) {
      continue;
    }

    let dayModels = byDay.get(date);
    if (dayModels === undefined) {
      dayModels = new Map();
      byDay.set(date, dayModels);
    }
    const merged = dayModels.get(generation.model) ?? {
      cost: 0,
      tokens: { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 },
    };
    dayModels.set(generation.model, {
      cost:
        merged.cost +
        estimateCost(
          {
            cacheReadTokens: generation.cacheReadTokens,
            inputTokens: generation.inputTokens,
            outputTokens: generation.outputTokens,
          },
          matchPricing(pricing, generation.model),
        ),
      tokens: {
        cacheReadTokens: merged.tokens.cacheReadTokens + generation.cacheReadTokens,
        inputTokens: merged.tokens.inputTokens + generation.inputTokens,
        outputTokens: merged.tokens.outputTokens + generation.outputTokens,
      },
    });
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, models]) => {
      const modelBreakdowns = [...models.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelName, entry]) => ({
          cacheCreationTokens: 0,
          cacheReadTokens: entry.tokens.cacheReadTokens,
          cost: roundUsd(entry.cost),
          inputTokens: entry.tokens.inputTokens,
          modelName,
          outputTokens: entry.tokens.outputTokens,
        }));

      return {
        date,
        modelBreakdowns,
        totalCost: roundUsd(modelBreakdowns.reduce((sum, entry) => sum + entry.cost, 0)),
      };
    });
}

/** Every conversation database under ~/.gemini/antigravity-cli, aggregated. */
async function collectAntigravityUsage(options: CollectOptions = {}): Promise<LocalUsageReport> {
  const openDatabase = await loadSqlite();
  if (openDatabase === undefined) {
    return { days: [], sessionIds: [] };
  }

  const home = options.home ?? join(homedir(), ".gemini", "antigravity-cli");
  const conversationsDir = join(home, "conversations");
  let entries;
  try {
    entries = await readdir(conversationsDir, { withFileTypes: true });
  } catch {
    return { days: [], sessionIds: [] };
  }

  const since = options.since;
  const dayOf = options.dayOf ?? localDay;
  const generations: AntigravityGeneration[] = [];
  const sessionIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) {
      continue;
    }

    let sessionGenerations: AntigravityGeneration[];
    try {
      sessionGenerations = readGenerations(openDatabase, join(conversationsDir, entry.name));
    } catch {
      continue;
    }

    const inRange = sessionGenerations.filter((generation) =>
      onOrAfter(dayOf(generation.ts), since),
    );
    if (inRange.length === 0) {
      continue;
    }

    sessionIds.push(entry.name.replace(/\.db$/, ""));
    generations.push(...inRange);
  }

  if (generations.length === 0) {
    return { days: [], sessionIds };
  }

  // No local data must never cost a network call.
  const pricing =
    options.cacheDir === undefined
      ? {}
      : await loadOpenRouterPricing(options.cacheDir, options).catch(() => ({}));

  return {
    days: aggregateGenerations(generations, { dayOf, pricing, since }),
    sessionIds,
  };
}

function readGenerations(openDatabase: OpenDatabase, dbPath: string): AntigravityGeneration[] {
  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare("SELECT data FROM gen_metadata").all();
    const generations: AntigravityGeneration[] = [];
    for (const row of rows) {
      const data = (row as { data?: unknown }).data;
      if (!(data instanceof Uint8Array)) {
        continue;
      }
      const generation = parseGenMetadata(data);
      if (generation !== null) {
        generations.push(generation);
      }
    }

    return generations;
  } finally {
    db.close();
  }
}

export { aggregateGenerations, collectAntigravityUsage, parseGenMetadata };

export type { AntigravityGeneration };
