import { describe, expect, it } from "vitest";

import { ccusageCommandInvocations, dailyCcusageCommand, sessionCcusageCommand } from "./runner";

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

describe("ccusageCommandInvocations", () => {
  it("uses executable commands instead of shell aliases on Windows", () => {
    expect(ccusageCommandInvocations(["codex", "daily"], "win32")).toEqual([
      { args: ["x", "ccusage@^20.0.17", "codex", "daily"], command: "bun" },
      { args: ["-y", "ccusage@^20.0.17", "codex", "daily"], command: "npx.cmd" },
    ]);
  });
});
