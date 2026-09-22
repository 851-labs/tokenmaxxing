import { execFile, execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
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

function runCli(args: readonly string[], options: { ccusage?: "empty" | "fail" | "partial" } = {}) {
  const root = makeSandbox();
  const configDir = join(root, "config");
  const callsLog = join(root, "calls.log");

  return new Promise<CliRun>((resolvePromise) => {
    execFile(
      bun,
      ["src/index.ts", ...args],
      {
        cwd: cliRoot,
        encoding: "utf8",
        env: {
          CI: "true",
          FAKE_CALLS_LOG: callsLog,
          FAKE_CCUSAGE: options.ccusage ?? "empty",
          HOME: join(root, "home"),
          NO_COLOR: "1",
          PATH: `${join(root, "bin")}:/usr/bin:/bin`,
          TOKENMAXXING_API_URL: "http://127.0.0.1:9",
          TOKENMAXXING_CONFIG_DIR: configDir,
          TOKENMAXXING_WWW_URL: "http://127.0.0.1:9",
        },
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
    { args: ["service", "doctor"], output: "last success never", status: 0 },
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
    const run = await runCli(["sync", "--dry-run"], { ccusage: "fail" });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("claude    failed");
    expect(run.stderr).toContain("error: no usage synced; ccusage failed for claude, codex");
  });

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
