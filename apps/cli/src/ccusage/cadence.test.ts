import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { SyncResult, SyncSourceResult } from "../commands/sync";
import {
  COOLDOWN_FACTOR,
  currentTimeZone,
  nextSourceCadenceState,
  planSourceRun,
  prepareSourceCadence,
  readSourceCadenceState,
  sourceCadenceFullRun,
  type SourceCadenceState,
  type SyncSourcePlans,
  writeSourceCadenceState,
} from "./cadence";
import type { SourceFingerprint } from "./fingerprint";

const now = new Date(2026, 8, 25, 12, 0, 0);
const fingerprint = (digest: string): SourceFingerprint => ({ bytes: 1, digest, files: 1 });
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
const summary = (sessions: number | null) => ({
  days: 1,
  models: 1,
  rows: 1,
  sessions,
  spendUsd: 1,
});

function syncResult(
  sourceResults: SyncSourceResult[],
  timings: SyncResult["timings"] = {},
): Pick<SyncResult, "sourceResults" | "timings"> {
  return { sourceResults, timings };
}

describe("planSourceRun", () => {
  it("skips a source whose logs are unchanged since its last upload", () => {
    expect(
      planSourceRun({
        entry: { fingerprint: "abc", fingerprintAt: hoursAgo(1) },
        fingerprint: fingerprint("abc"),
        full: false,
        now,
        since: "2026-09-25",
      }),
    ).toEqual({ mode: "skip", reason: "unchanged" });
  });

  it("re-runs a changed source from the day of its last upload, reusing session counts", () => {
    expect(
      planSourceRun({
        entry: { fingerprint: "abc", fingerprintAt: "2026-09-22T10:00:00", sessions: 12 },
        fingerprint: fingerprint("def"),
        full: false,
        now,
        since: "2026-09-25",
      }),
    ).toEqual({ knownSessions: 12, mode: "run", sessions: "reuse", since: "2026-09-22" });
  });

  it("keeps the scheduled window when it already reaches further back", () => {
    expect(
      planSourceRun({
        entry: { fingerprint: "abc", fingerprintAt: hoursAgo(1) },
        fingerprint: fingerprint("def"),
        full: false,
        now,
        since: "2026-09-05",
      }),
    ).toMatchObject({ mode: "run", since: "2026-09-05" });
  });

  it("runs a source it has never uploaded with the scheduled window", () => {
    expect(
      planSourceRun({
        entry: undefined,
        fingerprint: fingerprint("abc"),
        full: false,
        now,
        since: "2026-09-25",
      }),
    ).toEqual({ knownSessions: null, mode: "run", sessions: "reuse", since: "2026-09-25" });
  });

  it("always runs a source whose logs cannot be fingerprinted", () => {
    expect(
      planSourceRun({
        entry: { fingerprintAt: hoursAgo(1) },
        fingerprint: null,
        full: false,
        now,
        since: "2026-09-25",
      }),
    ).toMatchObject({ mode: "run" });
  });

  it("distrusts an upload recorded in the future after the clock moved back", () => {
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(
      planSourceRun({
        entry: { fingerprint: "abc", fingerprintAt: future, lastRunAt: future, lastRunMs: 60_000 },
        fingerprint: fingerprint("abc"),
        full: false,
        now,
        since: "2026-09-25",
      }),
    ).toEqual({ knownSessions: null, mode: "run", sessions: "reuse", since: "2026-09-25" });
  });

  it("cools a slow source down in proportion to its last run", () => {
    const lastRunMs = 120_000;
    const entry = {
      fingerprint: "abc",
      fingerprintAt: hoursAgo(1),
      lastRunAt: new Date(now.getTime() - lastRunMs * COOLDOWN_FACTOR + 1).toISOString(),
      lastRunMs,
    };
    const input = { entry, fingerprint: fingerprint("def"), full: false, since: "2026-09-25" };

    expect(planSourceRun({ ...input, now })).toEqual({ mode: "skip", reason: "cooldown" });
    expect(planSourceRun({ ...input, now: new Date(now.getTime() + 1) })).toMatchObject({
      mode: "run",
    });
  });

  it("does not hold back a fast source between five-minute ticks", () => {
    expect(
      planSourceRun({
        entry: {
          fingerprint: "abc",
          fingerprintAt: hoursAgo(1),
          lastRunAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
          lastRunMs: 2_000,
        },
        fingerprint: fingerprint("def"),
        full: false,
        now,
        since: "2026-09-25",
      }),
    ).toMatchObject({ mode: "run" });
  });

  it("never skips on a full run and refreshes the uploaded session count", () => {
    const entry = {
      fingerprint: "abc",
      fingerprintAt: hoursAgo(1),
      lastRunAt: hoursAgo(0),
      lastRunMs: 170_000,
      sessions: 3,
    };

    expect(
      planSourceRun({
        entry,
        fingerprint: fingerprint("abc"),
        full: true,
        now,
        since: "2026-09-05",
      }),
    ).toEqual({ knownSessions: 3, mode: "run", sessions: "full", since: "2026-09-05" });
    expect(
      planSourceRun({ entry, fingerprint: fingerprint("abc"), full: true, now, since: undefined }),
    ).toMatchObject({ since: undefined });
  });
});

