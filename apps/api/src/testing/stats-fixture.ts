import type { DatabaseSync } from "node:sqlite";

import { shiftDayKey } from "@tokenmaxxing/api-contract";

/**
 * A seeded `usage_days` fixture shaped like production, for comparing and
 * timing /stats computations. What it reproduces, at any scale:
 *
 * - Rows grow steeply towards `today`, with a thin tail back two years and a
 *   few future-dated rows past the ingest ceiling.
 * - A few users and models hold most rows; most models are a long tail.
 * - Models repeat across sources, and users across devices.
 * - Shadow-banned users, including one "whale" whose fabricated one-off model
 *   ids make up half the table (as in production), all inside two months.
 * - A device whose rows belong to two users, one of them banned.
 * - Costs are arbitrary doubles (so float sums are order-sensitive), some
 *   zero; token counts are integers up to the ingest caps' order of magnitude.
 *
 * The same `seed` always yields the same rows.
 */

interface StatsFixtureOptions {
  seed: number;
  /** YYYY-MM-DD the fixture treats as the current UTC day. */
  today: string;
  users: number;
  /** Rows spread over every user but the whale. */
  rows: number;
  /** Rows of the shadow-banned whale. */
  whaleRows: number;
}

interface StatsFixtureSummary {
  rows: number;
  users: number;
  bannedUsers: number;
  devices: number;
}

/** Production row share per source, most used first. */
const SOURCE_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ["claude", 64_000],
  ["codex", 66_000],
  ["opencode", 22_000],
  ["pi", 5_400],
  ["antigravity", 4_400],
  ["hermes", 2_700],
  ["gemini", 1_900],
  ["omp", 1_400],
  ["cursor", 820],
  ["copilot", 740],
  ["claude-code", 610],
  ["grok", 570],
  ["zcode", 440],
  ["kilo", 380],
  ["claude-web", 320],
  ["newapi", 170],
  ["kimi", 160],
  ["cursor-reconstructed", 130],
  ["amp", 130],
  ["droid", 98],
  ["openclaw", 73],
  ["litellm", 69],
  ["qwen", 18],
  ["goose", 11],
  ["pi-agent", 5],
  ["copilot-reconstructed", 3],
];

/** Model ids several sources report, so a model's users span sources. */
const SHARED_MODELS = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "gpt-6",
  "gpt-6-codex",
  "gemini-4-pro",
];

const DAYS_BACK = 700;
const DAYS_AHEAD = 3;

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Picks an index with probability proportional to its weight. */
function makeWeightedPicker(weights: readonly number[], random: () => number): () => number {
  const cumulative: number[] = [];
  let sum = 0;
  for (const weight of weights) {
    sum += weight;
    cumulative.push(sum);
  }

  return () => {
    const target = random() * sum;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cumulative[middle]! > target) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  };
}

