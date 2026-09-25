import { describe, expect, it } from "vite-plus/test";

import { modelColor, OTHER_MODEL_SERIES_COLOR } from "./model-colors";
import {
  bucketSeries,
  buildSegments,
  buildStackedSeriesCharts,
  segmentTooltipRows,
  selectModelSeries,
} from "./series";

describe("selectModelSeries", () => {
  it("keeps raw model names when they fit within the limit", () => {
    const rows = [
      { key: "glm-5-turbo", value: 20 },
      { key: "deepseek-v4", value: 10 },
    ];

    const selection = selectModelSeries(rows, (row) => row.value);

    expect(selection.order).toEqual(["glm-5-turbo", "deepseek-v4"]);
    expect(selection.label("glm-5-turbo")).toBe("glm-5-turbo");
    expect(selection.label("deepseek-v4")).toBe("deepseek-v4");
  });

  it("reserves the final slot for the long tail", () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      key: `model-${String(index + 1).padStart(2, "0")}`,
      value: 11 - index,
    }));

    const selection = selectModelSeries(rows, (row) => row.value);

    expect(selection.order).toEqual([
      "model-01",
      "model-02",
      "model-03",
      "model-04",
      "model-05",
      "model-06",
      "model-07",
      "model-08",
      "model-09",
      "Other",
    ]);
    expect(selection.label("model-09")).toBe("model-09");
    expect(selection.label("model-10")).toBe("Other");
    expect(selection.label("model-11")).toBe("Other");
  });

  it("folds a pre-collapsed Other row into the tail without ranking it", () => {
    const rows = [
      { key: "Other", value: 1_000 },
      { key: "claude-opus", value: 20 },
      { key: "gpt-5", value: 10 },
    ];

    const selection = selectModelSeries(rows, (row) => row.value, 3);

    expect(selection.order).toEqual(["claude-opus", "gpt-5", "Other"]);
    expect(selection.label("Other")).toBe("Other");
  });
});

describe("stacked series", () => {
  const rows = [
    { costUsd: 3, date: "2026-06-20", key: "b" },
    { costUsd: 5, date: "2026-06-20", key: "a" },
    { costUsd: 2, date: "2026-06-22", key: "a" },
  ];

  it("zero-fills days and keeps segment order stable across days", () => {
    const {
      charts: { cost: chart },
    } = buildStackedSeriesCharts(rows, ["2026-06-20", "2026-06-21", "2026-06-22"], {
      cost: (row) => row.costUsd,
    });

    expect(chart.days.map((day) => [day.date, day.total])).toEqual([
      ["2026-06-20", 8],
      ["2026-06-21", 0],
      ["2026-06-22", 2],
    ]);
    expect(chart.days.map((day) => day.segments.map((segment) => segment.series))).toEqual([
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(chart.days[1]?.segments.every((segment) => segment.value === 0)).toBe(true);
  });

  it("ranks legend entries by share and drops empty series", () => {
    const {
      charts: { cost: chart },
    } = buildStackedSeriesCharts(rows, ["2026-06-20"], { cost: (row) => row.costUsd });

    expect(chart.legend).toEqual([
      { color: modelColor("a"), percent: 62.5, series: "a" },
      { color: modelColor("b"), percent: 37.5, series: "b" },
    ]);
  });

  it("colors a model the same in every metric's chart and legend", () => {
    const sessionRows = [
      ...rows,
      { costUsd: 0, date: "2026-06-20", key: "c" },
      { costUsd: 0, date: "2026-06-21", key: "c" },
    ];
    const { charts, colors } = buildStackedSeriesCharts(sessionRows, ["2026-06-20"], {
      cost: (row) => row.costUsd,
      sessions: () => 1,
    });

    for (const chart of [charts.cost, charts.sessions]) {
      for (const entry of chart.legend) {
        expect(entry.color).toBe(colors.get(entry.series));
      }
      for (const segment of chart.days[0]?.segments ?? []) {
        expect(segment.color).toBe(colors.get(segment.series));
      }
    }
    expect(charts.sessions.legend.map((entry) => entry.series)).toContain("c");
    expect(new Set(["a", "b", "c"].map((model) => colors.get(model))).size).toBe(3);
  });

  it("buckets by an arbitrary key such as the month", () => {
    const selection = selectModelSeries(rows, (row) => row.costUsd);
    const buckets = bucketSeries(
      rows,
      selection,
      (row) => row.costUsd,
      (row) => row.date.slice(0, 7),
    );

    expect(buckets.totals.get("2026-06")).toBe(10);
    expect(buckets.values.get("2026-06")?.get("a")).toBe(7);
  });

  it("falls back to a series' own color when the map lacks it", () => {
    expect(buildSegments(["missing", "Other"], new Map(), undefined)).toEqual([
      { color: modelColor("missing"), series: "missing", value: 0 },
      { color: OTHER_MODEL_SERIES_COLOR, series: "Other", value: 0 },
    ]);
  });

  it("lists non-empty segments largest first as tooltip rows", () => {
    const segments = [
      { color: "#111", series: "small", value: 1 },
      { color: "#222", series: "empty", value: 0 },
      { color: "#333", series: "large", value: 9 },
    ];

    expect(segmentTooltipRows(segments, (segment) => `${segment.value}!`)).toEqual([
      { color: "#333", label: "large", value: "9!" },
      { color: "#111", label: "small", value: "1!" },
    ]);
    expect(segments.map((segment) => segment.series)).toEqual(["small", "empty", "large"]);
  });
});
