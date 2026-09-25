import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Option } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CcusageRunError,
  ccusageCommandInvocations,
  dailyCcusageCommand,
  execCcusage,
  runCcusageDailyReport,
  sessionCcusageCommand,
} from "./runner";
import type { CcusageSource } from "./sources";

const codex: CcusageSource = { source: "codex", subcommand: "codex" };
const hermes: CcusageSource = { source: "hermes", subcommand: "hermes" };
const pi: CcusageSource = { source: "pi", subcommand: "pi" };

async function ccusageErrorFor<A>(effect: Effect.Effect<A, CcusageRunError>) {
  const exit = await Effect.runPromiseExit(effect);
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") {
    throw new Error("expected ccusage failure");
  }

  const error = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(error)).toBe(true);
  if (Option.isNone(error) || !(error.value instanceof CcusageRunError)) {
    throw new Error("expected typed ccusage error");
  }

  return error.value;
}

describe("ccusage commands", () => {
  it("uses the minimum v20 release that ships every supported adapter", () => {
    expect(dailyCcusageCommand(codex)).toEqual([
      "ccusage@^20.0.22",
      "codex",
      "daily",
      "--json",
      "--breakdown",
      "--mode",
      "calculate",
    ]);
    expect(sessionCcusageCommand(codex)).toEqual([
      "ccusage@^20.0.22",
      "codex",
      "session",
      "--json",
      "--mode",
      "calculate",
    ]);
  });

  it("builds focused Pi daily and session commands", () => {
    expect(dailyCcusageCommand(pi)).toEqual([
      "ccusage@^20.0.22",
      "pi",
      "daily",
      "--json",
      "--breakdown",
      "--mode",
      "calculate",
    ]);
    expect(sessionCcusageCommand(pi)).toEqual([
      "ccusage@^20.0.22",
      "pi",
      "session",
      "--json",
      "--mode",
      "calculate",
    ]);
  });

  it("builds focused Hermes daily and session commands", () => {
    expect(dailyCcusageCommand(hermes)).toEqual([
      "ccusage@^20.0.22",
      "hermes",
      "daily",
      "--json",
      "--breakdown",
      "--mode",
      "calculate",
    ]);
    expect(sessionCcusageCommand(hermes)).toEqual([
      "ccusage@^20.0.22",
      "hermes",
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
      { args: ["x", "ccusage@^20.0.22", "codex", "daily"], command: "bun" },
      { args: ["-y", "ccusage@^20.0.22", "codex", "daily"], command: "npx.cmd" },
    ]);
  });

  it("keeps the POSIX npm fallback", () => {
    expect(ccusageCommandInvocations(["codex", "daily"], "linux")).toEqual([
      { args: ["x", "ccusage@^20.0.22", "codex", "daily"], command: "bun" },
      { args: ["-y", "ccusage@^20.0.22", "codex", "daily"], command: "npx" },
    ]);
  });
});

