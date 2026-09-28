// Fake ccusage for the service e2e: `<source> <daily|session> [...flags]`.
// claude and codex report yesterday + today; every other source is empty.
// Daily reports sleep FAKE_CCUSAGE_SLEEP_MS (default 1500) so a scheduled run
// lasts a few seconds, long enough for the window watcher to see anything it
// opens.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [source, kind] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
appendFileSync(
  join(here, "calls.log"),
  `${new Date().toISOString()} node pid=${process.pid} ppid=${process.ppid} ${process.argv.slice(2).join(" ")}\n`,
);

function dayKey(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function claudeDay(date, inputTokens) {
  const breakdown = {
    cacheCreationTokens: 10,
    cacheReadTokens: 100,
    cost: inputTokens / 100_000,
    inputTokens,
    modelName: "claude-sonnet-4-5-20250929",
    outputTokens: Math.round(inputTokens / 2),
  };
  return {
    cacheCreationTokens: breakdown.cacheCreationTokens,
    cacheReadTokens: breakdown.cacheReadTokens,
    date,
    inputTokens: breakdown.inputTokens,
    modelBreakdowns: [breakdown],
    modelsUsed: [breakdown.modelName],
    outputTokens: breakdown.outputTokens,
    totalCost: breakdown.cost,
    totalTokens:
      breakdown.inputTokens +
      breakdown.outputTokens +
      breakdown.cacheCreationTokens +
      breakdown.cacheReadTokens,
  };
}

function codexDay(date, inputTokens) {
  const entry = {
    cacheReadTokens: 5,
    inputTokens,
    outputTokens: 7,
    totalTokens: inputTokens + 12,
  };
  return {
    costUSD: inputTokens / 200_000,
    date,
    models: { "gpt-5-codex": entry },
    totalTokens: entry.totalTokens,
  };
}

const reports = source === "claude" || source === "codex";
const sleepMs = Number(process.env.FAKE_CCUSAGE_SLEEP_MS ?? 1500);
if (kind === "daily" && reports && sleepMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
}

let output;
if (kind === "session") {
  output = { sessions: reports ? [{ sessionId: "e2e" }] : [] };
} else if (source === "claude") {
  output = { daily: [claudeDay(dayKey(-1), 1200), claudeDay(dayKey(0), 3400)] };
} else if (source === "codex") {
  output = { daily: [codexDay(dayKey(-1), 800), codexDay(dayKey(0), 900)] };
} else {
  output = { daily: [] };
}
process.stdout.write(`${JSON.stringify(output)}\n`);
