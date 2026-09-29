/**
 * Shared plumbing for the TypeScript e2e suites (posix/, upgrade/): result
 * rows, process helpers, and the environment every suite runs in (the API
 * sandbox, the local registry, the fake `bun`, and the production block).
 *
 * Every check is one JSON line in <outDir>/results.jsonl, the same format the
 * Windows PowerShell suites write (windows/lib/common.ps1):
 *   { suite, scenario, check, status, detail }
 * status is PASS, FAIL or INFO. A check tied to a known issue records XFAIL
 * when it fails as expected and XPASS when it passes; XPASS fails the run so
 * the entry is removed together with the fix. summarize.ts renders the file.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "FAIL" | "INFO" | "PASS" | "XFAIL" | "XPASS";

interface ResultRow {
  check: string;
  detail: string;
  scenario: string;
  status: Status;
  suite: string;
}

interface RunResult {
  code: number;
  out: string;
  stderr: string;
  stdout: string;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  quiet?: boolean;
  timeoutMs?: number;
}

interface Build {
  mainDir: string;
  nativeDir: string;
  nativeExe: string;
  nativePackageName: string;
  target: string;
  version: string;
}

interface SandboxRequest {
  at: string;
  auth: string;
  method: string;
  path: string;
  status: number;
}

const isWindows = process.platform === "win32";
const repoDir = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const sharedDir = fileURLToPath(new URL(".", import.meta.url));
const exe = isWindows ? ".exe" : "";

// Hosts every suite blocks after setup: production, plus the public npm
// registries so no install, runner auto-update or `npx ccusage` fallback can
// pull a real release.
const BLOCKED_HOSTS = [
  "api.tokenmaxxing.sh",
  "tokenmaxxing.sh",
  "www.tokenmaxxing.sh",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
];
const HOSTS_MARKER = "# tokenmaxxing-e2e";

let resultsPath = "";
let logPath = "";
let suiteName = "";

function initE2E(outDir: string, suite: string) {
  mkdirSync(outDir, { recursive: true });
  resultsPath = join(outDir, "results.jsonl");
  logPath = join(outDir, `${suite}.log`);
  suiteName = suite;
}

function log(text: string) {
  appendFileSync(logPath, `${text}\n`);
  console.log(text);
}

function check(
  scenario: string,
  name: string,
  pass: boolean | "INFO",
  detail = "",
  options: { knownIssue?: string | undefined } = {},
): boolean {
  const status: Status =
    pass === "INFO"
      ? "INFO"
      : options.knownIssue
        ? pass
          ? "XPASS"
          : "XFAIL"
        : pass
          ? "PASS"
          : "FAIL";
  const row: ResultRow = {
    check: name,
    detail: options.knownIssue ? `[known issue ${options.knownIssue}] ${detail}` : detail,
    scenario,
    status,
    suite: suiteName,
  };
  appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  const line = `${status} [${scenario}] ${name} :: ${row.detail}`;
  if (status === "FAIL" || status === "XPASS") {
    console.log(`::error::${line.replace(/\r?\n/g, " ")}`);
  }
  appendFileSync(logPath, `${line}\n`);
  if (status !== "FAIL" && status !== "XPASS") {
    console.log(line);
  }
  return pass === true;
}

function readResults(path = resultsPath): ResultRow[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ResultRow);
}

function failedChecks(path = resultsPath): ResultRow[] {
  return readResults(path).filter((row) => row.status === "FAIL" || row.status === "XPASS");
}

/** Runs a scenario body; a throw records a FAIL and the next scenario still runs. */
async function scenario(name: string, body: () => Promise<void> | void) {
  console.log(`::group::${name}`);
  try {
    await body();
  } catch (error) {
    check(
      name,
      "scenario ran to completion",
      false,
      oneLine(error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error)),
    );
  } finally {
    console.log("::endgroup::");
  }
}

