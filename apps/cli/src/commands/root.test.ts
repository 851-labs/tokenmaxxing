import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const cliRoot = resolve(import.meta.dirname, "../..");
const jsonHelpCommands = [
  ["upgrade", "--help"],
  ["service", "install", "--help"],
  ["service", "uninstall", "--help"],
  ["service", "status", "--help"],
  ["service", "doctor", "--help"],
  ["service", "repair", "--help"],
  ["service", "run", "--help"],
].map((args) => [args.join(" "), args] as const);

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

  it.each(jsonHelpCommands)("exposes --json on %s", (_name, args) => {
    const result = runCli(args);

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

export {};
