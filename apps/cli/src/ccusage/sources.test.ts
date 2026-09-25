import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_SOURCE_NAMES, resolveSources } from "./sources";

describe("resolveSources", () => {
  it("accepts every default source", () => {
    const { invalid, sources } = resolveSources(DEFAULT_SOURCE_NAMES);

    expect(invalid).toEqual([]);
    expect(sources.map((entry) => entry.source)).toEqual(DEFAULT_SOURCE_NAMES);
  });

  it("resolves Pi to the focused ccusage subcommand", () => {
    expect(resolveSources(["pi"])).toEqual({
      invalid: [],
      sources: [{ source: "pi", subcommand: "pi" }],
    });
  });

  it("resolves Hermes to the focused ccusage subcommand", () => {
    expect(resolveSources(["hermes"])).toEqual({
      invalid: [],
      sources: [{ source: "hermes", subcommand: "hermes" }],
    });
  });

  it("maps every source to its focused ccusage subcommand", () => {
    expect(DEFAULT_SOURCE_NAMES).toEqual([
      "claude",
      "codex",
      "opencode",
      "gemini",
      "copilot",
      "hermes",
      "pi",
      "grok",
      "antigravity",
      "zcode",
      "amp",
      "qwen",
      "kimi",
      "kilo",
      "goose",
      "droid",
      "codebuff",
      "openclaw",
    ]);
    for (const { source, subcommand } of resolveSources(DEFAULT_SOURCE_NAMES).sources) {
      expect(subcommand).toBe(source);
    }
  });

  it("normalizes case and whitespace and drops duplicates", () => {
    expect(resolveSources([" Grok", "zcode", "grok "])).toEqual({
      invalid: [],
      sources: [
        { source: "grok", subcommand: "grok" },
        { source: "zcode", subcommand: "zcode" },
      ],
    });
  });

  it("rejects unknown sources", () => {
    expect(resolveSources(["bogus"]).invalid).toEqual(["bogus"]);
    expect(resolveSources(["supercharge", "cursor"]).invalid).toEqual(["supercharge", "cursor"]);
  });
});