function seedStatsFixture(sqlite: DatabaseSync, options: StatsFixtureOptions): StatsFixtureSummary {
  const random = makeRandom(options.seed);
  const pickInt = (limit: number) => Math.floor(random() * limit);

  // Oldest first; the weight grows ~150x from the first day to today.
  const days: string[] = [];
  for (let offset = -DAYS_BACK; offset <= DAYS_AHEAD; offset += 1) {
    days.push(shiftDayKey(options.today, offset));
  }
  const pickDay = makeWeightedPicker(
    days.map((_, index) => Math.exp((5 * index) / DAYS_BACK)),
    random,
  );

  const insertUser = sqlite.prepare(
    `insert into users (id, login, name, avatar_url, shadow_banned_at, shadow_banned_by_user_id,
      created_at, updated_at) values (?, ?, null, null, ?, null, 0, 0)`,
  );
  const insertDevice = sqlite.prepare(
    "insert into devices (id, user_id, name, platform, created_at) values (?, ?, ?, 'darwin', 0)",
  );
  const insertUsage = sqlite.prepare(
    `insert or ignore into usage_days (
      device_id, user_id, date, source, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, counted_by, synced_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0)`,
  );

  let inserted = 0;
  const usageRow = (
    userId: string,
    deviceId: string,
    date: string,
    source: string,
    model: string,
  ) => {
    const inputTokens = Math.floor(10 ** (2 + random() * 6));
    const outputTokens = Math.floor(10 ** (1 + random() * 5));
    const cacheCreationTokens = random() < 0.4 ? 0 : Math.floor(10 ** (2 + random() * 6));
    // A few rows near the ingest cap, so sums reach production magnitudes.
    const cacheReadTokens =
      random() < 0.002 ? Math.floor(random() * 4e11) : Math.floor(10 ** (3 + random() * 7));
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const costUsd = random() < 0.03 ? 0 : totalTokens * random() * 3.1e-6;
    inserted += Number(
      insertUsage.run(
        deviceId,
        userId,
        date,
        source,
        model,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens,
        costUsd,
      ).changes,
    );
  };

  sqlite.exec("begin");

  // Users: about one in forty is banned, about one in four never uploads.
  interface FixtureUser {
    banned: boolean;
    devices: string[];
    id: string;
    sources: number[];
  }
  const pickSource = makeWeightedPicker(
    SOURCE_WEIGHTS.map(([, weight]) => weight),
    random,
  );
  const users: FixtureUser[] = [];
  let devices = 0;
  for (let index = 0; index < options.users; index += 1) {
    const id = `user-${String(index).padStart(5, "0")}`;
    const banned = index % 40 === 7;
    insertUser.run(id, id, banned ? 1 : null);
    const user: FixtureUser = { banned, devices: [], id, sources: [] };
    for (let device = 0; device <= (pickInt(3) % 2) + (random() < 0.1 ? 1 : 0); device += 1) {
      const deviceId = `${id}-device-${device}`;
      insertDevice.run(deviceId, id, deviceId);
      user.devices.push(deviceId);
      devices += 1;
    }
    for (let source = 0; source <= pickInt(3); source += 1) {
      user.sources.push(pickSource());
    }
    users.push(user);
  }
  // A device that changed hands: its older rows still carry the banned owner.
  const [firstBanned] = users.filter((user) => user.banned);
  const [firstVisible] = users.filter((user) => !user.banned);
  if (firstBanned !== undefined && firstVisible !== undefined) {
    firstVisible.devices.push(firstBanned.devices[0]!);
  }

  const active = users.filter((_, index) => index % 4 !== 3);
  const pickUser = makeWeightedPicker(
    active.map((_, rank) => 1 / (rank + 1) ** 0.9),
    random,
  );
  // Each source has its own popular models, the shared ones and a long tail.
  const pickModelRank = makeWeightedPicker(
    Array.from({ length: 60 }, (_, rank) => 1 / (rank + 1) ** 1.3),
    random,
  );
  const modelFor = (source: string) => {
    const roll = random();
    if (roll < 0.25) {
      return SHARED_MODELS[pickInt(SHARED_MODELS.length)]!;
    }
    if (roll < 0.97) {
      return `${source}-model-${pickModelRank()}`;
    }
    return `${source}-tail-${pickInt(Math.max(50, options.rows / 200))}`;
  };

  for (let index = 0; index < options.rows; index += 1) {
    const user = active[pickUser()]!;
    const source = SOURCE_WEIGHTS[user.sources[pickInt(user.sources.length)]!]![0];
    usageRow(
      user.id,
      user.devices[pickInt(user.devices.length)]!,
      days[pickDay()]!,
      source,
      modelFor(source),
    );
  }

  // The whale: two rows per fabricated model id, 20 to 80 days back.
  if (options.whaleRows > 0) {
    const whale = "user-whale";
    insertUser.run(whale, whale, 1);
    insertDevice.run("whale-device", whale, "whale-device");
    devices += 1;
    for (let index = 0; index < options.whaleRows; index += 1) {
      usageRow(
        whale,
        "whale-device",
        shiftDayKey(options.today, -20 - pickInt(60)),
        "claude",
        `fabricated-${Math.floor(index / 2)}-${pickInt(1e9).toString(36)}`,
      );
    }
  }

  sqlite.exec("commit");

  return {
    bannedUsers: users.filter((user) => user.banned).length + (options.whaleRows > 0 ? 1 : 0),
    devices,
    rows: inserted,
    users: users.length + (options.whaleRows > 0 ? 1 : 0),
  };
}

export { seedStatsFixture };

export type { StatsFixtureOptions, StatsFixtureSummary };
