#!/usr/bin/env bun

/**
 * Benchmarks what a scheduled sync costs on a large Codex corpus (#69).
 *
 * Generates a synthetic CODEX_HOME in a temp directory (never reads real
 * agent logs), times each ccusage report the service can issue, then times
 * whole scheduled runs (dry runs, one child process each) the way main runs
 * them and through the per-source cadence:
 *
 *   bun script/bench-ccusage-cadence.ts [--scale 1] [--runs 3] [--ccusage <spec>] [--keep]
 *
 * --scale 1 writes ~5.7 GiB: 60 days of history (3 x 24 MB rollouts/day), a
 * long-running rollout started 3 days ago that is still being appended, and
 * two 600 MB rollouts today. The reporter in #69 had 83 GB total and 4.8 GB
 * today; parse cost tracks the bytes a report has to read. `--ccusage` pins
 * the release for the per-report table only.
 */

import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import packageJson from "../package.json";
import { prepareSourceCadence } from "../src/ccusage/cadence";
import { ccusageCommandInvocations } from "../src/ccusage/runner";
import { DEFAULT_SOURCE_NAMES } from "../src/ccusage/sources";
import { syncProgram, type SyncResult } from "../src/commands/sync";
import { CliServicesLive } from "../src/services";

interface BenchOptions {
  ccusage: string | undefined;
  keep: boolean;
  runs: number;
  scale: number;
}

interface Measurement {
  cpuMs: number;
  detail?: string | undefined;
  label: string;
  maxRssMiB: number;
  wallMs: number;
}

const MiB = 1024 * 1024;
const HISTORY_DAYS = 60;
const HISTORY_FILES_PER_DAY = 3;
const HISTORY_FILE_MB = 24;
const LONG_RUNNING_FILE_MB = 300;
const TODAY_FILES = 2;
const TODAY_FILE_MB = 600;
const RECONCILE_WINDOW_DAYS = 21;

function parseOptions(argv: readonly string[]): BenchOptions {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const scale = Number(value("--scale") ?? "1");
  const runs = Number(value("--runs") ?? "3");
  if (!(scale > 0) || !Number.isInteger(runs) || runs < 1) {
    throw new Error("usage: bench-ccusage-cadence.ts [--scale <n>] [--runs <n>] [--keep]");
  }

  return { ccusage: value("--ccusage"), keep: argv.includes("--keep"), runs, scale };
}

function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function localDay(offsetDays: number, hour = 0, minute = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, hour, minute);
}

/**
 * Writes one rollout in the shape Codex records: a session_meta header,
 * turn contexts, bulky response items (tool output dominates real files), and
 * cumulative token_count events. Turns are spread from `start` to `end`.
 */
async function writeRollout(path: string, targetBytes: number, start: Date, end: Date) {
  const handle = await open(path, "w");
  const filler = "x".repeat(7_900);
  const approxTurnBytes = filler.length + 900;
  const turns = Math.max(1, Math.floor(targetBytes / approxTurnBytes));
  const span = Math.max(1, end.getTime() - start.getTime());
  const chunks: string[] = [];
  let pending = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoning = 0;
  const flush = async () => {
    await handle.write(chunks.join(""));
    chunks.length = 0;
    pending = 0;
  };

  chunks.push(
    `${JSON.stringify({
      payload: { cli_version: "0.50.0", cwd: "/tmp/bench", id: crypto.randomUUID() },
      timestamp: start.toISOString(),
      type: "session_meta",
    })}\n`,
  );
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(start.getTime() + Math.floor((span * turn) / turns)).toISOString();
    const last = {
      cached_input_tokens: 9_000,
      input_tokens: 12_000,
      output_tokens: 400,
      reasoning_output_tokens: 150,
      total_tokens: 12_400,
    };
    input += last.input_tokens;
    cached += last.cached_input_tokens;
    output += last.output_tokens;
    reasoning += last.reasoning_output_tokens;
    const lines = [
      { payload: { model: "gpt-5.2-codex" }, timestamp, type: "turn_context" },
      {
        payload: { call_id: `call_${turn}`, output: filler, type: "function_call_output" },
        timestamp,
        type: "response_item",
      },
      {
        payload: {
          info: {
            last_token_usage: last,
            model: "gpt-5.2-codex",
            total_token_usage: {
              cached_input_tokens: cached,
              input_tokens: input,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: input + output,
            },
          },
          type: "token_count",
        },
        timestamp,
        type: "event_msg",
      },
    ];
    for (const line of lines) {
      const text = `${JSON.stringify(line)}\n`;
      chunks.push(text);
      pending += text.length;
    }
    if (pending >= 8 * MiB) {
      await flush();
    }
  }
  await flush();
  await handle.close();
  await utimes(path, end, end);
}

