import { describe, expect, it } from "vitest";

import { dailyCcusageCommand, sessionCcusageCommand } from "./runner";

const codex = { source: "codex", subcommand: "codex" };

describe("ccusage commands", () => {
  it("uses the minimum v20 release verified for GPT-5.6", () => {
    expect(dailyCcusageCommand(codex)).toEqual([
      "ccusage@^20.0.17",
      "codex",
      "daily",
      "--json",
      "--breakdown",
      "--mode",
      "calculate",
    ]);
    expect(sessionCcusageCommand(codex)).toEqual([
      "ccusage@^20.0.17",
      "codex",
      "session",
      "--json",
      "--mode",
      "calculate",
    ]);
  });
});
