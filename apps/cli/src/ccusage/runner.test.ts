import { readFileSync } from "node:fs";
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

function missingBun(source: string) {
  return new CcusageRunError({
    cause: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
    code: "command_not_found",
    report: "daily",
    source,
  });
}

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
  // Bun 1.4 (0.7.0's runtime) throws EINVAL for a .cmd started without a shell, which killed
  // every scheduled run on Windows without bun right after its started check-in.
  it("runs the Windows npm command shim through cmd.exe, quoting its arguments but not its name", () => {
    expect(
      ccusageCommandInvocations(["codex", "daily", "--since", "20260910"], "win32", {
        ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
      }),
    ).toEqual([
      { args: ["x", "ccusage@^20.0.22", "codex", "daily", "--since", "20260910"], command: "bun" },
      {
        args: [
          "/d",
          "/s",
          "/c",
          '"npx.cmd "-y" "ccusage@^20.0.22" "codex" "daily" "--since" "20260910""',
        ],
        command: "C:\\WINDOWS\\system32\\cmd.exe",
        shim: "npx.cmd",
        windowsVerbatimArguments: true,
      },
    ]);
    expect(ccusageCommandInvocations(["codex", "daily"], "win32", {})[1].command).toBe("cmd.exe");
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
      {
        windowsVerbatimArguments: false,
      },
    );
  });

  it("falls back to npx.cmd through cmd.exe when Bun is missing on Windows", async () => {
    const npmDir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-npm-"));
    try {
      await writeFile(join(npmDir, "npx.cmd"), "@echo off\r\n");
      // Windows spells the key Path; a copied environment keeps that case.
      const env = { Path: `C:\\WINDOWS\\system32;"${npmDir}"` };
      const run = vi
        .fn()
        .mockReturnValueOnce(Effect.fail(missingBun("codex")))
        .mockReturnValueOnce(Effect.succeed('{"daily":[]}'));

      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", { env, platform: "win32", run }),
        ),
      ).resolves.toBe('{"daily":[]}');
      expect(run).toHaveBeenNthCalledWith(
        1,
        "bun",
        ["x", "ccusage@^20.0.22", "codex", "daily"],
        env,
        { windowsVerbatimArguments: false },
      );
      expect(run).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/cmd\.exe$/i),
        ["/d", "/s", "/c", '"npx.cmd "-y" "ccusage@^20.0.22" "codex" "daily""'],
        env,
        { windowsVerbatimArguments: true },
      );
    } finally {
      await rm(npmDir, { force: true, recursive: true });
    }
  });

  it("reports ccusage as not found when neither bun nor npx.cmd is on the Windows PATH", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-empty-"));
    try {
      const run = vi.fn(() => Effect.fail(missingBun("codex")));

      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: emptyDir },
          platform: "win32",
          run,
        }),
      );

      expect(error.code).toBe("command_not_found");
      // cmd.exe itself would start fine and only then fail to find npx.cmd.
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await rm(emptyDir, { force: true, recursive: true });
    }
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
      const run = vi
        .fn()
        .mockReturnValueOnce(Effect.fail(missingBun("hermes")))
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
      expect(run).toHaveBeenNthCalledWith(1, "bun", expect.any(Array), expectedEnv, {
        windowsVerbatimArguments: false,
      });
      expect(run).toHaveBeenNthCalledWith(2, "npx", expect.any(Array), expectedEnv, {
        windowsVerbatimArguments: false,
      });
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

    expect(run).toHaveBeenCalledWith("bun", expect.any(Array), env, {
      windowsVerbatimArguments: false,
    });
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

  it("strips local filesystem paths from model names before upload", async () => {
    const report = await Effect.runPromise(
      runCcusageDailyReport(codex, {
        exec: {
          run: () =>
            Effect.succeed(
              JSON.stringify({
                daily: [
                  {
                    date: "2026-09-21",
                    modelBreakdowns: [
                      { modelName: "/home/alice/Downloads/gemma.gguf" },
                      { modelName: "~anthropic/claude-sonnet-4.5" },
                    ],
                    models: { "C:\\Users\\alice\\models\\qwen.gguf": { inputTokens: 1 } },
                    modelsUsed: ["/Users/alice/maple-mlx/maple-2bit-mlx"],
                  },
                ],
              }),
            ),
        },
      }),
    );

    expect(report).toEqual({
      daily: [
        {
          date: "2026-09-21",
          modelBreakdowns: [
            { modelName: "gemma.gguf" },
            { modelName: "~anthropic/claude-sonnet-4.5" },
          ],
          models: { "qwen.gguf": { inputTokens: 1 } },
          modelsUsed: ["maple-2bit-mlx"],
        },
      ],
    });
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

describe.skipIf(process.platform === "win32")("the real ccusage command runner", () => {
  async function fakeBun(script: string) {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-"));
    await writeFile(join(dir, "bun"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return dir;
  }

  function isAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // S3c/S3d: npx (and a bun that does not exec in place) runs ccusage's node
  // as a child. A timeout used to kill only the direct child; the grandchild
  // kept the stdio pipes open and the CLI never exited.
  it("kills what ccusage started when it times out", async () => {
    const dir = await fakeBun(`sleep 30 &\necho $! > "$(dirname "$0")/grandchild.pid"\nwait`);
    try {
      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: `${dir}:/usr/bin:/bin` },
          timeoutMs: 500,
        }),
      );

      expect(error.code).toBe("command_timed_out");
      const grandchild = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
      await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: 3_000 });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps the end of ccusage's stderr on failure", async () => {
    const dir = await fakeBun(
      `echo "noise" >&2\necho "/usr/bin/env: 'node': No such file or directory" >&2\nexit 127`,
    );
    try {
      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: `${dir}:/usr/bin:/bin` },
        }),
      );

      expect(error.code).toBe("command_failed");
      expect(error.stderr).toBe("noise\n/usr/bin/env: 'node': No such file or directory");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("fails the source, instead of dying, when spawn throws", async () => {
    const dir = await fakeBun(`echo '{"daily":[]}'`);
    try {
      // Node's spawn throws synchronously for a NUL in the environment, as it (and Bun 1.4) does
      // with EINVAL for a Windows .cmd started without a shell.
      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { BROKEN: "a\0b", PATH: `${dir}:/usr/bin:/bin` },
        }),
      );

      expect(error.code).toBe("command_failed");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns stdout on success", async () => {
    const dir = await fakeBun(`echo '{"daily":[]}'`);
    try {
      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", {
            env: { PATH: `${dir}:/usr/bin:/bin` },
          }),
        ),
      ).resolves.toBe('{"daily":[]}\n');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