async function writeCorpus(codexHome: string, scale: number) {
  const sessions = join(codexHome, "sessions");
  let files = 0;
  let bytes = 0;
  const rollout = async (day: Date, index: number, mb: number, start: Date, end: Date) => {
    const [year, month, date] = dateKey(day).split("-");
    const dir = join(sessions, year!, month!, date!);
    await mkdir(dir, { recursive: true });
    const size = Math.round(mb * scale * MiB);
    await writeRollout(join(dir, `rollout-${dateKey(day)}-${index}.jsonl`), size, start, end);
    files += 1;
    bytes += size;
  };

  for (let offset = -HISTORY_DAYS; offset < 0; offset += 1) {
    for (let index = 0; index < HISTORY_FILES_PER_DAY; index += 1) {
      await rollout(
        localDay(offset),
        index,
        HISTORY_FILE_MB,
        localDay(offset, 9 + index * 3),
        localDay(offset, 11 + index * 3),
      );
    }
  }
  // Started three days ago and still being appended: lives in an old date
  // directory but its mtime (and newest entries) are today.
  const now = new Date();
  await rollout(localDay(-3), 9, LONG_RUNNING_FILE_MB, localDay(-3, 10), now);
  for (let index = 0; index < TODAY_FILES; index += 1) {
    await rollout(localDay(0), index, TODAY_FILE_MB, localDay(0, 0, 5 + index), now);
  }

  return { bytes, files };
}

