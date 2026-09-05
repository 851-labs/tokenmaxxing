import { describe, expect, it } from "vitest";

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

  it("resolves Grok to the focused ccusage subcommand", () => {
    expect(resolveSources(["grok"])).toEqual({
      invalid: [],
      sources: [{ source: "grok", subcommand: "grok" }],
    });
  });

  it("resolves Supercharge as a native (subcommand-less) source", () => {
    const { invalid, sources } = resolveSources(["supercharge"]);

    expect(invalid).toEqual([]);
    expect(sources[0]?.source).toBe("supercharge");
    expect(sources[0]?.subcommand).toBeUndefined();
  });

  it("rejects unknown sources", () => {
    expect(resolveSources(["bogus"]).invalid).toEqual(["bogus"]);
  });
});