describe("sourceCadenceFullRun", () => {
  const state: SourceCadenceState = {
    cliVersion: "0.7.0",
    sources: {},
    timeZone: "Europe/Bucharest",
    version: 1,
  };

  it("runs everything the first time, after an upgrade, and after a time zone change", () => {
    const current = { cliVersion: "0.7.0", timeZone: "Europe/Bucharest" };

    expect(sourceCadenceFullRun(null, current)).toBe(true);
    expect(sourceCadenceFullRun(state, current)).toBe(false);
    expect(sourceCadenceFullRun(state, { ...current, cliVersion: "0.8.0" })).toBe(true);
    expect(sourceCadenceFullRun(state, { ...current, timeZone: "America/New_York" })).toBe(true);
  });
});

describe("nextSourceCadenceState", () => {
  const plannedAt = new Date("2026-09-25T09:00:00.000Z");
  const previous: SourceCadenceState = {
    cliVersion: "0.7.0",
    sources: {
      claude: { fingerprint: "claude-old", fingerprintAt: "2026-09-24T09:00:00.000Z" },
      codex: {
        fingerprint: "codex-old",
        fingerprintAt: "2026-09-24T09:00:00.000Z",
        sessions: 40,
        sessionsAt: "2026-09-24T09:00:00.000Z",
      },
      gemini: { fingerprint: "gemini-old", fingerprintAt: "2026-09-24T09:00:00.000Z" },
    },
    timeZone: "UTC",
    version: 1,
  };
  const commit = (plans: SyncSourcePlans, result: Pick<SyncResult, "sourceResults" | "timings">) =>
    nextSourceCadenceState(previous, {
      cliVersion: "0.8.0",
      fingerprints: {
        claude: fingerprint("claude-new"),
        codex: fingerprint("codex-new"),
        gemini: fingerprint("gemini-new"),
        pi: null,
      },
      plannedAt,
      plans,
      result,
      timeZone: "Europe/Bucharest",
    });
  const reuse = { knownSessions: 40, mode: "run", sessions: "reuse", since: "2026-09-25" } as const;

  it("advances a synced source to the fingerprint taken before its reports ran", () => {
    const next = commit(
      { codex: reuse },
      syncResult([{ source: "codex", status: "synced", summary: summary(40) }], {
        codex: { dailyMs: 1_500 },
      }),
    );

    expect(next).toMatchObject({ cliVersion: "0.8.0", timeZone: "Europe/Bucharest", version: 1 });
    expect(next.sources.codex).toEqual({
      fingerprint: "codex-new",
      fingerprintAt: plannedAt.toISOString(),
      lastRunAt: plannedAt.toISOString(),
      lastRunMs: 1_500,
      sessions: 40,
      sessionsAt: "2026-09-24T09:00:00.000Z",
    });
  });

  it("keeps a failed source's fingerprint so the next tick retries it, but records its cost", () => {
    const next = commit(
      { codex: reuse },
      syncResult(
        [
          {
            issue: { code: "command_timed_out", message: "timed out", report: "daily" },
            source: "codex",
            status: "failed",
            summary: null,
          },
        ],
        { codex: { dailyMs: 180_000 } },
      ),
    );

    expect(next.sources.codex).toMatchObject({
      fingerprint: "codex-old",
      fingerprintAt: "2026-09-24T09:00:00.000Z",
      lastRunAt: plannedAt.toISOString(),
      lastRunMs: 180_000,
    });
  });

  it("records unchanged sources as current and empty ones as uploaded", () => {
    const next = commit(
      {
        claude: { mode: "skip", reason: "unchanged" },
        codex: { mode: "skip", reason: "cooldown" },
        gemini: { ...reuse, knownSessions: null },
        pi: { ...reuse, knownSessions: null },
      },
      syncResult([
        { reason: "unchanged", source: "claude", status: "skipped", summary: null },
        { reason: "cooldown", source: "codex", status: "skipped", summary: null },
        { reason: "no_data", source: "gemini", status: "skipped", summary: null },
        { reason: "no_data", source: "pi", status: "skipped", summary: null },
      ]),
    );

    expect(next.sources.claude).toEqual({
      fingerprint: "claude-old",
      fingerprintAt: plannedAt.toISOString(),
    });
    // A cooling-down source still has pending changes from its last upload.
    expect(next.sources.codex).toEqual(previous.sources.codex);
    expect(next.sources.gemini).toEqual({
      fingerprint: "gemini-new",
      fingerprintAt: plannedAt.toISOString(),
    });
    expect(next.sources.pi).toEqual({ fingerprintAt: plannedAt.toISOString() });
  });

  it("stores session counts only from a full-history session report", () => {
    const full = { ...reuse, sessions: "full" } as const;
    const partial: SyncSourceResult = {
      issue: { code: "command_failed", message: "failed", report: "session" },
      source: "codex",
      status: "partial",
      summary: summary(null),
    };

    expect(
      commit(
        { codex: full },
        syncResult([{ source: "codex", status: "synced", summary: summary(55) }], {
          codex: { dailyMs: 1_000, sessionMs: 2_000 },
        }),
      ).sources.codex,
    ).toMatchObject({ lastRunMs: 3_000, sessions: 55, sessionsAt: plannedAt.toISOString() });
    expect(commit({ codex: full }, syncResult([partial])).sources.codex).toMatchObject({
      fingerprint: "codex-new",
      sessions: 40,
    });
    expect(
      commit(
        { codex: { ...reuse, sessions: "window" } },
        syncResult([{ source: "codex", status: "synced", summary: summary(2) }]),
      ).sources.codex,
    ).toMatchObject({ sessions: 40 });
  });
});