function oneLine(text: string | undefined, max = 600): string {
  // Control bytes (say, a binary printed as text) would garble the summary table.
  const flat = (text ?? "")
    .replace(/\r?\n/g, " | ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ".")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Runs a command to completion and logs its output. On Windows, `.cmd`
 * shims (npm, pnpm, yarn, the installed tokenmaxxing) go through cmd.exe,
 * since they cannot be spawned directly.
 */
function run(label: string, command: string, args: string[], options: RunOptions = {}): RunResult {
  const viaCmd = isWindows && !/\.(exe|com)$/i.test(command) && !isWindowsBuiltinExe(command);
  const argv = viaCmd
    ? [
        process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        ["/d", "/s", "/c", `"${[command, ...args].map(cmdArg).join(" ")}"`],
      ]
    : [command, args];
  const result = spawnSync(argv[0] as string, argv[1] as string[], {
    cwd: options.cwd,
    encoding: "utf8",
    env: cleanEnv(options.env ?? processEnv()),
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 5 * 60 * 1000,
    windowsHide: true,
    windowsVerbatimArguments: viaCmd,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const code = result.status ?? (result.error ? -1 : 1);
  const out = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.trim();
  const errorText = result.error ? ` (${result.error.message})` : "";
  appendFileSync(logPath, `---- ${label} (exit ${code}${errorText})\n${out}\n`);
  if (!options.quiet) {
    console.log(`---- ${label} (exit ${code}${errorText})\n${out}`);
  }
  return { code, out, stderr: stderr.trim(), stdout: stdout.trim() };
}

function isWindowsBuiltinExe(command: string): boolean {
  return ["cmd.exe", "schtasks", "ipconfig", "where", "powershell", "pwsh", "bun", "node"].includes(
    command.toLowerCase(),
  );
}

function cmdArg(value: string): string {
  return /[\s&()^%!'"<>|]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  // Windows env names are case-insensitive: keep one PATH (the upper-case one
  // the suites set), not also the inherited `Path`.
  return Object.fromEntries(
    isWindows && entries.some(([key]) => key === "PATH")
      ? entries.filter(([key]) => key === "PATH" || key.toUpperCase() !== "PATH")
      : entries,
  );
}

/**
 * process.env as a plain object with PATH under that exact name. On Windows
 * it is inherited as `Path`, and a spread copy loses the case-insensitive
 * lookup, so `env.PATH` would be undefined.
 */
function processEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  if (pathKey !== undefined && pathKey !== "PATH") {
    env.PATH = env[pathKey];
    delete env[pathKey];
  }
  return env;
}

async function sleep(ms: number) {
  await new Promise((done) => setTimeout(done, ms));
}

async function waitUntil<A>(
  probe: () => A | Promise<A>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<A | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return undefined;
}

async function waitHttp(url: string, timeoutMs = 60_000): Promise<boolean> {
  return (
    (await waitUntil(async () => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    }, timeoutMs)) === true
  );
}

/** A long-lived helper with stdout/stderr in <outDir>/<name>.{out,err}.log. */
function startBackground(
  outDir: string,
  name: string,
  cmd: string[],
  env: Record<string, string | undefined> = processEnv(),
) {
  const stdout = openSync(join(outDir, `${name}.out.log`), "a");
  const stderr = openSync(join(outDir, `${name}.err.log`), "a");
  const child = Bun.spawn(cmd, { env: cleanEnv(env), stderr, stdin: "ignore", stdout });
  closeSync(stdout);
  closeSync(stderr);
  return child;
}

function readJson<A = Record<string, unknown>>(path: string): A | null {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as A;
  } catch {
    return null;
  }
}

/** The JSON object in a CLI's output (clack frames and npm noise may surround it). */
function parseCliJson<A = Record<string, unknown>>(text: string): A | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed) as A;
      } catch {
        continue;
      }
    }
  }
  const start = text.indexOf("{");
  try {
    return start < 0 ? null : (JSON.parse(text.slice(start)) as A);
  } catch {
    return null;
  }
}