async function measure(
  label: string,
  argv: string[],
  env: Record<string, string>,
  runs: number,
  before?: () => Promise<void>,
) {
  const samples: Measurement[] = [];
  for (let run = 0; run < runs; run += 1) {
    await before?.();
    const started = performance.now();
    const child = Bun.spawn(argv, {
      env: { ...process.env, ...env },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const wallMs = performance.now() - started;
    if (exitCode !== 0) {
      throw new Error(`${label} exited ${exitCode}: ${stderr}`);
    }
    // Resource usage covers waited-for descendants too (bun x -> ccusage).
    const usage = child.resourceUsage();
    samples.push({
      cpuMs: usage === undefined ? Number.NaN : cpuMs(usage),
      detail: stdout.trim(),
      label,
      maxRssMiB: usage === undefined ? Number.NaN : usage.maxRSS / 1024 / (isDarwin() ? 1024 : 1),
      wallMs,
    });
  }

  return median(samples);
}

function ccusageArgv(args: string[], pin: string | undefined): string[] {
  const [invocation] = ccusageCommandInvocations(args);
  if (pin !== undefined) {
    // Pin a specific release instead of the runner's semver range.
    invocation.args[1] = `ccusage@${pin}`;
  }

  return [invocation.command, ...invocation.args];
}

function cpuMs(usage: NonNullable<ReturnType<Bun.Subprocess["resourceUsage"]>>): number {
  return Number(usage.cpuTime.user + usage.cpuTime.system) / 1000;
}

function isDarwin() {
  return process.platform === "darwin";
}

function median(samples: Measurement[]): Measurement {
  const pick = (key: "cpuMs" | "maxRssMiB" | "wallMs") =>
    samples.map((sample) => sample[key]).sort((left, right) => left - right)[
      Math.floor(samples.length / 2)
    ]!;

  return {
    cpuMs: pick("cpuMs"),
    detail: samples[0]!.detail,
    label: samples[0]!.label,
    maxRssMiB: pick("maxRssMiB"),
    wallMs: pick("wallMs"),
  };
}

function formatRow(measurement: Measurement) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  return `| ${measurement.label} | ${seconds(measurement.wallMs)} | ${seconds(measurement.cpuMs)} | ${Math.round(measurement.maxRssMiB)} MiB |`;
}

type TickKind = "after-reconcile" | "after-tick" | "before-reconcile" | "before-tick";

/**
 * One scheduled run in a child process, so its resource usage includes every
 * ccusage it spawns. `before-*` is the service on main (no plans: every
 * source runs daily + session); `after-*` goes through the cadence planner.
 * Dry runs: nothing is uploaded, and the cadence state commits as if it was.
 */
async function runTick(kind: TickKind, root: string) {
  const reconcile = kind.endsWith("reconcile");
  const since = dateKey(reconcile ? localDay(-(RECONCILE_WINDOW_DAYS - 1)) : new Date());
  const program = Effect.gen(function* () {
    if (kind.startsWith("before")) {
      const result: SyncResult = yield* syncProgram({
        dryRun: true,
        json: true,
        silent: true,
        since,
      });
      return { planMs: undefined, result };
    }

    const fingerprintStarted = performance.now();
    const cadence = yield* prepareSourceCadence({
      cliVersion: packageJson.version,
      full: reconcile,
      path: join(root, "service-sources.json"),
      since,
      sources: DEFAULT_SOURCE_NAMES,
    });
    const planMs = performance.now() - fingerprintStarted;
    const result = yield* syncProgram({
      dryRun: true,
      json: true,
      silent: true,
      since,
      sourcePlans: cadence.plans,
    });
    yield* cadence.commit(result);
    return { planMs, result };
  });
  const { planMs, result } = await Effect.runPromise(program.pipe(Effect.provide(CliServicesLive)));
  const runs = Object.values(result.timings ?? {}).flatMap((timings) => [
    ...(timings?.dailyMs === undefined ? [] : ["daily"]),
    ...(timings?.sessionMs === undefined ? [] : ["session"]),
  ]);
  const plan = planMs === undefined ? "" : `, plan+fingerprint ${Math.round(planMs)} ms`;
  console.log(`${runs.length} ccusage runs${plan}`);
}

/** Every source but Codex points at an empty directory, like a Codex-only user. */
async function sourceEnv(root: string, codexHome: string): Promise<Record<string, string>> {
  const empty = (name: string) => join(root, "empty", name);
  await mkdir(join(empty("claude"), "projects"), { recursive: true });
  for (const name of ["copilot", "gemini", "hermes", "opencode", "pi"]) {
    await mkdir(empty(name), { recursive: true });
  }

  return {
    CLAUDE_CONFIG_DIR: empty("claude"),
    CODEX_HOME: codexHome,
    COPILOT_HOME: empty("copilot"),
    COPILOT_OTEL_FILE_EXPORTER_PATH: "",
    GEMINI_DATA_DIR: empty("gemini"),
    HERMES_HOME: empty("hermes"),
    OPENCODE_DATA_DIR: empty("opencode"),
    PI_AGENT_DIR: empty("pi"),
  };
}

/** A new turn in today's rollout, as an active Codex session writes one. */
async function appendTurn(codexHome: string) {
  const [year, month, date] = dateKey(new Date()).split("-");
  const path = join(
    codexHome,
    "sessions",
    year!,
    month!,
    date!,
    `rollout-${dateKey(new Date())}-0.jsonl`,
  );
  const timestamp = new Date().toISOString();
  const usage = {
    cached_input_tokens: 9_000,
    input_tokens: 12_000,
    output_tokens: 400,
    reasoning_output_tokens: 150,
    total_tokens: 12_400,
  };
  await appendFile(
    path,
    `${JSON.stringify({
      payload: {
        info: { last_token_usage: usage, model: "gpt-5.2-codex", total_token_usage: usage },
        type: "token_count",
      },
      timestamp,
      type: "event_msg",
    })}\n`,
  );
}

/** Pretend the last runs were an hour ago: past any cooldown, as on a later tick. */
async function rewindCooldowns(root: string) {
  const path = join(root, "service-sources.json");
  const state = JSON.parse(await readFile(path, "utf8")) as {
    sources: Record<string, { lastRunAt?: string }>;
  };
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(state.sources)) {
    if (entry.lastRunAt !== undefined) {
      entry.lastRunAt = anHourAgo;
    }
  }
  await writeFile(path, JSON.stringify(state));
}

