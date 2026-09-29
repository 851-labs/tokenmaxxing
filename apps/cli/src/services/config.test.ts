import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";
import { Cause, Exit, Option } from "effect";
import * as Effect from "effect/Effect";

import { ConfigReadError, readConfigProgram } from "./config";

describe("readConfigProgram", () => {
  it("migrates legacy production domains to tokenmaxxing.sh", async () => {
    const path = await tempConfigPath();
    await writeFile(
      path,
      `${JSON.stringify({
        apiUrl: "https://api.tokenmaxxing.851.sh",
        deviceId: "device_123",
        token: "tmx_123",
        wwwUrl: "https://tokenmaxxing.851.sh",
      })}\n`,
    );

    const config = await Effect.runPromise(readConfigProgram(path, {}));

    expect(config).toEqual({
      apiUrl: "https://api.tokenmaxxing.sh",
      deviceId: "device_123",
      token: "tmx_123",
      wwwUrl: "https://tokenmaxxing.sh",
    });
  });

  it("preserves custom non-legacy URLs", async () => {
    const path = await tempConfigPath();
    await writeFile(
      path,
      `${JSON.stringify({
        apiUrl: "https://api.example.test",
        wwwUrl: "https://www.example.test",
      })}\n`,
    );

    const config = await Effect.runPromise(readConfigProgram(path, {}));

    expect(config.apiUrl).toBe("https://api.example.test");
    expect(config.wwwUrl).toBe("https://www.example.test");
  });
});

describe("readConfigProgram with a damaged config.json", () => {
  // FAIL-5: these parsed as JSON, skipped validation, and crashed later as
  // "unexpected CLI failure" (null.apiUrl, baseUrl.replace is not a function).
  it.each([
    ["null", "null"],
    ["a number", "42"],
    ["an array", "[]"],
    ["a non-string apiUrl", '{"apiUrl":123}'],
    ["a non-string token", '{"token":{"x":1}}'],
    ["truncated JSON", '{"apiUrl":"https://api.tokenmaxxing.sh"'],
  ])("fails with a typed ConfigReadError for %s", async (_label, contents) => {
    const path = await tempConfigPath();
    await writeFile(path, contents);

    const exit = await Effect.runPromiseExit(readConfigProgram(path, {}));

    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(error).toBeInstanceOf(ConfigReadError);
    expect((error as ConfigReadError).message).toBe(
      `error: CLI config is not valid: ${path}\nhint: fix the file, or move it aside and run tokenmaxxing login`,
    );
  });

  it("keeps fields it does not know about", async () => {
    const path = await tempConfigPath();
    await writeFile(path, JSON.stringify({ deviceId: "device_123", futureField: { a: 1 } }));

    const config = await Effect.runPromise(readConfigProgram(path, {}));

    expect(config).toMatchObject({ deviceId: "device_123", futureField: { a: 1 } });
  });
});

async function tempConfigPath() {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-config-test-"));
  return join(dir, "config.json");
}
