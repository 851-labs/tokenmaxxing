import { describe, expect, it } from "vitest";

import { DEFAULT_SOURCE_NAMES, resolveSources } from "./sources";

describe("Antigravity usage source registry", () => {
  it("syncs both Antigravity CLI and legacy Gemini CLI by default", () => {
    expect(DEFAULT_SOURCE_NAMES).toContain("antigravity-cli");
    expect(DEFAULT_SOURCE_NAMES).toContain("gemini");
  });

  it("accepts the short Antigravity alias but stores one canonical source", () => {
    expect(resolveSources(["antigravity", "ANTIGRAVITY-CLI"])).toEqual({
      invalid: [],
      sources: [{ kind: "antigravity", source: "antigravity-cli" }],
    });
  });

  it("deduplicates valid sources and reports unknown names", () => {
    expect(resolveSources(["gemini", "gemini", "gravity"])).toEqual({
      invalid: ["gravity"],
      sources: [{ kind: "ccusage", source: "gemini", subcommand: "gemini" }],
    });
  });
});
