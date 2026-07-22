import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CcusageRunError,
  ccusageCommandInvocations,
  dailyCcusageCommand,
  execCcusage,
  sessionCcusageCommand,
} from "./runner";

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
  it("selects the Windows npm command shim", () => {
    expect(ccusageCommandInvocations(["codex", "daily"], "win32")).toEqual([
      { args: ["x", "ccusage@^20.0.17", "codex", "daily"], command: "bun" },
      { args: ["-y", "ccusage@^20.0.17", "codex", "daily"], command: "npx.cmd" },
    ]);
  });

  it("keeps the POSIX npm fallback", () => {
    expect(ccusageCommandInvocations(["codex", "daily"], "linux")).toEqual([
      { args: ["x", "ccusage@^20.0.17", "codex", "daily"], command: "bun" },
      { args: ["-y", "ccusage@^20.0.17", "codex", "daily"], command: "npx" },
    ]);
  });
});

describe("execCcusage", () => {
  it("returns a successful Bun result without invoking npm", async () => {
    const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

    await expect(
      Effect.runPromise(execCcusage(["codex", "daily"], "codex", { platform: "win32", run })),
    ).resolves.toBe('{"daily":[]}');
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("bun", ["x", "ccusage@^20.0.17", "codex", "daily"]);
  });

  it("falls back to npx.cmd when Bun is missing on Windows", async () => {
    const missingBun = new CcusageRunError({
      cause: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
      source: "codex",
    });
    const run = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(missingBun))
      .mockReturnValueOnce(Effect.succeed('{"daily":[]}'));

    await expect(
      Effect.runPromise(execCcusage(["codex", "daily"], "codex", { platform: "win32", run })),
    ).resolves.toBe('{"daily":[]}');
    expect(run).toHaveBeenNthCalledWith(1, "bun", ["x", "ccusage@^20.0.17", "codex", "daily"]);
    expect(run).toHaveBeenNthCalledWith(2, "npx.cmd", ["-y", "ccusage@^20.0.17", "codex", "daily"]);
  });

  it("does not mask a Bun execution failure with the npm fallback", async () => {
    const failedBun = new CcusageRunError({
      cause: Object.assign(new Error("bun x failed"), { code: 1 }),
      source: "codex",
    });
    const run = vi.fn(() => Effect.fail(failedBun));

    await expect(
      Effect.runPromise(execCcusage(["codex", "daily"], "codex", { platform: "win32", run })),
    ).rejects.toBeDefined();
    expect(run).toHaveBeenCalledOnce();
  });
});
