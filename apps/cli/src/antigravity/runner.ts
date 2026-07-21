import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Data, Effect, Option } from "effect";

import { runCcusageDailyReport, type RunOptions } from "../ccusage/runner";
import type { CcusageDailyReport, CcusageDay, CcusageSessionReport } from "../ccusage/schema";
import {
  parseAntigravityGeneration,
  parseAntigravitySessionTimestamp,
  type AntigravityUsageEvent,
} from "./protobuf";

const ANTIGRAVITY_SOURCE = "antigravity-cli";
const SYNTHETIC_GEMINI_SOURCE = {
  kind: "ccusage",
  source: ANTIGRAVITY_SOURCE,
  subcommand: "gemini",
} as const;

class AntigravityReadError extends Data.TaggedError("AntigravityReadError")<{
  readonly cause: unknown;
}> {}

interface AntigravityCollection {
  events: AntigravityUsageEvent[];
  sessionCount: number;
}

interface AntigravityReports {
  daily: Option.Option<CcusageDailyReport>;
  session: Option.Option<CcusageSessionReport>;
}

interface CollectOptions extends RunOptions {
  conversationDirectories?: readonly string[] | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  homeDirectory?: string | undefined;
}

interface ReadonlySqliteDatabase {
  close(): void;
  prepare(sql: string): {
    all(): unknown[];
    get(): unknown;
  };
}

type SqliteDatabaseConstructor = new (
  path: string,
  options: { readOnly?: boolean | undefined; readonly?: boolean | undefined },
) => ReadonlySqliteDatabase;

/**
 * Antigravity CLI v1.1.x stores newer conversations in SQLite databases under
 * ~/.gemini/antigravity-cli/conversations. Only token metadata is read; prompt,
 * response, tool, workspace, and transcript blobs never leave the database.
 */
function collectAntigravityUsage(
  options: CollectOptions = {},
): Effect.Effect<AntigravityCollection, AntigravityReadError> {
  return Effect.tryPromise({
    try: async () => {
      const directories =
        options.conversationDirectories ??
        resolveConversationDirectories(
          options.environment ?? process.env,
          options.homeDirectory ?? homedir(),
        );
      const events: AntigravityUsageEvent[] = [];
      const sessions = new Set<string>();
      const seenDatabasePaths = new Set<string>();

      for (const directory of directories) {
        const entries = await readdir(directory, { withFileTypes: true })
          .then((items) => items.sort((left, right) => left.name.localeCompare(right.name)))
          .catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".db")) {
            continue;
          }

          const path = join(directory, entry.name);
          const canonicalPath = await realpath(path).catch(() => resolve(path));
          if (seenDatabasePaths.has(canonicalPath)) {
            continue;
          }
          seenDatabasePaths.add(canonicalPath);

          const sessionId = basename(entry.name, ".db");
          const fallbackTimestampMs = await stat(path)
            .then((metadata) => Math.trunc(metadata.mtimeMs))
            .catch(() => 0);
          const sessionEvents = await readConversationDatabase(
            canonicalPath,
            sessionId,
            fallbackTimestampMs,
          );
          const filtered = filterSince(sessionEvents, options.since);
          if (filtered.length > 0) {
            sessions.add(sessionId);
            events.push(...filtered);
          }
        }
      }

      events.sort(
        (left, right) =>
          left.timestampMs - right.timestampMs ||
          left.sessionId.localeCompare(right.sessionId) ||
          (left.responseId ?? "").localeCompare(right.responseId ?? "") ||
          left.model.localeCompare(right.model),
      );
      return { events, sessionCount: sessions.size };
    },
    catch: (cause) => new AntigravityReadError({ cause }),
  });
}

function runAntigravityReports(options: CollectOptions = {}): Effect.Effect<AntigravityReports> {
  return Effect.gen(function* () {
    const collection = yield* collectAntigravityUsage(options);
    if (collection.events.length === 0) {
      return { daily: Option.none(), session: Option.none() };
    }

    const daily = yield* priceWithCcusage(collection.events, options);
    const session = Option.some({
      // The server needs only the count. Null placeholders avoid uploading
      // conversation IDs, project paths, or any other session metadata.
      sessions: Array.from({ length: collection.sessionCount }, () => null),
    });

    return { daily, session };
  }).pipe(
    // Match existing source isolation: unreadable or drifting local state must
    // not abort usage sync for every other agent.
    Effect.catchCause(() =>
      Effect.succeed({ daily: Option.none(), session: Option.none() } satisfies AntigravityReports),
    ),
  );
}

