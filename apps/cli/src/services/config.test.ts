import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { readConfigProgram } from "./config";

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

async function tempConfigPath() {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-config-test-"));
  return join(dir, "config.json");
}
