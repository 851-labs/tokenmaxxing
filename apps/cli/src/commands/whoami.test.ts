import { Effect, Layer } from "effect";
import { UserId, type AuthUser } from "@tokenmaxxing/api-contract";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeStubApiClient, type StubResponse } from "../testing/stub-api-client";
import {
  ApiClientService,
  type CliConfig,
  ClockService,
  ConfigService,
  ConsoleService,
  type TokenmaxxingApiClient,
} from "../services";
import { whoamiEffect } from "./whoami";

const promptCalls = vi.hoisted((): string[] => []);

vi.mock("@clack/prompts", () => ({
  intro: (title: string) => {
    promptCalls.push(`intro:${title}`);
  },
  log: {
    info: (message: string) => {
      promptCalls.push(`info:${message}`);
    },
  },
  outro: (message: string) => {
    promptCalls.push(`outro:${message}`);
  },
  spinner: () => ({
    error: (message?: string) => {
      promptCalls.push(`spinner-error:${message ?? ""}`);
    },
    start: (message: string) => {
      promptCalls.push(`spinner-start:${message}`);
    },
    stop: (message?: string) => {
      promptCalls.push(`spinner-stop:${message ?? ""}`);
    },
  }),
}));

const originalStdoutIsTty = process.stdout.isTTY;
const originalStderrIsTty = process.stderr.isTTY;
const originalCi = process.env.CI;
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

const user: AuthUser = {
  avatarUrl: null,
  id: UserId.make("user_123"),
  login: "alex",
  name: "Alex",
};

const config: CliConfig = {
  apiUrl: "https://api.tokenmaxxing.test",
  token: "tmx_test",
  wwwUrl: "https://tokenmaxxing.test",
};

/** `meResponses` answers `/me` through the real contract client, in order. */
function testLayer(meResponses?: StubResponse[]) {
  const errors: string[] = [];
  const logs: string[] = [];
  const requests: string[] = [];
  const sleeps: number[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ApiClientService)({
      make: () =>
        meResponses === undefined
          ? Effect.succeed({
              me: {
                me: () => Effect.succeed({ user }),
              },
            } as unknown as TokenmaxxingApiClient)
          : makeStubApiClient({ "GET /me": meResponses }, requests),
    }),
    Layer.succeed(ClockService)({
      sleep: (ms) =>
        Effect.sync(() => {
          sleeps.push(ms);
        }),
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.succeed({
          config,
          token: config.token,
          tokenCleared: true,
        }),
      ensureDeviceId: () => Effect.succeed("device_123"),
      hasEnvToken: () => Effect.succeed(false),
      readConfig: () => Effect.succeed(config),
      writeToken: () => Effect.succeed(config),
    }),
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        errors.push(String(message));
      },
      log: (message?: unknown) => {
        logs.push(String(message));
      },
    }),
  );

  return { errors, layer, logs, requests, sleeps };
}

function setTty(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value });
}

function restoreEnvironment() {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTty,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: originalStderrIsTty,
  });

  if (originalCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCi;
  }
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
  if (originalTerm === undefined) {
    delete process.env.TERM;
  } else {
    process.env.TERM = originalTerm;
  }
}

describe("whoamiEffect", () => {
  afterEach(() => {
    promptCalls.length = 0;
    restoreEnvironment();
  });

  it("shows a loading spinner while fetching the account", async () => {
    const { errors, layer, logs } = testLayer();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(whoamiEffect({ json: false }).pipe(Effect.provide(layer)));

    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
    expect(promptCalls).toEqual([
      "intro:Account",
      "spinner-start:Fetching account",
      "spinner-stop:Alex (Alex)",
      "outro:Done",
    ]);
  });

  it("does not show loading UI for JSON output", async () => {
    const { errors, layer, logs } = testLayer();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(whoamiEffect({ json: true }).pipe(Effect.provide(layer)));

    expect(errors).toEqual([]);
    expect(promptCalls).toEqual([]);
    expect(logs).toEqual([JSON.stringify({ user })]);
  });

  it("retries /me once, quickly, on a transient failure", async () => {
    const { layer, logs, requests, sleeps } = testLayer([
      { status: 503 },
      { body: { user }, status: 200 },
    ]);

    await Effect.runPromise(whoamiEffect({ json: true }).pipe(Effect.provide(layer)));

    expect(requests).toEqual(["GET /me", "GET /me"]);
    expect(sleeps).toEqual([500]);
    expect(logs).toEqual([JSON.stringify({ user })]);
  });

  it("does not retry a decoded Unauthorized", async () => {
    const { layer, requests } = testLayer([
      { body: { _tag: "Unauthorized", message: "Sign in required." }, status: 401 },
    ]);

    const exit = await Effect.runPromiseExit(
      whoamiEffect({ json: true }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(requests).toEqual(["GET /me"]);
  });
});