/** These suites edit the hosts file, register schedulers and install global packages. */
function assertDisposableMachine(force: boolean) {
  if (process.env.CI !== "true" && !force) {
    throw new Error(
      "The CLI e2e changes machine state (scheduler registrations, the hosts file, global packages). Run it on a disposable VM with --force, or in CI.",
    );
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (value === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function readBuild(buildJson: string): Build {
  const build = readJson<Build>(buildJson);
  if (build === null || !build.version) {
    throw new Error(`no version in ${buildJson}`);
  }
  return build;
}

// ------------------------------------------------------------------ environment

/** Compiles the fake `bun` (and copies the fake ccusage) into `dir`; returns `dir`. */
/**
 * The fake `bun` scheduled runs find first on PATH. On macOS/Linux it is a
 * shell script that execs node in place, like real `bun x`; Windows has no
 * exec, so there it is fake-bun.ts compiled to bun.exe.
 */
function buildFakeBin(dir: string): string {
  mkdirSync(dir, { recursive: true });
  if (isWindows) {
    // From `dir`: --compile leaves a `.bun-build` temp copy of bun in its cwd.
    const build = run(
      "bun build --compile fake-bun",
      "bun",
      [
        "build",
        "--compile",
        join(sharedDir, "fakes", "fake-bun.ts"),
        "--outfile",
        join(dir, `bun${exe}`),
      ],
      { cwd: dir },
    );
    if (build.code !== 0) {
      throw new Error("could not compile the fake bun");
    }
  } else {
    copyFileSync(join(sharedDir, "fakes", "fake-bun.sh"), join(dir, "bun"));
    chmodSync(join(dir, "bun"), 0o755);
  }
  copyFileSync(join(sharedDir, "fakes", "fake-ccusage.mjs"), join(dir, "fake-ccusage.mjs"));
  return dir;
}

class Sandbox {
  constructor(
    readonly url: string,
    readonly process: ReturnType<typeof startBackground>,
  ) {}

  async requests(): Promise<SandboxRequest[]> {
    const body = (await (await fetch(`${this.url}/__sandbox/requests`)).json()) as {
      requests: SandboxRequest[];
    };
    return body.requests;
  }

  async usageRows(userId: string): Promise<{ date: string; source: string }[]> {
    const body = (await (await fetch(`${this.url}/__sandbox/usage?userId=${userId}`)).json()) as {
      rows: { date: string; source: string }[];
    };
    return body.rows;
  }

  async revoke(userId: string, revoked: boolean) {
    await fetch(`${this.url}/__sandbox/revoke`, {
      body: JSON.stringify({ revoked, userId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  /**
   * Writes <configDir>/config.json with a freshly minted sandbox CLI token.
   * The deviceId is picked so a scheduled run's deterministic jitter (up to
   * 60 s, keyed by it) stays within [minJitterMs, maxJitterMs].
   */
  async mintProfile(
    configDir: string,
    options: { maxJitterMs?: number; minJitterMs?: number } = {},
  ): Promise<{ deviceId: string; jitterMs: number; login: string; userId: string }> {
    const { deterministicServiceJitterMs } = await import("../../src/commands/service");
    let deviceId: string;
    let jitterMs: number;
    do {
      deviceId = crypto.randomUUID();
      jitterMs = deterministicServiceJitterMs(deviceId);
    } while (jitterMs < (options.minJitterMs ?? 0) || jitterMs > (options.maxJitterMs ?? 3000));
    const minted = (await (
      await fetch(`${this.url}/__sandbox/cli-token`, {
        body: JSON.stringify({ deviceId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as { login: string; token: string; userId: string };
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify({ apiUrl: this.url, deviceId, token: minted.token, wwwUrl: this.url }, null, 2)}\n`,
    );
    return { deviceId, jitterMs, login: minted.login, userId: minted.userId };
  }
}

async function startSandbox(outDir: string, port = 8799): Promise<Sandbox> {
  const url = `http://127.0.0.1:${port}`;
  const child = startBackground(outDir, "sandbox", [
    "bun",
    join(repoDir, "apps", "api", "script", "sandbox-server.ts"),
    "--port",
    String(port),
  ]);
  if (!(await waitHttp(`${url}/__sandbox/health`, 120_000))) {
    throw new Error("the API sandbox did not start; see sandbox.err.log");
  }
  return new Sandbox(url, child);
}

class Registry {
  constructor(
    readonly url: string,
    readonly process: ReturnType<typeof startBackground>,
  ) {}

  async setState(state: {
    distTags?: Record<string, string | null>;
    mode?: "down" | "metadata-down" | "ok";
    packument?: {
      distTags: Record<string, string>;
      hiddenVersions: string[];
      name: string;
    } | null;
    packumentMaxAge?: number | null;
  }) {
    const response = await fetch(`${this.url}/-/e2e/state`, {
      body: JSON.stringify(state),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return (await response.json()) as Record<string, unknown>;
  }

  async requests(): Promise<{ method: string; path: string; status: number }[]> {
    const body = (await (await fetch(`${this.url}/-/e2e/requests`)).json()) as {
      requests: { method: string; path: string; status: number }[];
    };
    return body.requests;
  }
}

/** Packs the package directories with npm and serves them from registry-server.ts. */
async function startRegistry(
  outDir: string,
  root: string,
  packageDirs: string[],
  options: { distTags?: Record<string, string>; port?: number } = {},
): Promise<Registry> {
  const port = options.port ?? 4873;
  const url = `http://127.0.0.1:${port}`;
  const tarballDir = join(root, "registry");
  mkdirSync(tarballDir, { recursive: true });
  const tarballs = packageDirs.map((dir) => {
    const packed = run(
      `npm pack ${dir}`,
      npmCommand(),
      ["pack", dir, "--json", "--ignore-scripts", "--pack-destination", tarballDir],
      { quiet: true },
    );
    const filename = parseNpmPackJson(packed.stdout);
    if (packed.code !== 0 || filename === null) {
      throw new Error(`npm pack ${dir} failed: ${oneLine(packed.out)}`);
    }
    return join(tarballDir, filename);
  });
  const distTagArgs = Object.entries(options.distTags ?? {}).flatMap(([tag, version]) => [
    "--dist-tag",
    `${tag}=${version}`,
  ]);
  const child = startBackground(outDir, "registry", [
    "bun",
    join(sharedDir, "registry-server.ts"),
    "--port",
    String(port),
    ...distTagArgs,
    ...tarballs,
  ]);
  if (!(await waitHttp(`${url}/-/ping`, 60_000))) {
    throw new Error("the e2e registry did not start; see registry.err.log");
  }
  return new Registry(url, child);
}

function parseNpmPackJson(stdout: string): string | null {
  const start = stdout.indexOf("[");
  try {
    return (JSON.parse(stdout.slice(start)) as { filename: string }[])[0]?.filename ?? null;
  } catch {
    return null;
  }
}

function npmCommand(): string {
  return isWindows ? "npm.cmd" : "npm";
}

/**
 * Sends production and the public npm registries to 0.0.0.0 through the
 * hosts file, then records a check per host that it is unreachable.
 */
async function blockProduction(scenarioName = "setup"): Promise<void> {
  const lines = BLOCKED_HOSTS.map((host) => `0.0.0.0 ${host} ${HOSTS_MARKER}`);
  if (isWindows) {
    const hostsPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\drivers\\etc\\hosts`;
    appendFileSync(hostsPath, `\r\n${lines.join("\r\n")}\r\n`);
    run("ipconfig /flushdns", "ipconfig", ["/flushdns"], { quiet: true });
  } else {
    const append = run("append to /etc/hosts", "sudo", [
      "sh",
      "-c",
      `printf '\\n%s\\n' "$1" >> /etc/hosts`,
      "sh",
      lines.join("\n"),
    ]);
    if (append.code !== 0) {
      throw new Error(`could not edit /etc/hosts: ${oneLine(append.out)}`);
    }
    if (process.platform === "darwin") {
      run("flush DNS", "sudo", ["dscacheutil", "-flushcache"], { quiet: true });
      run("restart mDNSResponder", "sudo", ["killall", "-HUP", "mDNSResponder"], { quiet: true });
    } else {
      run("flush DNS", "sudo", ["resolvectl", "flush-caches"], { quiet: true });
    }
  }
  for (const host of BLOCKED_HOSTS) {
    const probe = await probeUnreachable(`https://${host}/`);
    check(scenarioName, `${host} is unreachable`, probe.blocked, probe.detail);
  }
}

async function probeUnreachable(url: string): Promise<{ blocked: boolean; detail: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return { blocked: false, detail: `reached: HTTP ${response.status}` };
  } catch (error) {
    const code = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    return { blocked: true, detail: `blocked: ${code}` };
  }
}

/** Cleanup outside CI: removes our hosts lines again. */
function unblockProduction() {
  if (process.env.CI === "true") {
    return;
  }
  const hostsPath = isWindows
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\drivers\\etc\\hosts`
    : "/etc/hosts";
  const kept = readFileSync(hostsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.includes(HOSTS_MARKER))
    .join(isWindows ? "\r\n" : "\n");
  if (isWindows) {
    writeFileSync(hostsPath, kept);
  } else {
    spawnSync("sudo", ["sh", "-c", `cat > /etc/hosts`], { input: kept });
  }
}

/**
 * Downloads a pinned release of a runner package from registry.npmjs.org
 * (before the block) and lays it out like a global install:
 * <root>/node_modules/@851-labs/tokenmaxxing/bin/tokenmaxxing(.exe) with the
 * runner package nested beside it, which is where the CLI looks for it.
 * Returns the bin directory, or null.
 */
function fetchLegacyRelease(root: string, nativePackageName: string, version: string) {
  const downloads = join(root, "legacy-download");
  mkdirSync(downloads, { recursive: true });
  const spec = `${nativePackageName}@${version}`;
  const pack = run(`npm pack ${spec}`, npmCommand(), [
    "pack",
    spec,
    "--pack-destination",
    downloads,
    "--registry",
    "https://registry.npmjs.org/",
  ]);
  const tarball = pack.code === 0 ? parseLastLine(pack.stdout) : null;
  if (tarball === null) {
    return { bin: null, detail: oneLine(pack.out, 300) };
  }
  const layout = join(root, "legacy-install", "node_modules", "@851-labs", "tokenmaxxing");
  const nested = join(layout, "node_modules", nativePackageName);
  mkdirSync(join(layout, "bin"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  run("extract legacy runner", "tar", [
    "-xzf",
    join(downloads, tarball),
    "-C",
    nested,
    "--strip-components",
    "1",
  ]);
  const binary = `tokenmaxxing${exe}`;
  copyFileSync(join(nested, "bin", binary), join(layout, "bin", binary));
  if (!isWindows) {
    run("chmod legacy runner", "chmod", ["755", join(layout, "bin", binary)], { quiet: true });
  }
  return { bin: join(layout, "bin"), detail: oneLine(pack.out, 300) };
}

function parseLastLine(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().endsWith(".tgz"));
  return lines.at(-1)?.trim() ?? null;
}

/** Copies a file into <outDir>, ignoring a missing source. */
function keep(outDir: string, source: string, name: string) {
  try {
    mkdirSync(dirname(join(outDir, name)), { recursive: true });
    copyFileSync(source, join(outDir, name));
  } catch {
    // Missing is fine; the checks already say why.
  }
}

export {
  assertDisposableMachine,
  blockProduction,
  buildFakeBin,
  check,
  failedChecks,
  fetchLegacyRelease,
  flag,
  initE2E,
  isWindows,
  keep,
  log,
  npmCommand,
  oneLine,
  parseCliJson,
  processEnv,
  readBuild,
  readJson,
  readResults,
  Registry,
  repoDir,
  requiredFlag,
  run,
  Sandbox,
  scenario,
  sleep,
  startBackground,
  startRegistry,
  startSandbox,
  unblockProduction,
  waitHttp,
  waitUntil,
};
export type { Build, ResultRow, RunResult, SandboxRequest };