async function main() {
  const argv = process.argv.slice(2);
  const tickIndex = argv.indexOf("--tick");
  if (tickIndex !== -1) {
    await runTick(argv[tickIndex + 1] as TickKind, argv[argv.indexOf("--root") + 1]!);
    return;
  }

  const options = parseOptions(argv);
  const root = await mkdtemp(join(tmpdir(), "tokenmaxxing-bench-"));
  const codexHome = join(root, "codex");
  try {
    console.error(`writing synthetic corpus to ${codexHome}`);
    const corpus = await writeCorpus(codexHome, options.scale);
    console.error(`${corpus.files} files, ${(corpus.bytes / 1024 ** 3).toFixed(2)} GiB`);

    const env = await sourceEnv(root, codexHome);
    const today = dateKey(new Date()).replaceAll("-", "");
    const window = dateKey(localDay(-(RECONCILE_WINDOW_DAYS - 1))).replaceAll("-", "");
    const daily = ["codex", "daily", "--json", "--breakdown", "--mode", "calculate"];
    const session = ["codex", "session", "--json", "--mode", "calculate"];
    const commands: [string, string[]][] = [
      ["daily --since today", [...daily, "--since", today]],
      ["session --since today", [...session, "--since", today]],
      [`daily --since ${RECONCILE_WINDOW_DAYS}d`, [...daily, "--since", window]],
      [`session --since ${RECONCILE_WINDOW_DAYS}d`, [...session, "--since", window]],
      ["daily (full history)", daily],
      ["session (full history)", session],
    ];

    // Warm the page cache so every case measures parsing, not the first read.
    await measure("warmup", ccusageArgv(daily, options.ccusage), env, 1);
    const commandRows: Measurement[] = [];
    for (const [label, args] of commands) {
      const row = await measure(label, ccusageArgv(args, options.ccusage), env, options.runs);
      console.error(formatRow(row));
      commandRows.push(row);
    }

    const tick = (kind: TickKind) => [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--tick",
      kind,
      "--root",
      root,
    ];
    const tickRows: Measurement[] = [];
    const addTick = async (
      label: string,
      kind: TickKind,
      runs: number,
      before?: () => Promise<void>,
    ) => {
      const row = await measure(label, tick(kind), env, runs, before);
      console.error(formatRow(row));
      tickRows.push(row);
    };
    await addTick("main: scheduled tick", "before-tick", options.runs);
    await addTick("main: reconcile tick (every 6 h)", "before-reconcile", options.runs);
    await addTick("PR: first tick after upgrade", "after-tick", 1);
    await addTick("PR: idle tick (logs unchanged)", "after-tick", options.runs);
    await addTick("PR: active tick (a rollout grew)", "after-tick", options.runs, async () => {
      await appendTurn(codexHome);
      await rewindCooldowns(root);
    });
    await addTick("PR: reconcile tick (every 6 h)", "after-reconcile", options.runs);

    console.log(`corpus: ${corpus.files} files, ${(corpus.bytes / 1024 ** 3).toFixed(2)} GiB`);
    console.log("");
    console.log(`ccusage ${options.ccusage ?? "(runner range)"} on the Codex corpus:`);
    console.log("");
    console.log("| command | wall | cpu | max rss |");
    console.log("| --- | ---: | ---: | ---: |");
    for (const row of commandRows) {
      console.log(formatRow(row));
    }
    console.log("");
    console.log("Scheduled runs (7 sources, only Codex has logs; excludes jitter, auth, upload):");
    console.log("");
    console.log("| run | wall | cpu | max rss | work |");
    console.log("| --- | ---: | ---: | ---: | --- |");
    for (const row of tickRows) {
      console.log(`${formatRow(row)} ${row.detail ?? ""} |`);
    }
  } finally {
    if (options.keep) {
      console.error(`kept ${root}`);
    } else {
      await rm(root, { force: true, recursive: true });
    }
  }
}

await main();
