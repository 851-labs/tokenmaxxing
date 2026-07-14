import { describe, expect, it } from "vitest";

import { modelSeriesLabel } from "./scale";

describe("modelSeriesLabel", () => {
  it.each([
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["claude-fable-5", "Claude Fable 5"],
    ["claude-opus", "Claude Opus"],
    ["gpt-5.6", "GPT-5.6 Sol"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.4", "GPT-5.4"],
    ["gpt-5", "GPT-5"],
    ["unknown", "Other"],
  ])("labels %s as %s", (model, expected) => {
    expect(modelSeriesLabel(model)).toBe(expected);
  });
});
