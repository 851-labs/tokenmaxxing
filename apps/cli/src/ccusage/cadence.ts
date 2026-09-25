import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Option, Schema } from "effect";
import type { UsageSource } from "@tokenmaxxing/api-contract";

import type { SyncResult } from "../commands/sync";
import { fingerprintSource, type LogRootOptions, type SourceFingerprint } from "./fingerprint";

/**
 * Per-source cadence for scheduled syncs (#69). Every ccusage report re-parses
 * a source's whole log corpus, so a five-minute scheduler must not run one
 * unless it can change what the server has:
 *
 * - a source whose log fingerprint matches the one taken before its last
 *   successful upload is skipped outright;
 * - a changed source re-runs its daily report from the day of that upload,
 *   so a source that was deferred or failed catches up on its own;
 * - a source whose last run was slow waits `COOLDOWN_FACTOR` times that long
 *   before running again, bounding the CPU a growing corpus can take;
 * - the full-history session report only runs on full runs (reconcile,
 *   upgrade, manual, `--force`); other runs reuse the last count locally and
 *   upload none, which leaves the server's count untouched.
 *
 * Full runs never skip. The trailing reconcile is the backstop for anything
 * fingerprints cannot see (a ccusage upgrade re-reading old logs).
 */

const SOURCE_CADENCE_FILE_NAME = "service-sources.json";
const COOLDOWN_FACTOR = 10;

const SourceCadenceEntry = Schema.Struct({
  /** Digest of the logs as they were just before the last successful upload. */
  fingerprint: Schema.optional(Schema.String),
  /** When the logs were last known to match it (ISO): the server is current up to here. */
  fingerprintAt: Schema.optional(Schema.String),
  /** When the source's reports last ran, successful or not (ISO). */
  lastRunAt: Schema.optional(Schema.String),
  /** How long those reports took, daily plus session. */
  lastRunMs: Schema.optional(Schema.Number),
  /** Last full-history session count. */
  sessions: Schema.optional(Schema.Number),
  sessionsAt: Schema.optional(Schema.String),
});

type SourceCadenceEntry = typeof SourceCadenceEntry.Type;

const SourceCadenceState = Schema.Struct({
  cliVersion: Schema.optional(Schema.String),
  sources: Schema.Record(Schema.String, SourceCadenceEntry),
  /** ccusage buckets days in this zone; a change re-buckets every day. */
  timeZone: Schema.optional(Schema.String),
  version: Schema.Literal(1),
});

type SourceCadenceState = typeof SourceCadenceState.Type;

const decodeSourceCadenceState = Schema.decodeUnknownOption(SourceCadenceState);

type SyncSourcePlan =
  | { mode: "skip"; reason: "cooldown" | "unchanged" }
  | {
      knownSessions: number | null;
      mode: "run";
      /**
       * `full`: full-history session report, uploaded. `window`: over
       * `since`, shown locally only. `reuse`: no report; show `knownSessions`.
       */
      sessions: "full" | "reuse" | "window";
      since: string | undefined;
    };

type SyncSourcePlans = Partial<Record<UsageSource, SyncSourcePlan>>;
type SourceFingerprints = Partial<Record<UsageSource, SourceFingerprint | null>>;

interface PlanSourceRunInput {
  entry: SourceCadenceEntry | undefined;
  /** `null` when the source's logs cannot be fingerprinted. */
  fingerprint: SourceFingerprint | null;
  full: boolean;
  now: Date;
  since: string | undefined;
}

interface PrepareSourceCadenceInput {
  cliVersion: string;
  /** Reconcile, backfill, manual, or forced runs never skip a source. */
  full: boolean;
  path: string;
  /** Where to look for logs; defaults to this process's env and home. */
  roots?: LogRootOptions | undefined;
  since: string | undefined;
  sources: readonly UsageSource[];
}

interface SourceCadence {
  /** Records a sync whose upload succeeded. Best effort: a lost write only costs a re-run. */
  commit: (result: Pick<SyncResult, "sourceResults" | "timings">) => Effect.Effect<void>;
  full: boolean;
  plans: SyncSourcePlans;
}

interface NextSourceCadenceStateInput {
  cliVersion: string;
  fingerprints: SourceFingerprints;
  plannedAt: Date;
  plans: SyncSourcePlans;
  result: Pick<SyncResult, "sourceResults" | "timings">;
  timeZone: string;
}

/**
 * Whether the cadence state itself calls for a full run: no state yet, the
 * first run with this CLI version (it may parse logs differently), or the
 * first after a time zone change (ccusage re-buckets every day).
 */
function sourceCadenceFullRun(
  state: SourceCadenceState | null,
  input: { cliVersion: string; timeZone: string },
): boolean {
  return (
    state === null || state.cliVersion !== input.cliVersion || state.timeZone !== input.timeZone
  );
}

function planSourceRun(input: PlanSourceRunInput): SyncSourcePlan {
  const { entry, now } = input;
  const uploadedAt = pastTimestamp(entry?.fingerprintAt, now);
  const since =
    input.since === undefined || uploadedAt === undefined
      ? input.since
      : earliestDateKey(input.since, localDateKey(new Date(uploadedAt)));
  const knownSessions = entry?.sessions ?? null;

  if (input.full) {
    return { knownSessions, mode: "run", sessions: "full", since };
  }

  if (
    input.fingerprint !== null &&
    uploadedAt !== undefined &&
    entry?.fingerprint === input.fingerprint.digest
  ) {
    return { mode: "skip", reason: "unchanged" };
  }

  const lastRunAt = pastTimestamp(entry?.lastRunAt, now);
  if (
    lastRunAt !== undefined &&
    entry?.lastRunMs !== undefined &&
    now.getTime() - lastRunAt < entry.lastRunMs * COOLDOWN_FACTOR
  ) {
    return { mode: "skip", reason: "cooldown" };
  }

  return { knownSessions, mode: "run", sessions: "reuse", since };
}

