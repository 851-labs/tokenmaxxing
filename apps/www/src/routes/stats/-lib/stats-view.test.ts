import { describe, expect, it } from "vite-plus/test";
import type {
  StatsDailyPoint,
  StatsRange,
  StatsRankedMetric,
  StatsResponse,
  StatsSeriesPoint,
  StatsTotals,
  UsageRangeId,
} from "@tokenmaxxing/api-contract";

import { deriveStatsView } from "./stats-view";

describe("deriveStatsView", () => {
  it("charts the range from its start through the server's UTC today", () => {
    // Generated on Jun 22 UTC: a device east of UTC can already date usage
    // the 23rd, and year-3089 rows (seen in production) are corrupt. Neither
    // gets a bar; both still count in the server's totals.
    const view = deriveStatsView(
      stats({
        daily: [day("2026-06-20", 1), day("2026-06-22", 2), day("2026-06-23", 4)],
        models: [cell("2026-06-20", "opus", 1), cell("2026-06-23", "opus", 4)],
        since: { "2w": "2026-06-20" },
      }),
      "2w",
      "tokens",
    );

    expect(view.window).toEqual({ firstDate: "2026-06-20", lastDate: "2026-06-22" });
    expect(view.models.chart.days.map((bar) => [bar.date, bar.total])).toEqual([
      ["2026-06-20", 1],
      ["2026-06-21", 0],
      ["2026-06-22", 0],
    ]);
  });

  it("buckets a long range into equal bars ending today", () => {
    const view = deriveStatsView(
      stats({ daily: [day("2026-06-22", 1)], since: { ytd: "2026-01-01" } }),
      "ytd",
      "tokens",
    );

    // Jan 1 – Jun 22 is 173 days: 3-day bars, the oldest (Jan 1–2) partial.
    expect(view.bucketDays).toBe(3);
    expect(view.models.chart.days.at(-1)).toMatchObject({
      date: "2026-06-20",
      endDate: "2026-06-22",
    });
    expect(view.models.chart.days[0]).toMatchObject({ date: "2026-01-01", endDate: "2026-01-02" });
  });

  it("tables exactly the charted series, with server user counts and an Other row", () => {
    const models = Array.from({ length: 11 }, (_, index) =>
      cell("2026-06-22", `model-${String(index).padStart(2, "0")}`, 11 - index),
    );
    const view = deriveStatsView(
      stats({
        daily: [day("2026-06-22", 66)],
        models,
        modelsByTokens: [ranked("model-00", 7)],
      }),
      "2w",
      "tokens",
    );

    const rows = view.models.rows;
    expect(rows.map((row) => row.key)).toEqual([
      ...Array.from({ length: 9 }, (_, index) => `model-0${index}`),
      "Other",
    ]);
    expect(rows[0]).toMatchObject({ label: "model-00", totalTokens: 11, userCount: 7 });
    // Ranked only by the server's top list; unranked series show no users.
    expect(rows[1]?.userCount).toBeNull();
    expect(rows.at(-1)).toMatchObject({ label: "Other", totalTokens: 3, userCount: null });
    expect(rows.reduce((sum, row) => sum + row.percent, 0)).toBeCloseTo(100);
    expect(rows.map((row) => row.color)).toEqual(view.models.chart.legend.map((e) => e.color));
  });

  it("labels agents by name and ranks every section by the selected metric", () => {
    const data = stats({
      daily: [day("2026-06-22", 30)],
      models: [cell("2026-06-22", "opus", 1, 20), cell("2026-06-22", "gpt", 9, 10)],
      modelsBySpend: [ranked("opus", 1)],
      modelsByTokens: [ranked("gpt", 2)],
      sources: [
        { ...ranked("codex", 3), spendUsd: 10, totalTokens: 9 },
        { ...ranked("claude", 4), spendUsd: 20, totalTokens: 1 },
      ],
      sourceCells: [cell("2026-06-22", "claude", 1, 20), cell("2026-06-22", "codex", 9, 10)],
    });

    const bySpend = deriveStatsView(data, "2w", "spend");
    const byTokens = deriveStatsView(data, "2w", "tokens");

    expect(bySpend.models.rows.map((row) => row.key)).toEqual(["opus", "gpt"]);
    expect(byTokens.models.rows.map((row) => row.key)).toEqual(["gpt", "opus"]);
    expect(bySpend.agents.rows.map((row) => row.label)).toEqual(["Claude Code", "OpenAI Codex"]);
    expect([bySpend.cards.topModel, byTokens.cards.topModel]).toEqual(["opus", "gpt"]);
    expect([bySpend.cards.topAgent, byTokens.cards.topAgent]).toEqual([
      "Claude Code",
      "OpenAI Codex",
    ]);
  });

  it("derives the cards from the range's exact totals and its busiest day", () => {
    const view = deriveStatsView(
      stats({
        daily: [day("2026-06-20", 5, 900), day("2026-06-21", 50, 10), day("2026-06-22", 7, 100)],
        totals: { cacheReadTokens: 750, spendUsd: 62, totalTokens: 1_000, userCount: 4 },
      }),
      "2w",
      "spend",
    );

    expect(view.cards).toMatchObject({
      busiestDay: { date: "2026-06-21", value: 50 },
      cacheReadPercent: 75,
      spendPerUser: 15.5,
      spendUsd: 62,
      totalTokens: 1_000,
      userCount: 4,
    });
    expect(deriveStatsView(stats({ daily: [] }), "2w", "spend").cards).toMatchObject({
      busiestDay: null,
      spendPerUser: 0,
      topAgent: null,
      topModel: null,
    });
  });

  it("averages daily active users over each bar's own days", () => {
    const daily = [
      { ...day("2026-01-01", 0), userCount: 30 },
      { ...day("2026-06-21", 0), userCount: 10 },
      { ...day("2026-06-22", 0), userCount: 20 },
    ];
    const view = deriveStatsView(stats({ daily, since: { ytd: "2026-01-01" } }), "ytd", "tokens");

    // Three-day bars: the newest averages Jun 20–22, the partial oldest Jan 1–2.
    expect(view.activeUsers.at(-1)).toMatchObject({ date: "2026-06-20", total: 10 });
    expect(view.activeUsers[0]).toMatchObject({ date: "2026-01-01", total: 15 });
  });

  it("has no window before any usage exists", () => {
    const view = deriveStatsView(stats({ daily: [] }), "2m", "tokens");

    expect(view.window).toBeNull();
    expect(view.models.chart.days).toEqual([]);
    expect(view.activeUsers).toEqual([]);
  });
});

