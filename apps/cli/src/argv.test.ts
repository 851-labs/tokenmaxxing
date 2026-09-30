import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

/**
 * Runs the real entrypoint (src/index.ts) in a subprocess, so argv goes
 * through the actual effect/cli parser and exit codes are the real ones.
 * Command-level tests call the effects directly and never see flag parsing,
 * which is how every boolean flag silently became required in rc.117.
 *
 * Each run is hermetic: a fresh config dir and HOME, an unreachable API, and
 * PATH limited to stubs — a fake `bun`/`npx` answering ccusage, and failing
 * stand-ins for the scheduler and browser tools — plus /usr/bin:/bin.
 */

const cliRoot = resolve(import.meta.dirname, "..");
const scratchRoots: string[] = [];

// Answers `bun x ccusage@<version> <source> <daily|session> …` (and the npx
// fallback, whose argv has the same shape).
const FAKE_CCUSAGE = `#!/bin/sh
echo "$*" >> "$FAKE_CALLS_LOG"
source="$3"
report="$4"
if [ "$FAKE_CCUSAGE" = slow ]; then
  # Like bun x running ccusage's node bin: exec in place, so this pid is ccusage.
  echo $$ > "$FAKE_CALLS_LOG.pid"
  exec sleep 30
fi
if [ "$FAKE_CCUSAGE" = fail ] || { [ "$FAKE_CCUSAGE" = partial ] && [ "$source" = codex ]; }; then
  echo "fake ccusage failure" >&2
  exit 1
fi
if [ "$report" = session ]; then
  echo '{"sessions":[]}'
elif [ "$FAKE_CCUSAGE" = partial ] && [ "$source" = claude ]; then
  echo '{"daily":[{"date":"2026-09-01","totalTokens":10}]}'
else
  echo '{"daily":[]}'
fi
`;