describe("execCcusage", () => {
  it("returns a successful Bun result without invoking npm", async () => {
    const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

    await expect(
      Effect.runPromise(
        execCcusage(["codex", "daily"], "codex", "daily", { platform: "win32", run }),
      ),
    ).resolves.toBe('{"daily":[]}');
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      "bun",
      ["x", "ccusage@^20.0.22", "codex", "daily"],
      process.env,
    );
  });

  it("falls back to npx.cmd when Bun is missing on Windows", async () => {
    const missingBun = new CcusageRunError({
      cause: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
      code: "command_not_found",
      report: "daily",
      source: "codex",
    });
    const run = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(missingBun))
      .mockReturnValueOnce(Effect.succeed('{"daily":[]}'));

    await expect(
      Effect.runPromise(
        execCcusage(["codex", "daily"], "codex", "daily", { platform: "win32", run }),
      ),
    ).resolves.toBe('{"daily":[]}');
    expect(run).toHaveBeenNthCalledWith(
      1,
      "bun",
      ["x", "ccusage@^20.0.22", "codex", "daily"],
      process.env,
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "npx.cmd",
      ["-y", "ccusage@^20.0.22", "codex", "daily"],
      process.env,
    );
  });

  it("does not mask a Bun execution failure with the npm fallback", async () => {
    const failedBun = new CcusageRunError({
      cause: Object.assign(new Error("bun x failed"), { code: 1 }),
      code: "command_failed",
      report: "daily",
      source: "codex",
    });
    const run = vi.fn(() => Effect.fail(failedBun));

    const error = await ccusageErrorFor(
      execCcusage(["codex", "daily"], "codex", "daily", { platform: "win32", run }),
    );
    expect(error).toBe(failedBun);
    expect(run).toHaveBeenCalledOnce();
  });

  it("classifies command timeouts without trying the npm fallback", async () => {
    const run = vi.fn(() => Effect.never);

    const error = await ccusageErrorFor(
      execCcusage(["codex", "daily"], "codex", "daily", {
        platform: "win32",
        run,
        timeoutMs: 1,
      }),
    );

    expect(error.code).toBe("command_timed_out");
    expect(error.report).toBe("daily");
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs Hermes with discovered profile roots on both the Bun and npm paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-hermes-"));
    try {
      const hermesRoot = join(home, ".hermes");
      const profile = join(hermesRoot, "profiles", "work");
      await mkdir(profile, { recursive: true });
      await writeFile(join(hermesRoot, "state.db"), "default");
      await writeFile(join(profile, "state.db"), "work");
      const realRoot = await realpath(hermesRoot);
      const missingBun = new CcusageRunError({
        cause: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
        code: "command_not_found",
        report: "daily",
        source: "hermes",
      });
      const run = vi
        .fn()
        .mockReturnValueOnce(Effect.fail(missingBun))
        .mockReturnValueOnce(Effect.succeed('{"daily":[]}'));

      await Effect.runPromise(
        execCcusage(["hermes", "daily"], "hermes", "daily", {
          env: { HOME: home, PATH: "/usr/bin" },
          platform: "linux",
          run,
        }),
      );

      const expectedEnv = {
        HERMES_HOME: `${realRoot},${join(realRoot, "profiles", "work")}`,
        HOME: home,
        PATH: "/usr/bin",
      };
      expect(run).toHaveBeenNthCalledWith(1, "bun", expect.any(Array), expectedEnv);
      expect(run).toHaveBeenNthCalledWith(2, "npx", expect.any(Array), expectedEnv);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("passes explicit source roots through unchanged", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: "/data/Claude Logs, extra",
      HERMES_HOME: "/data/hermes",
      HOME: "/home/alex",
    };
    const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

    await Effect.runPromise(
      execCcusage(["hermes", "daily"], "hermes", "daily", { env, platform: "linux", run }),
    );

    expect(run).toHaveBeenCalledWith("bun", expect.any(Array), env);
  });
});

describe("runCcusageDailyReport", () => {
  it("returns valid empty reports as data instead of a runner failure", async () => {
    const report = await Effect.runPromise(
      runCcusageDailyReport(codex, {
        exec: { run: () => Effect.succeed('{"daily":[]}') },
      }),
    );

    expect(report).toEqual({ daily: [] });
  });

  it("classifies malformed JSON", async () => {
    const error = await ccusageErrorFor(
      runCcusageDailyReport(codex, {
        exec: { run: () => Effect.succeed("not json") },
      }),
    );

    expect(error.code).toBe("invalid_json");
    expect(error.report).toBe("daily");
  });

  it("classifies JSON that does not match the report schema", async () => {
    const error = await ccusageErrorFor(
      runCcusageDailyReport(codex, {
        exec: { run: () => Effect.succeed('{"sessions":[]}') },
      }),
    );

    expect(error.code).toBe("invalid_report");
    expect(error.report).toBe("daily");
  });
});
