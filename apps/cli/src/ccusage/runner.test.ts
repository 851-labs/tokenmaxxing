import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CcusageRunError,
  ccusageCommandInvocations,
  ccusageRunDiagnostic,
  dailyCcusageCommand,
  execCcusage,
  findWindowsBun,
  runCcusageDailyReport,
  runCcusageSessionReport,
  sessionCcusageCommand,
} from "./runner";
import type { CcusageSource } from "./sources";

const codex: CcusageSource = { source: "codex", subcommand: "codex" };
const hermes: CcusageSource = { source: "hermes", subcommand: "hermes" };
const pi: CcusageSource = { source: "pi", subcommand: "pi" };
const omp: CcusageSource = { source: "omp", subcommand: "pi" };

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

  it("records Oh My Pi's pi commands without its local session paths", () => {
    expect(dailyCcusageCommand(omp, { since: "2026-09-10" })).toEqual([
      "ccusage@^20.0.22",
      "pi",
      "daily",
      "--json",
      "--breakdown",
      "--mode",
      "calculate",
      "--since",
      "20260910",
    ]);
    expect(sessionCcusageCommand(omp)).toEqual(sessionCcusageCommand(pi));
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
  const args = ["codex", "daily", "--since", "20260910"];
  const npxCmd = {
    args: [
      "/d",
      "/s",
      "/c",
      '"npx.cmd "-y" "ccusage@^20.0.22" "codex" "daily" "--since" "20260910""',
    ],
    command: "C:\\WINDOWS\\system32\\cmd.exe",
    runner: "npx.cmd",
    shim: "npx.cmd",
    windowsVerbatimArguments: true,
  };

  // Bun 1.4 (0.7.0's runtime) throws EINVAL for a .cmd started without a shell, which killed
  // every scheduled run on Windows without bun right after its started check-in.
  it("runs the Windows npm command shim through cmd.exe, quoting its arguments but not its name", () => {
    expect(
      ccusageCommandInvocations(args, "win32", { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" }),
    ).toEqual([npxCmd]);
    // A copied environment keeps whatever case Windows gave it.
    expect(
      ccusageCommandInvocations(args, "win32", { COMSPEC: "C:\\WINDOWS\\system32\\cmd.exe" }),
    ).toEqual([npxCmd]);
    expect(ccusageCommandInvocations(["codex", "daily"], "win32", {})[0]!.command).toBe("cmd.exe");
  });

  it("runs bun.exe by its path on Windows, before npx.cmd", () => {
    expect(
      ccusageCommandInvocations(
        args,
        "win32",
        { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
        { kind: "exe", path: "C:\\Users\\a\\.bun\\bin\\bun.exe" },
      ),
    ).toEqual([
      {
        args: ["x", "ccusage@^20.0.22", ...args],
        command: "C:\\Users\\a\\.bun\\bin\\bun.exe",
        runner: "bun.exe",
      },
      npxCmd,
    ]);
  });

  // `npm i -g bun` puts bun.cmd on PATH, not bun.exe. Bun 1.4 runs a bare `bun` that resolves
  // to it through its own cmd.exe line, and refuses the ^ in the version range
  // (ERR_INVALID_ARG_VALUE): every source failed with no stderr, and npx was never tried.
  it("runs a bun.cmd shim through cmd.exe like npx.cmd, keeping the ^ quoted", () => {
    expect(
      ccusageCommandInvocations(
        args,
        "win32",
        { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
        { kind: "shim", name: "bun.cmd" },
      ),
    ).toEqual([
      {
        args: [
          "/d",
          "/s",
          "/c",
          '"bun.cmd "x" "ccusage@^20.0.22" "codex" "daily" "--since" "20260910""',
        ],
        command: "C:\\WINDOWS\\system32\\cmd.exe",
        runner: "bun.cmd",
        shim: "bun.cmd",
        windowsVerbatimArguments: true,
      },
      npxCmd,
    ]);
  });

  it("keeps the POSIX npm fallback", () => {
    expect(ccusageCommandInvocations(["codex", "daily"], "linux")).toEqual([
      { args: ["x", "ccusage@^20.0.22", "codex", "daily"], command: "bun", runner: "bun" },
      { args: ["-y", "ccusage@^20.0.22", "codex", "daily"], command: "npx", runner: "npx" },
    ]);
  });
});

describe("findWindowsBun", () => {
  async function withDirs<A>(
    layout: Record<string, readonly string[]>,
    body: (dirs: Record<string, string>) => Promise<A>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-path-"));
    try {
      const dirs: Record<string, string> = {};
      for (const [name, files] of Object.entries(layout)) {
        dirs[name] = join(root, name);
        await mkdir(dirs[name], { recursive: true });
        for (const file of files) {
          await writeFile(join(dirs[name], file), "");
        }
      }
      return await body(dirs);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }

  it("finds the official bun.exe", async () => {
    await withDirs({ official: ["bun.exe"], system: [] }, async (dirs) => {
      await expect(
        findWindowsBun({ Path: `${dirs["system"]};${dirs["official"]}` }),
      ).resolves.toEqual({ kind: "exe", path: join(dirs["official"]!, "bun.exe") });
    });
  });

  it("finds npm's bun.cmd when it is the only bun", async () => {
    await withDirs({ npm: ["bun", "bun.cmd", "bun.ps1"] }, async (dirs) => {
      await expect(findWindowsBun({ PATH: `"${dirs["npm"]}"` })).resolves.toEqual({
        kind: "shim",
        name: "bun.cmd",
      });
    });
    await withDirs({ shims: ["bun.bat"] }, async (dirs) => {
      await expect(findWindowsBun({ PATH: dirs["shims"]! })).resolves.toEqual({
        kind: "shim",
        name: "bun.bat",
      });
    });
  });

  it("prefers bun.exe over a shim earlier on PATH", async () => {
    await withDirs({ npm: ["bun.cmd"], official: ["bun.exe"] }, async (dirs) => {
      await expect(findWindowsBun({ PATH: `${dirs["npm"]};${dirs["official"]}` })).resolves.toEqual(
        { kind: "exe", path: join(dirs["official"]!, "bun.exe") },
      );
    });
  });

  it("finds no bun when PATH has none", async () => {
    await withDirs({ system: ["npx.cmd", "bunx.cmd"] }, async (dirs) => {
      await expect(findWindowsBun({ PATH: `${dirs["system"]};` })).resolves.toBeUndefined();
      await expect(findWindowsBun({})).resolves.toBeUndefined();
    });
  });
});

describe("execCcusage", () => {
  /** A Windows PATH holding `files`, e.g. npm's dir with bun.cmd and npx.cmd. */
  async function windowsPath<A>(files: readonly string[], body: (dir: string) => Promise<A>) {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-win-"));
    try {
      for (const file of files) {
        await writeFile(join(dir, file), "@echo off\r\n");
      }
      return await body(dir);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  function notStarted(source: string, startError: string) {
    return new CcusageRunError({
      cause: Object.assign(new Error(`spawn failed`), { code: startError }),
      code: "command_failed",
      report: "daily",
      source,
      startError,
    });
  }

  function exited(source: string, code: number, stderr?: string) {
    return new CcusageRunError({
      cause: Object.assign(new Error(`exited with code ${code}`), { code, signal: null }),
      code: "command_failed",
      report: "daily",
      source,
      stderr,
    });
  }

  it("returns a successful Bun result without invoking npm", async () => {
    await windowsPath(["bun.exe", "npx.cmd"], async (dir) => {
      const env = { Path: dir };
      const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", { env, platform: "win32", run }),
        ),
      ).resolves.toBe('{"daily":[]}');
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        join(dir, "bun.exe"),
        ["x", "ccusage@^20.0.22", "codex", "daily"],
        env,
        { windowsVerbatimArguments: false },
      );
    });
  });

  it("runs ccusage through npm's bun.cmd with cmd.exe when that is the only bun", async () => {
    await windowsPath(["bun", "bun.cmd", "npx.cmd"], async (dir) => {
      const env = { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe", Path: dir };
      const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", { env, platform: "win32", run }),
        ),
      ).resolves.toBe('{"daily":[]}');
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        "C:\\WINDOWS\\system32\\cmd.exe",
        ["/d", "/s", "/c", '"bun.cmd "x" "ccusage@^20.0.22" "codex" "daily""'],
        env,
        { windowsVerbatimArguments: true },
      );
    });
  });

  it("goes straight to npx.cmd through cmd.exe when Bun is missing on Windows", async () => {
    await windowsPath(["npx.cmd"], async (npmDir) => {
      // Windows spells the key Path; a copied environment keeps that case.
      const env = { Path: `C:\\WINDOWS\\system32;"${npmDir}"` };
      const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", { env, platform: "win32", run }),
        ),
      ).resolves.toBe('{"daily":[]}');
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", '"npx.cmd "-y" "ccusage@^20.0.22" "codex" "daily""'],
        env,
        { windowsVerbatimArguments: true },
      );
    });
  });

  it("reports ccusage as not found when neither bun nor npx.cmd is on the Windows PATH", async () => {
    await windowsPath([], async (emptyDir) => {
      const run = vi.fn(() => Effect.succeed('{"daily":[]}'));

      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: emptyDir },
          platform: "win32",
          run,
        }),
      );

      expect(error.code).toBe("command_not_found");
      // cmd.exe itself would start fine and only then fail to find npx.cmd.
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("falls back to npx when bun cannot be started", async () => {
    await windowsPath(["bun.exe", "npx.cmd"], async (dir) => {
      const run = vi
        .fn()
        .mockReturnValueOnce(Effect.fail(notStarted("codex", "EACCES")))
        .mockReturnValueOnce(Effect.succeed('{"daily":[]}'));

      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", {
            env: { PATH: dir },
            platform: "win32",
            run,
          }),
        ),
      ).resolves.toBe('{"daily":[]}');
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenLastCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", '"npx.cmd "-y" "ccusage@^20.0.22" "codex" "daily""'],
        { PATH: dir },
        { windowsVerbatimArguments: true },
      );
    });
  });

  it("names both runners when bun cannot start and npx fails without stderr", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(notStarted("codex", "ERR_INVALID_ARG_VALUE")))
      .mockReturnValueOnce(Effect.fail(exited("codex", 1)));

    const error = await ccusageErrorFor(
      execCcusage(["codex", "daily"], "codex", "daily", { platform: "linux", run }),
    );

    expect(error.code).toBe("command_failed");
    expect(ccusageRunDiagnostic(error)).toBe(
      "npx exited with code 1; tried first: bun could not be started (ERR_INVALID_ARG_VALUE)",
    );
  });

  it("reports a bun that cannot start, not a missing npx", async () => {
    await windowsPath(["bun.cmd"], async (dir) => {
      const run = vi.fn(() => Effect.fail(notStarted("codex", "EINVAL")));

      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: dir },
          platform: "win32",
          run,
        }),
      );

      expect(error.code).toBe("command_failed");
      expect(ccusageRunDiagnostic(error)).toBe("bun.cmd could not be started (EINVAL)");
      expect(run).toHaveBeenCalledOnce();
    });
  });

  it("does not mask a Bun execution failure with the npm fallback", async () => {
    await windowsPath(["bun.exe", "npx.cmd"], async (dir) => {
      const failedBun = exited("codex", 1, "error: ccusage blew up");
      const run = vi.fn(() => Effect.fail(failedBun));

      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: dir },
          platform: "win32",
          run,
        }),
      );
      expect(error.stderr).toBe("error: ccusage blew up");
      expect(error.runner).toBe("bun.exe");
      expect(run).toHaveBeenCalledOnce();
    });
  });

  it("classifies command timeouts without trying the npm fallback", async () => {
    const run = vi.fn(() => Effect.never);

    const error = await ccusageErrorFor(
      execCcusage(["codex", "daily"], "codex", "daily", {
        platform: "linux",
        run,
        timeoutMs: 1,
      }),
    );

    expect(error.code).toBe("command_timed_out");
    expect(error.report).toBe("daily");
    expect(error.runner).toBe("bun");
    expect(run).toHaveBeenCalledOnce();
  });

  it("points Oh My Pi's pi run at OMP's sessions on both the Bun and npm paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "tokenmaxxing-runner-omp-"));
    try {
      await mkdir(join(home, ".omp", "profiles", "work"), { recursive: true });
      const realHome = await realpath(home);
      const dirs = [
        join(realHome, ".omp", "agent", "sessions"),
        join(realHome, ".omp", "profiles", "work", "agent", "sessions"),
      ].join(",");
      const env = { HOME: home, PATH: "/usr/bin", PI_AGENT_DIR: "/data/pi-sessions" };
      const run = vi
        .fn()
        .mockReturnValueOnce(Effect.fail(missingBun("omp")))
        .mockReturnValueOnce(Effect.succeed('{"daily":[]}'));

      await expect(
        Effect.runPromise(
          runCcusageDailyReport(omp, {
            exec: { env, platform: "linux", run },
            since: "2026-09-10",
          }),
        ),
      ).resolves.toEqual({ daily: [] });
      const args = [
        "pi",
        "daily",
        "--json",
        "--breakdown",
        "--mode",
        "calculate",
        "--since",
        "20260910",
        "--pi-path",
        dirs,
      ];
      const ompEnv = { ...env, PI_AGENT_DIR: dirs };
      expect(run).toHaveBeenNthCalledWith(1, "bun", ["x", "ccusage@^20.0.22", ...args], ompEnv, {
        windowsVerbatimArguments: false,
      });
      expect(run).toHaveBeenNthCalledWith(2, "npx", ["-y", "ccusage@^20.0.22", ...args], ompEnv, {
        windowsVerbatimArguments: false,
      });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("reports no Oh My Pi usage instead of reading Pi's when no OMP dir can be passed", async () => {
    const run = vi.fn(() => Effect.succeed('{"daily":[{"date":"2026-09-10"}]}'));
    const exec = { env: { HOME: "/home/Smith, J" }, platform: "linux" as const, run };

    await expect(Effect.runPromise(runCcusageDailyReport(omp, { exec }))).resolves.toEqual({
      daily: [],
    });
    await expect(Effect.runPromise(runCcusageSessionReport(omp, { exec }))).resolves.toEqual({
      sessions: [],
    });
    expect(run).not.toHaveBeenCalled();
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
  // The timeout runs on a TestClock and fires only once the grandchild has
  // written its pid (renamed into place, so never half-written): on a loaded
  // machine a real 500 ms timeout could kill the fake bun before it started
  // anything, and there was no pid file to read.
  it("kills what ccusage started when it times out", { timeout: 30_000 }, async () => {
    const dir = await fakeBun(
      `sleep 30 &\necho $! > "$(dirname "$0")/grandchild.pid.tmp"\nmv "$(dirname "$0")/grandchild.pid.tmp" "$(dirname "$0")/grandchild.pid"\nwait`,
    );
    try {
      const { error, grandchild } = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* Effect.forkChild(
            Effect.flip(
              execCcusage(["codex", "daily"], "codex", "daily", {
                env: { PATH: `${dir}:/usr/bin:/bin` },
                timeoutMs: 500,
              }),
            ),
          );
          const grandchild = yield* Effect.promise(() =>
            vi.waitFor(
              () => {
                const pid = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
                expect(pid).toBeGreaterThan(0);
                return pid;
              },
              { interval: 20, timeout: 20_000 },
            ),
          );
          expect(isAlive(grandchild)).toBe(true);
          yield* TestClock.adjust("500 millis");
          return { error: yield* Fiber.join(run), grandchild };
        }).pipe(Effect.provide(TestClock.layer())),
      );

      expect(error.code).toBe("command_timed_out");
      await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), {
        interval: 20,
        timeout: 20_000,
      });
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
      // npx was tried too, since bun never ran, and refused the same environment.
      expect(ccusageRunDiagnostic(error)).toBe(
        "npx could not be started (ERR_INVALID_ARG_VALUE); tried first: bun could not be started (ERR_INVALID_ARG_VALUE)",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to npx when bun is there but cannot be started", async () => {
    const dir = await fakeBun(`echo '{"daily":[]}'`);
    try {
      await chmod(join(dir, "bun"), 0o644);
      await writeFile(join(dir, "npx"), `#!/bin/sh\necho '{"daily":["npx"]}'\n`, { mode: 0o755 });

      await expect(
        Effect.runPromise(
          execCcusage(["codex", "daily"], "codex", "daily", {
            env: { PATH: `${dir}:/usr/bin:/bin` },
          }),
        ),
      ).resolves.toBe('{"daily":["npx"]}\n');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("says how a runner ended when it printed nothing", async () => {
    const dir = await fakeBun(`exit 3`);
    try {
      const error = await ccusageErrorFor(
        execCcusage(["codex", "daily"], "codex", "daily", {
          env: { PATH: `${dir}:/usr/bin:/bin` },
        }),
      );

      expect(error.stderr).toBeUndefined();
      expect(ccusageRunDiagnostic(error)).toBe("bun exited with code 3");
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
