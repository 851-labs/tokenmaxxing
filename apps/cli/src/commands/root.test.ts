import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const cliRoot = resolve(import.meta.dirname, "../..");

function runCli(args: readonly string[]) {
  const result = spawnSync("bun", ["src/index.ts", ...args], {
    cwd: cliRoot,
    encoding: "utf8",
  });

  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}

describe("root command", () => {
  it("lists upgrade but not update", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      "bootstrap    Log in, sync usage, and optionally install automatic sync",
    );
    expect(result.output).toContain("upgrade      Upgrade the globally installed CLI");
    expect(result.output).not.toContain("update     Update the globally installed CLI");
  });

  it("rejects update as an unknown subcommand", () => {
    const result = runCli(["update"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Unknown subcommand "update"');
    expect(result.output).toContain("upgrade      Upgrade the globally installed CLI");
  });

  // One spawn per test: seven CLI starts in a single test ran past the 5 s
  // default when the whole suite loads the machine.
  it.each([
    "upgrade",
    "service install",
    "service uninstall",
    "service status",
    "service doctor",
    "service repair",
    "service run",
  ])("exposes --json on %s", (command) => {
    const result = runCli([...command.split(" "), "--help"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("--json");
  });

  it("exposes bootstrap as a human-only onboarding command", () => {
    const result = runCli(["bootstrap", "--help"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("--service");
    expect(result.output).toContain("Whether to install automatic sync");
    expect(result.output).not.toContain("--json");
  });
});