function priceWithCcusage(
  events: readonly AntigravityUsageEvent[],
  options: CollectOptions,
): Effect.Effect<Option.Option<CcusageDailyReport>> {
  const acquire = Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "tokenmaxxing-antigravity-")),
    catch: (cause) => new AntigravityReadError({ cause }),
  });

  return Effect.acquireUseRelease(
    acquire,
    (directory) =>
      Effect.gen(function* () {
        const chatsDirectory = join(directory, "chats");
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(chatsDirectory, { recursive: true });
            await writeFile(
              join(chatsDirectory, "antigravity.jsonl"),
              `${events.map(toGeminiJsonLine).join("\n")}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
          },
          catch: (cause) => new AntigravityReadError({ cause }),
        });

        const priced = yield* runCcusageDailyReport(SYNTHETIC_GEMINI_SOURCE, {
          environment: {
            ...(options.environment ?? process.env),
            GEMINI_DATA_DIR: directory,
          },
          since: options.since,
        });

        return Option.match(priced, {
          onNone: () => Option.some(buildFallbackDailyReport(events)),
          onSome: (report) => Option.some(enrichDailyReport(report, events)),
        });
      }),
    (directory) =>
      Effect.promise(() => rm(directory, { force: true, recursive: true }).catch(() => {})),
  ).pipe(Effect.catchCause(() => Effect.succeed(Option.some(buildFallbackDailyReport(events)))));
}

async function readConversationDatabase(
  path: string,
  sessionId: string,
  fileTimestampMs: number,
): Promise<AntigravityUsageEvent[]> {
  let database: ReadonlySqliteDatabase | undefined;
  try {
    database = await openReadonlyDatabase(path);
    const trajectory = tryReadTrajectory(database);
    const trajectoryBytes = bytesValue(trajectory?.data);
    const fallbackTimestampMs =
      (trajectoryBytes === undefined
        ? undefined
        : parseAntigravitySessionTimestamp(trajectoryBytes)) ?? fileTimestampMs;
    const rows = database.prepare("SELECT data FROM gen_metadata ORDER BY idx").all() as Array<{
      data?: unknown;
    }>;
    const seenResponseIds = new Set<string>();

    return rows.flatMap((row) => {
      const bytes = bytesValue(row.data);
      if (bytes === undefined) {
        return [];
      }

      const event = parseAntigravityGeneration(
        bytes,
        sessionId,
        fallbackTimestampMs,
        seenResponseIds,
      );
      return event === undefined ? [] : [event];
    });
  } catch {
    // Old .pb sessions, partially migrated databases, and live schema changes
    // are unsupported input rather than a reason to abort every other source.
    return [];
  } finally {
    database?.close();
  }
}

function tryReadTrajectory(database: ReadonlySqliteDatabase): { data?: unknown } | undefined {
  try {
    return database.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get() as
      | { data?: unknown }
      | undefined;
  } catch {
    // Older databases have gen_metadata but no trajectory table. Their file
    // mtime remains a valid session-level timestamp fallback.
    return undefined;
  }
}

async function openReadonlyDatabase(path: string): Promise<ReadonlySqliteDatabase> {
  const runningOnBun = typeof Bun !== "undefined";
  const specifier = runningOnBun ? "bun:sqlite" : "node:sqlite";
  const sqlite = (await import(specifier)) as Record<string, unknown>;
  const constructor = sqlite[runningOnBun ? "Database" : "DatabaseSync"] as
    | SqliteDatabaseConstructor
    | undefined;
  if (constructor === undefined) {
    throw new Error(`SQLite is unavailable in this ${runningOnBun ? "Bun" : "Node.js"} runtime`);
  }

  return new constructor(path, runningOnBun ? { readonly: true } : { readOnly: true });
}

function resolveConversationDirectories(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string[] {
  const configured = environment.GEMINI_CLI_HOME?.trim();
  const userHome = configured === undefined || configured.length === 0 ? homeDirectory : configured;
  return [join(resolve(userHome), ".gemini", "antigravity-cli", "conversations")];
}

function filterSince(
  events: readonly AntigravityUsageEvent[],
  since: string | undefined,
): AntigravityUsageEvent[] {
  if (since === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return [...events];
  }

  return events.filter((event) => localDate(event.timestampMs) >= since);
}

function toGeminiJsonLine(event: AntigravityUsageEvent): string {
  return JSON.stringify({
    ...(event.responseId === undefined ? {} : { id: event.responseId }),
    model: event.model,
    sessionId: event.sessionId,
    timestamp: new Date(event.timestampMs).toISOString(),
    tokens: {
      cached: event.cacheReadTokens,
      input: event.inputTokens,
      output: event.outputTokens,
      thoughts: event.reasoningTokens,
      total: event.totalTokens,
    },
    type: "gemini",
  });
}

function enrichDailyReport(
  report: CcusageDailyReport,
  events: readonly AntigravityUsageEvent[],
): CcusageDailyReport {
  const totals = eventTotalsByDayAndModel(events);

  return {
    daily: report.daily.map((day) => ({
      ...day,
      modelBreakdowns: day.modelBreakdowns?.map((breakdown) => {
        const total = totals.get(dayModelKey(day.date, breakdown.modelName));
        return total === undefined
          ? breakdown
          : {
              ...breakdown,
              reasoningTokens: total.reasoningTokens,
              totalTokens: total.totalTokens,
            };
      }),
    })),
  };
}

function buildFallbackDailyReport(events: readonly AntigravityUsageEvent[]): CcusageDailyReport {
  interface MutableDay {
    cacheCreationTokens: number;
    cacheReadTokens: number;
    date: string;
    inputTokens: number;
    modelBreakdowns: NonNullable<CcusageDay["modelBreakdowns"]>[number][];
    modelsUsed: string[];
    outputTokens: number;
    totalCost: number;
    totalTokens: number;
  }

  const days = new Map<string, MutableDay>();
  const totals = eventTotalsByDayAndModel(events);
  for (const [key, total] of totals) {
    const separator = key.indexOf("\0");
    const date = key.slice(0, separator);
    const model = key.slice(separator + 1);
    const day = days.get(date) ?? {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      date,
      inputTokens: 0,
      modelBreakdowns: [],
      modelsUsed: [],
      outputTokens: 0,
      totalCost: 0,
      totalTokens: 0,
    };
    day.cacheReadTokens = saturatingTokenAdd(day.cacheReadTokens, total.cacheReadTokens);
    day.inputTokens = saturatingTokenAdd(day.inputTokens, total.inputTokens);
    day.outputTokens = saturatingTokenAdd(day.outputTokens, total.outputTokens);
    day.totalTokens = saturatingTokenAdd(day.totalTokens, total.totalTokens);
    day.modelBreakdowns.push({
      cacheCreationTokens: 0,
      cacheReadTokens: total.cacheReadTokens,
      cost: 0,
      inputTokens: total.inputTokens,
      modelName: model,
      outputTokens: total.outputTokens,
      reasoningTokens: total.reasoningTokens,
      totalTokens: total.totalTokens,
    });
    day.modelsUsed.push(model);
    days.set(date, day);
  }

  return { daily: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)) };
}

interface EventTotals {
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function eventTotalsByDayAndModel(
  events: readonly AntigravityUsageEvent[],
): Map<string, EventTotals> {
  const totals = new Map<string, EventTotals>();
  for (const event of events) {
    const key = dayModelKey(localDate(event.timestampMs), event.model);
    const previous = totals.get(key) ?? {
      cacheReadTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    totals.set(key, {
      cacheReadTokens: saturatingTokenAdd(previous.cacheReadTokens, event.cacheReadTokens),
      inputTokens: saturatingTokenAdd(previous.inputTokens, event.inputTokens),
      outputTokens: saturatingTokenAdd(previous.outputTokens, event.outputTokens),
      reasoningTokens: saturatingTokenAdd(previous.reasoningTokens, event.reasoningTokens),
      totalTokens: saturatingTokenAdd(previous.totalTokens, event.totalTokens),
    });
  }

  return totals;
}

function saturatingTokenAdd(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    const normalized = Math.max(Math.trunc(Number.isFinite(value) ? value : 0), 0);
    if (normalized >= Number.MAX_SAFE_INTEGER - total) {
      return Number.MAX_SAFE_INTEGER;
    }
    total += normalized;
  }

  return total;
}

function localDate(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayModelKey(date: string, model: string): string {
  return `${date}\0${model}`;
}

function bytesValue(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

function antigravityDailyCommand(options: RunOptions = {}): string[] {
  const command = ["tokenmaxxing", "antigravity", "daily", "--format", "sqlite-protobuf-v1"];
  if (options.since !== undefined) {
    command.push("--since", options.since);
  }
  return command;
}

function antigravitySessionCommand(options: RunOptions = {}): string[] {
  const command = ["tokenmaxxing", "antigravity", "session", "--count-only"];
  if (options.since !== undefined) {
    command.push("--since", options.since);
  }
  return command;
}

export {
  antigravityDailyCommand,
  antigravitySessionCommand,
  buildFallbackDailyReport,
  collectAntigravityUsage,
  enrichDailyReport,
  resolveConversationDirectories,
  runAntigravityReports,
};

export type { AntigravityCollection, AntigravityReports, CollectOptions };
