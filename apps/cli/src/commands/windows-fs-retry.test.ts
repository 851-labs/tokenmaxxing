import { describe, expect, it } from "vite-plus/test";

import { isTransientWindowsFsError, retryWindowsFs } from "./windows-fs-retry";

const fsError = (code: string) => Object.assign(new Error(`${code}: test`), { code });

// An operation that fails with each of `failures` in turn, then returns "done".
function flaky(failures: unknown[]) {
  let calls = 0;
  const operation = async () => {
    calls++;
    const failure = failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return "done";
  };
  return { calls: () => calls, operation };
}

describe("retryWindowsFs", () => {
  it("retries the codes a handle someone else holds gives, with a growing wait", async () => {
    const waits: number[] = [];
    const { calls, operation } = flaky([fsError("EBUSY"), fsError("EPERM"), fsError("EACCES")]);

    const result = await retryWindowsFs(operation, {
      platform: "win32",
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(result).toBe("done");
    expect(calls()).toBe(4);
    expect(waits).toEqual([100, 250, 500]);
  });

  it("gives up after five attempts over about 2 s with the last error", async () => {
    const waits: number[] = [];
    const last = fsError("ENOTEMPTY");
    const { calls, operation } = flaky([
      fsError("EBUSY"),
      fsError("EBUSY"),
      fsError("EBUSY"),
      fsError("EBUSY"),
      last,
      fsError("EBUSY"),
    ]);

    await expect(
      retryWindowsFs(operation, {
        platform: "win32",
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).rejects.toBe(last);
    expect(calls()).toBe(5);
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(2000);
  });

  it("fails at once on any other error", async () => {
    const missing = fsError("ENOENT");
    const { calls, operation } = flaky([missing]);

    await expect(
      retryWindowsFs(operation, {
        platform: "win32",
        sleep: async () => {
          throw new Error("should not wait");
        },
      }),
    ).rejects.toBe(missing);
    expect(calls()).toBe(1);
  });

  it("never retries outside Windows, where these codes are a real permission problem", async () => {
    const denied = fsError("EACCES");
    const { calls, operation } = flaky([denied]);

    await expect(
      retryWindowsFs(operation, {
        platform: "linux",
        sleep: async () => {
          throw new Error("should not wait");
        },
      }),
    ).rejects.toBe(denied);
    expect(calls()).toBe(1);
  });

  it("waits for real by default", async () => {
    const { operation } = flaky([fsError("EBUSY")]);
    const started = Date.now();

    expect(await retryWindowsFs(operation, { platform: "win32" })).toBe("done");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

describe("isTransientWindowsFsError", () => {
  it("knows the transient codes and nothing else", () => {
    for (const code of ["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]) {
      expect(isTransientWindowsFsError(fsError(code))).toBe(true);
    }
    for (const cause of [fsError("ENOENT"), fsError("EEXIST"), new Error("x"), null, "EBUSY"]) {
      expect(isTransientWindowsFsError(cause)).toBe(false);
    }
  });
});