function planSourceRuns(
  state: SourceCadenceState | null,
  input: {
    fingerprints: SourceFingerprints;
    full: boolean;
    now: Date;
    since: string | undefined;
    sources: readonly UsageSource[];
  },
): SyncSourcePlans {
  const plans: SyncSourcePlans = {};
  for (const source of input.sources) {
    plans[source] = planSourceRun({
      entry: state?.sources[source],
      fingerprint: input.fingerprints[source] ?? null,
      full: input.full,
      now: input.now,
      since: input.since,
    });
  }

  return plans;
}

/**
 * Folds a finished sync into the cadence state. Only call it once the sync's
 * upload succeeded: a source's fingerprint advances only when its daily
 * report ran (or had no data) in that run, so a failed source is retried.
 */
function nextSourceCadenceState(
  state: SourceCadenceState | null,
  input: NextSourceCadenceStateInput,
): SourceCadenceState {
  const plannedAt = input.plannedAt.toISOString();
  const sources: Record<string, SourceCadenceEntry> = { ...state?.sources };

  for (const result of input.result.sourceResults) {
    const plan = input.plans[result.source];
    if (plan?.mode === "skip") {
      // Unchanged logs were just verified against the last upload, so the
      // server is current as of now; a later change only needs days from here.
      if (plan.reason === "unchanged") {
        sources[result.source] = { ...sources[result.source], fingerprintAt: plannedAt };
      }
      continue;
    }

    const entry: { -readonly [Key in keyof SourceCadenceEntry]: SourceCadenceEntry[Key] } = {
      ...sources[result.source],
    };
    const timings = input.result.timings?.[result.source];
    if (timings?.dailyMs !== undefined) {
      entry.lastRunAt = plannedAt;
      entry.lastRunMs = timings.dailyMs + (timings.sessionMs ?? 0);
    }

    if (result.status !== "failed") {
      const fingerprint = input.fingerprints[result.source] ?? null;
      entry.fingerprintAt = plannedAt;
      if (fingerprint === null) {
        delete entry.fingerprint;
      } else {
        entry.fingerprint = fingerprint.digest;
      }

      const sessions = result.summary?.sessions ?? null;
      if (plan?.mode === "run" && plan.sessions === "full" && sessions !== null) {
        entry.sessions = sessions;
        entry.sessionsAt = plannedAt;
      }
    }

    sources[result.source] = entry;
  }

  return { cliVersion: input.cliVersion, sources, timeZone: input.timeZone, version: 1 };
}

/**
 * Reads the cadence state and fingerprints each source's logs before any
 * ccusage run, so writes that land while a report runs count as changes on
 * the next tick instead of being attributed to this upload.
 */
function prepareSourceCadence(input: PrepareSourceCadenceInput): Effect.Effect<SourceCadence> {
  return Effect.gen(function* () {
    const state = yield* readSourceCadenceState(input.path);
    const timeZone = currentTimeZone();
    const full =
      input.full || sourceCadenceFullRun(state, { cliVersion: input.cliVersion, timeZone });
    const plannedAt = new Date();
    const fingerprints = yield* fingerprintSources(input.sources, input.roots);
    const plans = planSourceRuns(state, {
      fingerprints,
      full,
      now: plannedAt,
      since: input.since,
      sources: input.sources,
    });

    return {
      commit: (result) =>
        writeSourceCadenceState(
          input.path,
          nextSourceCadenceState(state, {
            cliVersion: input.cliVersion,
            fingerprints,
            plannedAt,
            plans,
            result,
            timeZone,
          }),
        ).pipe(Effect.ignore),
      full,
      plans,
    };
  });
}

function fingerprintSources(
  sources: readonly UsageSource[],
  options: LogRootOptions = {},
): Effect.Effect<SourceFingerprints> {
  return Effect.promise(async () => {
    const fingerprints: SourceFingerprints = {};
    for (const source of sources) {
      // An unreadable root only costs the skip, never the sync.
      fingerprints[source] = await fingerprintSource(source, options).catch(() => null);
    }

    return fingerprints;
  });
}

function readSourceCadenceState(path: string): Effect.Effect<SourceCadenceState | null> {
  return Effect.promise(() => readFile(path, "utf8").catch(() => null)).pipe(
    Effect.map((text) => {
      if (text === null) {
        return null;
      }

      try {
        return Option.getOrNull(decodeSourceCadenceState(JSON.parse(text)));
      } catch {
        return null;
      }
    }),
  );
}

function writeSourceCadenceState(
  path: string,
  state: SourceCadenceState,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
        await rename(temporaryPath, path);
      } catch (cause) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw cause;
      }
    },
    catch: (cause) => cause,
  });
}

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A parseable timestamp that is not in the future (the clock may have moved back). */
function pastTimestamp(value: string | undefined, now: Date): number | undefined {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(time) || time > now.getTime() ? undefined : time;
}

function earliestDateKey(first: string, second: string): string {
  return first < second ? first : second;
}

/** ccusage buckets days in local time. */
function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export {
  COOLDOWN_FACTOR,
  currentTimeZone,
  fingerprintSources,
  nextSourceCadenceState,
  planSourceRun,
  planSourceRuns,
  prepareSourceCadence,
  readSourceCadenceState,
  SOURCE_CADENCE_FILE_NAME,
  sourceCadenceFullRun,
  writeSourceCadenceState,
};

export type {
  SourceCadence,
  SourceCadenceEntry,
  SourceCadenceState,
  SourceFingerprints,
  SyncSourcePlan,
  SyncSourcePlans,
};