describe("source cadence state file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tokenmaxxing-cadence-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("round-trips through an atomic write and ignores unreadable state", async () => {
    const path = join(root, "config", "service-sources.json");
    const state: SourceCadenceState = {
      cliVersion: "0.8.0",
      sources: { codex: { fingerprint: "abc", fingerprintAt: "2026-09-25T09:00:00.000Z" } },
      timeZone: "UTC",
      version: 1,
    };

    expect(await Effect.runPromise(readSourceCadenceState(path))).toBeNull();
    await Effect.runPromise(writeSourceCadenceState(path, state));
    expect(await Effect.runPromise(readSourceCadenceState(path))).toEqual(state);

    await writeFile(path, "{not json");
    expect(await Effect.runPromise(readSourceCadenceState(path))).toBeNull();
    await writeFile(
      path,
      JSON.stringify({ sources: { codex: { lastRunMs: "slow" } }, version: 1 }),
    );
    expect(await Effect.runPromise(readSourceCadenceState(path))).toBeNull();
  });

  it("runs everything first, then only the sources whose logs changed", async () => {
    const home = join(root, "home");
    const rollout = join(home, ".codex", "sessions", "2026", "09", "25", "rollout-a.jsonl");
    await mkdir(dirname(rollout), { recursive: true });
    await writeFile(rollout, "{}\n");
    const path = join(root, "service-sources.json");
    const prepare = (full = false) =>
      Effect.runPromise(
        prepareSourceCadence({
          cliVersion: "0.8.0",
          full,
          path,
          roots: { cwd: root, env: {}, home },
          since: "2026-09-25",
          sources: ["claude", "codex"],
        }),
      );
    const synced = (source: "claude" | "codex"): SyncSourceResult =>
      source === "codex"
        ? { source, status: "synced", summary: summary(1) }
        : { reason: "no_data", source, status: "skipped", summary: null };

    const first = await prepare();
    expect(first.full).toBe(true);
    expect(first.plans.codex).toMatchObject({ mode: "run", sessions: "full" });
    await Effect.runPromise(
      first.commit(
        // Instant runs, so the cooldown never holds the changed source back.
        syncResult([synced("claude"), synced("codex")], {
          claude: { dailyMs: 0 },
          codex: { dailyMs: 0, sessionMs: 0 },
        }),
      ),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      cliVersion: "0.8.0",
      sources: { codex: { sessions: 1 } },
      timeZone: currentTimeZone(),
    });

    const idle = await prepare();
    expect(idle.full).toBe(false);
    expect(idle.plans).toEqual({
      claude: { mode: "skip", reason: "unchanged" },
      codex: { mode: "skip", reason: "unchanged" },
    });

    await appendFile(rollout, '{"type":"event_msg"}\n');
    const active = await prepare();
    expect(active.plans).toMatchObject({
      claude: { mode: "skip", reason: "unchanged" },
      codex: { knownSessions: 1, mode: "run", sessions: "reuse" },
    });

    // An uncommitted run (upload failed) leaves the change pending.
    expect((await prepare()).plans.codex).toMatchObject({ mode: "run" });
    expect((await prepare(true)).plans.claude).toMatchObject({ mode: "run", sessions: "full" });
  });
});
