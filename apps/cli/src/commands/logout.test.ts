import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ApiClientService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  type TokenmaxxingApiClient,
} from "../services";
import { logoutEffect } from "./logout";

interface TestLayerOptions {
  logoutError?: unknown;
  token?: string | undefined;
}

interface TestState {
  clearCalls: number;
  errors: string[];
  logoutCalls: number;
  logs: string[];
  madeClients: Array<{ baseUrl: string; token?: string | undefined }>;
}

function makeTestLayer(options: TestLayerOptions = {}) {
  let currentConfig: CliConfig = {
    apiUrl: "https://api.tokenmaxxing.example",
    ...(options.token === undefined ? {} : { token: options.token }),
    wwwUrl: "https://tokenmaxxing.example",
  };
  const state: TestState = {
    clearCalls: 0,
    errors: [],
    logoutCalls: 0,
    logs: [],
    madeClients: [],
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ApiClientService)({
      make: (clientOptions) => {
        state.madeClients.push(clientOptions);

        return Effect.succeed({
          usage: {
            logout: () =>
              Effect.gen(function* () {
                state.logoutCalls += 1;
                if (options.logoutError !== undefined) {
                  return yield* Effect.fail(options.logoutError);
                }
              }),
          },
        } as unknown as TokenmaxxingApiClient);
      },
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.sync(() => {
          const token = currentConfig.token;
          const { token: _token, ...nextConfig } = currentConfig;
          currentConfig = nextConfig;
          state.clearCalls += 1;

          return {
            config: nextConfig,
            token,
            tokenCleared: token !== undefined,
          };
        }),
      ensureDeviceId: () => Effect.succeed("device_123"),
      hasEnvToken: () => Effect.succeed(false),
      readConfig: () => Effect.succeed(currentConfig),
      writeToken: (token) =>
        Effect.sync(() => {
          currentConfig = { ...currentConfig, token };
          return currentConfig;
        }),
    }),
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        state.errors.push(String(message));
      },
      log: (message?: unknown) => {
        state.logs.push(String(message));
      },
    }),
  );

  return { layer, state };
}

describe("logoutEffect", () => {
  it("clears and revokes a stored token with progress output", async () => {
    const { layer, state } = makeTestLayer({ token: "tmx_test" });

    await Effect.runPromise(logoutEffect({ json: false }).pipe(Effect.provide(layer)));

    expect(state.clearCalls).toBe(1);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_test" },
    ]);
    expect(state.logoutCalls).toBe(1);
    expect(state.logs).toEqual(["Logging out", "Logged out"]);
    expect(state.errors).toEqual([]);
  });

  it("does not create a client when there is no stored token", async () => {
    const { layer, state } = makeTestLayer();

    await Effect.runPromise(logoutEffect({ json: false }).pipe(Effect.provide(layer)));

    expect(state.clearCalls).toBe(1);
    expect(state.madeClients).toEqual([]);
    expect(state.logoutCalls).toBe(0);
    expect(state.logs).toEqual(["Not logged in; nothing to do"]);
    expect(state.errors).toEqual([]);
  });

  it("still succeeds when remote revocation fails", async () => {
    const { layer, state } = makeTestLayer({
      logoutError: new Error("network unavailable"),
      token: "tmx_test",
    });

    await Effect.runPromise(logoutEffect({ json: false }).pipe(Effect.provide(layer)));

    expect(state.clearCalls).toBe(1);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_test" },
    ]);
    expect(state.logoutCalls).toBe(1);
    expect(state.logs).toEqual(["Logging out", "Logged out"]);
    expect(state.errors).toEqual([]);
  });

  it("keeps json output machine-readable", async () => {
    const { layer, state } = makeTestLayer({ token: "tmx_test" });

    await Effect.runPromise(logoutEffect({ json: true }).pipe(Effect.provide(layer)));

    expect(state.clearCalls).toBe(1);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_test" },
    ]);
    expect(state.logoutCalls).toBe(1);
    expect(state.logs).toEqual(['{"status":"ok","tokenCleared":true}']);
    expect(state.errors).toEqual([]);
  });
});
