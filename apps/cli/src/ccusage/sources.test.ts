import { describe, expect, it } from "vitest";

import { DEFAULT_SOURCE_NAMES, resolveSources } from "./sources";

describe("resolveSources", () => {
  it("resolves every default source", () => {
    const { invalid, sources } = resolveSources(DEFAULT_SOURCE_NAMES);

    expect(invalid).toEqual([]);
    expect(sources.map((entry) => entry.source)).toEqual([
      "claude",
      "codex",
      "opencode",
      "gemini",
      "copilot",
      "kimi",
      "grok",
      "antigravity",
    ]);
  });

  it("maps ccusage sources to their subcommand", () => {
    const { sources } = resolveSources(["kimi"]);

    expect(sources).toEqual([{ collector: "ccusage", source: "kimi", subcommand: "kimi" }]);
  });

  it("marks grok and antigravity as local collectors", () => {
    const { sources } = resolveSources(["grok", "antigravity"]);

    expect(sources).toEqual([
      { collector: "grok", source: "grok" },
      { collector: "antigravity", source: "antigravity" },
    ]);
  });

  it("accepts agy as an alias for antigravity", () => {
    const { invalid, sources } = resolveSources(["agy"]);

    expect(invalid).toEqual([]);
    expect(sources).toEqual([{ collector: "antigravity", source: "antigravity" }]);
  });

  it("dedupes aliases and canonical names", () => {
    const { sources } = resolveSources(["agy", "antigravity", " AGY "]);

    expect(sources).toHaveLength(1);
  });

  it("collects unknown names without dropping valid ones", () => {
    const { invalid, sources } = resolveSources(["grok", "not-a-tool"]);

    expect(invalid).toEqual(["not-a-tool"]);
    expect(sources.map((entry) => entry.source)).toEqual(["grok"]);
  });
});