function day(date: string, spendUsd: number, totalTokens = 0): StatsDailyPoint {
  return { date, spendUsd, totalTokens, userCount: 1 };
}

function cell(date: string, key: string, totalTokens: number, spendUsd = 0): StatsSeriesPoint {
  return { date, key, spendUsd, totalTokens };
}

function ranked(key: string, userCount: number): StatsRankedMetric {
  return { key, rowCount: 1, spendUsd: 0, totalTokens: 0, userCount };
}

function stats({
  daily,
  models = [],
  modelsBySpend = [],
  modelsByTokens = [],
  since = {},
  sourceCells = [],
  sources = [],
  totals = {},
}: {
  daily: StatsDailyPoint[];
  models?: StatsSeriesPoint[];
  modelsBySpend?: StatsRankedMetric[];
  modelsByTokens?: StatsRankedMetric[];
  since?: Partial<Record<UsageRangeId, string>>;
  sourceCells?: StatsSeriesPoint[];
  sources?: StatsRankedMetric[];
  totals?: Partial<StatsTotals>;
}): StatsResponse {
  const range = (start: string): StatsRange => ({
    modelsBySpend,
    modelsByTokens,
    since: start,
    sources,
    totals: {
      activeDays: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      deviceCount: 0,
      firstDate: null,
      inputTokens: 0,
      lastDate: null,
      outputTokens: 0,
      rowCount: 0,
      spendUsd: 0,
      totalTokens: 0,
      userCount: 0,
      ...totals,
    },
  });

  return {
    daily,
    dailyByModel: models,
    dailyBySource: sourceCells,
    generatedAt: "2026-06-22T18:30:00.000Z",
    ranges: {
      "1m": range(since["1m"] ?? "2026-05-24"),
      "2m": range(since["2m"] ?? "2026-04-24"),
      "2w": range(since["2w"] ?? "2026-06-09"),
      "3m": range(since["3m"] ?? "2026-03-25"),
      "6m": range(since["6m"] ?? "2025-12-23"),
      ytd: range(since.ytd ?? "2026-01-01"),
    },
    until: "2026-06-23",
  };
}