const BLOCKED_TOOL = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_CALLS_LOG"
exit 1
`;

interface CliRun {
  calls: string[];
  configDir: string;
  status: number | null;
  stderr: string;
  stdout: string;
}

function bunPath() {
  return execFileSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
    encoding: "utf8",
  });
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "tokenmaxxing-argv-"));
  scratchRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "config"));

  for (const name of ["bun", "npx"]) {
    writeFileSync(join(bin, name), FAKE_CCUSAGE);
  }
  for (const name of [
    "launchctl",
    "npm",
    "open",
    "pnpm",
    "schtasks",
    "systemctl",
    "xdg-open",
    "yarn",
  ]) {
    writeFileSync(join(bin, name), BLOCKED_TOOL);
  }
  for (const name of readdirSync(bin)) {
    chmodSync(join(bin, name), 0o755);
  }

  return root;
}

const bun = process.platform === "win32" ? "" : bunPath();

interface RunCliOptions {
  /** "missing": no bun or npx on PATH at all. "slow": ccusage runs for 30 s. */
  ccusage?: "empty" | "fail" | "missing" | "partial" | "slow";
  env?: Record<string, string>;
  serviceState?: Record<string, unknown>;
  /** Runs against the sandbox root before the CLI starts. */
  setup?: (root: string) => void;
}

function runCli(args: readonly string[], options: RunCliOptions = {}) {
  const root = makeSandbox();
  options.setup?.(root);
  if (options.ccusage === "missing") {
    rmSync(join(root, "bin", "bun"));
    rmSync(join(root, "bin", "npx"));
  }
  const configDir = join(root, "config");
  const callsLog = join(root, "calls.log");
  if (options.serviceState !== undefined) {
    writeFileSync(join(configDir, "service-state.json"), JSON.stringify(options.serviceState));
  }

  return new Promise<CliRun>((resolvePromise) => {
    execFile(
      bun,
      ["src/index.ts", ...args],
      {
        cwd: cliRoot,
        encoding: "utf8",
        env: cliEnv(root, options),
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          calls: existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n") : [],
          configDir,
          status: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          stderr,
          stdout,
        });
      },
    );
  });
}

function cliEnv(root: string, options: RunCliOptions): Record<string, string> {
  return {
    CI: "true",
    FAKE_CALLS_LOG: join(root, "calls.log"),
    FAKE_CCUSAGE: options.ccusage ?? "empty",
    HOME: join(root, "home"),
    NO_COLOR: "1",
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    TOKENMAXXING_API_URL: "http://127.0.0.1:9",
    TOKENMAXXING_CONFIG_DIR: join(root, "config"),
    TOKENMAXXING_WWW_URL: "http://127.0.0.1:9",
    ...options.env,
  };
}

/**
 * Starts `sync` with a ccusage that hangs, sends `signal` once ccusage is
 * running, and reports how the CLI exited and whether ccusage outlived it.
 */
async function interruptSync(signal: NodeJS.Signals) {
  const root = makeSandbox();
  const pidFile = join(root, "calls.log.pid");
  const child = spawn(bun, ["src/index.ts", "sync", "--dry-run", "--sources", "claude"], {
    cwd: cliRoot,
    env: cliEnv(root, { ccusage: "slow" }),
    stdio: "ignore",
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.on("exit", (code, exitSignal) => done({ code, signal: exitSignal })),
  );
  const ccusagePid = await waitFor(() =>
    existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || undefined : undefined,
  );
  child.kill(signal);
  const exit = await exited;
  const ccusageAlive = await waitFor(() => (isAlive(ccusagePid) ? undefined : false), 2_000).catch(
    () => true,
  );
  if (ccusageAlive) {
    process.kill(ccusagePid, "SIGKILL");
  }

  return { ccusageAlive, ...exit };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readServiceState(run: CliRun): Record<string, unknown> {
  return JSON.parse(readFileSync(join(run.configDir, "service-state.json"), "utf8"));
}

function localDateKey(daysAgo: number): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function expectParsed(run: CliRun) {
  const output = `${run.stdout}${run.stderr}`;
  expect(output).not.toContain("Missing required");
  expect(output).not.toContain("USAGE");
}

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32").concurrent("CLI argv parsing", () => {
  it.each([
    { args: ["whoami"], output: "error: not logged in", status: 1 },
    { args: ["logout"], output: "Not logged in; nothing to do", status: 0 },
    {
      args: ["login"],
      output: "error: cannot run browser login without an interactive terminal",
      status: 1,
    },
    { args: ["upgrade"], output: "error: tokenmaxxing is not installed globally", status: 1 },
    { args: ["bootstrap"], output: "bootstrap needs a service decision", status: 1 },
    { args: ["sync", "--dry-run"], output: "Nothing to sync", status: 0 },
    { args: ["service", "status"], output: "Log:", status: 0 },
    // Nothing is installed in the sandbox: a FAIL check, so doctor exits 1.
    { args: ["service", "doctor"], output: "last success never", status: 1 },
    { args: ["service", "uninstall"], output: "Automatic sync uninstalled", status: 0 },
    { args: ["service", "run"], output: "error: tokenmaxxing service run failed", status: 1 },
  ])("runs `$args` with its boolean flags omitted", { timeout: 30_000 }, async (testCase) => {
    const run = await runCli(testCase.args);

    expectParsed(run);
    expect(`${run.stdout}${run.stderr}`).toContain(testCase.output);
    expect(run.status).toBe(testCase.status);
  });

  it(
    "runs the launchd/systemd job argv, `service run --scheduled`",
    { timeout: 30_000 },
    async () => {
      const run = await runCli(["service", "run", "--scheduled"]);

      expectParsed(run);
      // Reaching the handler is what matters: it records the (logged-out) attempt.
      expect(run.stdout).toContain('"event":"service_run"');
      expect(existsSync(join(run.configDir, "service-state.json"))).toBe(true);
    },
  );

  // The Windows wrapper logs whatever the runner prints; a skip that printed
  // nothing looked like a run that never started.
  it(
    "logs a scheduled run that finds another run holding the lock",
    { timeout: 30_000 },
    async () => {
      const lockedAt = new Date().toISOString();
      const run = await runCli(["service", "run", "--scheduled"], {
        setup: (root) =>
          writeFileSync(
            join(root, "config", "service.lock"),
            JSON.stringify({
              acquiredAt: lockedAt,
              hostname: hostname(),
              ownerId: "other-run",
              pid: process.pid,
              version: 1,
            }),
          ),
      });

      expectParsed(run);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toMatchObject({
        event: "service_run",
        message: `Sync skipped; service run is already in progress (since ${lockedAt}, pid ${process.pid})`,
        reason: "locked",
        status: "skipped",
      });
      expect(existsSync(join(run.configDir, "service-state.json"))).toBe(false);
    },
  );

  // Logged out, the run fails at auth, but the window it would have synced is
  // already recorded as lastSince.
  it(
    "re-sends a trailing window on the first scheduled run after upgrading",
    { timeout: 30_000 },
    async () => {
      const run = await runCli(["service", "run", "--scheduled"], {
        serviceState: {
          lastSuccessAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          usageReplacementBackfillVersion: 1,
          version: 1,
        },
      });

      expectParsed(run);
      expect(readServiceState(run)).toMatchObject({ lastSince: localDateKey(20) });
    },
  );

  it("honours TOKENMAXXING_SYNC_WINDOW_DAYS for scheduled runs", { timeout: 30_000 }, async () => {
    const run = await runCli(["service", "run", "--scheduled"], {
      env: { TOKENMAXXING_SYNC_WINDOW_DAYS: "7" },
      serviceState: { usageReplacementBackfillVersion: 1, version: 1 },
    });

    expectParsed(run);
    expect(readServiceState(run)).toMatchObject({ lastSince: localDateKey(6) });
  });

  it("syncs incrementally between reconciliations", { timeout: 30_000 }, async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const run = await runCli(["service", "run", "--scheduled"], {
      serviceState: {
        lastReconcileAt: recent,
        lastSuccessAt: new Date().toISOString(),
        usageReplacementBackfillVersion: 1,
        version: 1,
      },
    });

    expectParsed(run);
    expect(readServiceState(run)).toMatchObject({
      lastReconcileAt: recent,
      lastSince: localDateKey(0),
    });
  });

  it("still honours explicit boolean flags", { timeout: 30_000 }, async () => {
    const run = await runCli(["--verbose", "whoami", "--json"]);

    expectParsed(run);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stderr.split("\n")[0] ?? "")).toMatchObject({
      error: { code: "not_logged_in" },
      status: "error",
    });
  });

  it("exits non-zero when every source fails", { timeout: 30_000 }, async () => {
    const run = await runCli(["sync", "--dry-run"], {
      ccusage: "fail",
      setup: (root) => {
        const projects = join(root, "home", ".claude", "projects", "app");
        mkdirSync(projects, { recursive: true });
        writeFileSync(join(projects, "session.jsonl"), "{}\n");
      },
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^claude +failed/m);
    // Only claude has logs; the other 17 agents failed too but are counted.
    expect(run.stderr).toContain(
      "error: no usage synced; ccusage failed for claude and 17 agents without logs\nclaude and 17 agents without logs: ccusage command failed: fake ccusage failure",
    );
  });

  it(
    "service doctor exits 1 on a FAIL check, with the verdict in --json",
    { timeout: 30_000 },
    async () => {
      const run = await runCli(["service", "doctor", "--json"]);

      expectParsed(run);
      expect(run.status).toBe(1);
      const report = JSON.parse(run.stdout) as {
        checks: Array<{ fix?: string; label: string; status: string }>;
        health: string;
        status: string;
      };
      expect(report).toMatchObject({ health: "fail", status: "ok" });
      expect(report.checks.find((check) => check.label === "scheduler")).toMatchObject({
        fix: "install with tokenmaxxing service install",
        status: "fail",
      });
      expect(JSON.parse(run.stderr.split("\n")[0] ?? "")).toMatchObject({
        error: { code: "service_doctor_problems", health: "fail" },
        status: "error",
      });
    },
  );

  // Only meaningful where no real bun/npx sits in /usr/bin or /bin, which stay on PATH.
  it.skipIf(["/usr/bin/bun", "/usr/bin/npx", "/bin/bun", "/bin/npx"].some(existsSync))(
    "says ccusage cannot run when neither bun nor npx is installed",
    { timeout: 30_000 },
    async () => {
      const run = await runCli(["sync", "--dry-run", "--sources", "claude,codex"], {
        ccusage: "missing",
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "error: no usage synced; could not run ccusage: neither bun nor npx is on PATH",
      );
      expect(run.stderr).toContain("install Bun (https://bun.sh) or Node.js");
    },
  );

  // FAIL-2 / FAIL-3: SIGTERM exited 130, and SIGHUP killed the CLI by default
  // action and left the ccusage child running.
  it.each([
    { expected: 129, signal: "SIGHUP" as const },
    { expected: 130, signal: "SIGINT" as const },
    { expected: 143, signal: "SIGTERM" as const },
  ])(
    "exits $expected on $signal and stops the running ccusage",
    { timeout: 30_000 },
    async ({ expected, signal }) => {
      const result = await interruptSync(signal);

      expect(result).toEqual({ ccusageAlive: false, code: expected, signal: null });
    },
  );

  // W2 (F5): repair from a shell without the service's TOKENMAXXING_CONFIG_DIR
  // installed a service in the default config dir and took the scheduler over.
  it("refuses to repair when no service is installed here", { timeout: 30_000 }, async () => {
    const run = await runCli(["service", "repair"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`no tokenmaxxing service is installed for ${run.configDir}`);
    // Only the read-only scheduler status query ran; nothing was (re)registered.
    expect(
      run.calls.filter((call) => /bootstrap|enable|daemon-reload|\/Create/.test(call)),
    ).toEqual([]);
    expect(readdirSync(run.configDir)).not.toContain("service.json");
  });

  it(
    "refuses to repair a service that another config dir installed",
    { timeout: 30_000 },
    async () => {
      const other = "/Users/someone/other-config/tokenmaxxing.sh";
      const run = await runCli(["service", "repair", "--json"], {
        setup: (root) => {
          const definition =
            process.platform === "darwin"
              ? join(root, "home", "Library", "LaunchAgents", "sh.tokenmaxxing.sync.plist")
              : join(root, "home", ".config", "systemd", "user", "tokenmaxxing-sync.service");
          mkdirSync(join(definition, ".."), { recursive: true });
          writeFileSync(definition, `ProgramArguments ${other}\nExecStart="${other}"\n`);
        },
      });

      expect(run.status).toBe(1);
      expect(JSON.parse(run.stderr)).toMatchObject({
        error: { code: "service_owned_elsewhere" },
        status: "error",
      });
    },
  );

  it("keeps the --json payload when every source fails", { timeout: 30_000 }, async () => {
    const run = await runCli(["sync", "--dry-run", "--json"], { ccusage: "fail" });

    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ dryRun: true, rows: 0, status: "error" });
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: { code: "sync_sources_failed" },
      status: "error",
    });
  });

  it(
    "exits zero on a partial sync and reports the failed source",
    { timeout: 30_000 },
    async () => {
      const run = await runCli(["sync", "--dry-run", "--json"], { ccusage: "partial" });

      expect(run.status).toBe(0);
      const payload = JSON.parse(run.stdout) as { sourceResults: unknown[] };
      expect(payload).toMatchObject({ rows: 1, status: "partial" });
      expect(payload.sourceResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "claude", status: "synced" }),
          expect.objectContaining({ source: "codex", status: "failed" }),
        ]),
      );
    },
  );

  it.each(["2026-13-01", "2026-02-29", "yesterday", "20260101"])(
    "rejects --since %s before running ccusage",
    { timeout: 30_000 },
    async (since) => {
      const run = await runCli(["sync", "--dry-run", "--since", since]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`error: invalid --since date: ${since}`);
      expect(run.stderr).toContain("YYYY-MM-DD");
      expect(run.calls).toEqual([]);
    },
  );

  it("passes a valid --since through to ccusage", { timeout: 30_000 }, async () => {
    const run = await runCli(["sync", "--dry-run", "--since", "2024-02-29"]);

    expect(run.status).toBe(0);
    expect(run.calls).toEqual(
      expect.arrayContaining([expect.stringMatching(/ claude daily .*--since 20240229$/)]),
    );
  });
});

describe("boolean flags", () => {
  it("are all built with booleanFlag, which defaults to false", () => {
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(path);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          entry.name !== "flags.ts" &&
          /Flag\.Boolean\(/.test(readFileSync(path, "utf8"))
        ) {
          offenders.push(path);
        }
      }
    };
    visit(resolve(cliRoot, "src"));

    expect(offenders).toEqual([]);
  });
});
