import { describe, expect, it } from "vite-plus/test";

import { defaultCliArgv, normalizeRootVersionArgv } from "./entrypoint";

describe("defaultCliArgv", () => {
  it("uses Node-style argv when argv[1] is a script path", () => {
    expect(defaultCliArgv(["node", "/app/dist/index.js", "--version"])).toEqual(["--version"]);
  });

  it("uses Bun standalone argv when argv[1] is already a CLI flag", () => {
    expect(defaultCliArgv(["tokenmaxxing.exe", "--version"])).toEqual(["--version"]);
  });

  it("uses Bun standalone argv when argv[1] is already a subcommand", () => {
    expect(defaultCliArgv(["tokenmaxxing.exe", "bootstrap", "--service", "yes"])).toEqual([
      "bootstrap",
      "--service",
      "yes",
    ]);
  });
});

describe("normalizeRootVersionArgv", () => {
  it("maps root -v to --version", () => {
    expect(normalizeRootVersionArgv(["-v"])).toEqual(["--version"]);
  });
});
