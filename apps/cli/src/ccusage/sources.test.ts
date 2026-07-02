import { describe, expect, it } from "vitest";

import { DEFAULT_SOURCE_NAMES, resolveSources } from "./sources";

describe("resolveSources", () => {
  it("accepts every default source", () => {
    const { invalid, sources } = resolveSources(DEFAULT_SOURCE_NAMES);
    expect(invalid).toEqual([]);
    expect(sources.map((entry) => entry.source)).toEqual(DEFAULT_SOURCE_NAMES);
  });

  it("resolves the pi-agent source to the ccusage `pi` subcommand", () => {
    const { invalid, sources } = resolveSources(["pi"]);
    expect(invalid).toEqual([]);
    expect(sources).toEqual([{ source: "pi", subcommand: "pi" }]);
  });

  it("rejects unknown sources", () => {
    expect(resolveSources(["bogus"]).invalid).toEqual(["bogus"]);
  });
});
