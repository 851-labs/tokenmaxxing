import { Cause, Effect, Layer, Option } from "effect";
import { Unauthorized, UserId, type AuthUser } from "@tokenmaxxing/api-contract";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ApiClientService,
  BrowserService,
  ClockService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  TerminalService,
  type TokenmaxxingApiClient,
} from "../services";
import { makeStubApiClient, type StubResponse } from "../testing/stub-api-client";
import {
  AlreadyLoggedInError,
  browserLoginEffect,
  loginEffect,
  LoginTokenInvalidError,
  LoginValidationError,
  PollCliLoginError,
} from "./login";

const promptCalls = vi.hoisted((): string[] => []);

vi.mock("@clack/prompts", () => ({
  intro: (title: string) => {
    promptCalls.push(`intro:${title}`);
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

interface TestLayerOptions {
  /** A real client (see makeStubApiClient) instead of the canned fake. */
  client?: Effect.Effect<TokenmaxxingApiClient>;
  envTokenActive?: boolean;
  initialConfig: CliConfig;
  interactive?: boolean;
  meError?: unknown;
}

interface TestState {
  madeClients: Array<{ baseUrl: string; token?: string | undefined }>;
}

const user: AuthUser = {
  avatarUrl: null,
  id: UserId.make("user_123"),
  login: "pondorasti",
  name: "Alexandru Turcanu",
};

const originalStdoutIsTty = process.stdout.isTTY;
const originalStderrIsTty = process.stderr.isTTY;
const originalCi = process.env.CI;
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

function makeTestLayer(options: TestLayerOptions) {
  const state: TestState = {
    madeClients: [],
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ApiClientService)({
      make: (clientOptions) => {
        state.madeClients.push(clientOptions);
        if (options.client !== undefined) {
          return options.client;
        }

        return Effect.succeed({
          me: {
            me: () =>
              options.meError === undefined
                ? Effect.succeed({ user })
                : Effect.fail(options.meError),
          },
        } as unknown as TokenmaxxingApiClient);
      },
    }),
    Layer.succeed(BrowserService)({
      open: () => Effect.succeed(undefined),
    }),
    Layer.succeed(ClockService)({
      sleep: () => Effect.succeed(undefined),
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.succeed({
          config: options.initialConfig,
          token: options.initialConfig.token,
          tokenCleared: options.initialConfig.token !== undefined,
        }),
      ensureDeviceId: () => Effect.succeed(options.initialConfig.deviceId ?? "device_123"),
      hasEnvToken: () => Effect.succeed(options.envTokenActive ?? false),
      readConfig: () => Effect.succeed(options.initialConfig),
      writeToken: (token) => Effect.succeed({ ...options.initialConfig, token }),
    }),
    Layer.succeed(ConsoleService)({
      error: () => {},
      log: () => {},
    }),
    Layer.succeed(TerminalService)({
      canOpenExternalBrowser: Effect.succeed(false),
      isInteractive: Effect.succeed(options.interactive ?? false),
    }),
  );

  return { layer, state };
}

function unauthorizedError() {
  return new Unauthorized({});
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

function firstFailure(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>): Error {
  if (exit._tag !== "Failure") {
    throw new Error("expected failure");
  }

  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) {
    throw new Error("expected a typed failure");
  }
  if (!(error.value instanceof Error)) {
    throw new Error("expected an Error failure");
  }

  return error.value;
}

describe("loginEffect", () => {
  afterEach(() => {
    promptCalls.length = 0;
    restoreEnvironment();
  });

  it("validates the active token and reports the logged-in username", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      loginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(AlreadyLoggedInError);
    expect(error.message).toBe(
      "error: already logged in as pondorasti\nhint: run tokenmaxxing logout first before logging in again",
    );
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
    ]);
  });

  it("shows a loading spinner while checking an existing login", async () => {
    const { layer } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    const exit = await Effect.runPromiseExit(
      loginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(promptCalls).toEqual([
      "intro:Login",
      "spinner-start:Checking current login",
      "spinner-error:Already logged in as \x1b[36mpondorasti\x1b[0m",
    ]);
  });

  it("reports a revoked stored token instead of claiming the user is logged in", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });

    const exit = await Effect.runPromiseExit(
      loginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(LoginTokenInvalidError);
    expect(error.message).toBe(
      "error: stored login is no longer valid\nhint: run tokenmaxxing logout, then run tokenmaxxing login",
    );
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
    ]);
  });

  it("reports validation failures separately from revoked tokens", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: new Error("network unavailable"),
    });

    const exit = await Effect.runPromiseExit(
      loginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(LoginValidationError);
    expect(error.message).toBe(
      "error: failed to validate stored login\nhint: check your network and try again",
    );
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
    ]);
  });

  it("explains invalid environment tokens without suggesting a stored-token logout", async () => {
    const { layer } = makeTestLayer({
      envTokenActive: true,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_env",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });

    const exit = await Effect.runPromiseExit(
      loginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(LoginTokenInvalidError);
    expect(error.message).toBe(
      "error: login token is no longer valid\nhint: unset TOKENMAXXING_API_TOKEN or set a valid token",
    );
  });
});

describe("browserLoginEffect poll failures", () => {
  const startResponse: StubResponse = {
    body: {
      code: "ABCD-1234",
      deviceCode: "device-code-secret",
      expiresAt: "2026-06-21T18:10:00.000Z",
      intervalSeconds: 0,
      userCode: "ABCD-1234",
      verificationUri: "https://tokenmaxxing.example/login/cli?code=ABCD-1234",
    },
    status: 200,
  };

  it.each<[string, StubResponse, string]>([
    [
      "an expired login code",
      {
        body: {
          _tag: "LoginCodeExpired",
          code: "ABCD-1234",
          message: "Login code expired; run `tokenmaxxing login` again.",
        },
        status: 410,
      },
      "error: Login code expired; run `tokenmaxxing login` again.",
    ],
    [
      "an unknown login code",
      {
        body: {
          _tag: "LoginCodeNotFound",
          code: "ABCD-1234",
          message: "Login code not found; run `tokenmaxxing login` again.",
        },
        status: 404,
      },
      "error: Login code not found; run `tokenmaxxing login` again.",
    ],
    [
      "a server failure",
      { status: 500 },
      "error: failed to poll CLI login\nhint: run tokenmaxxing login again",
    ],
  ])("surfaces %s", async (_label, pollResponse, message) => {
    const { layer } = makeTestLayer({
      client: makeStubApiClient({
        "POST /cli/login/poll": pollResponse,
        "POST /cli/login/start": startResponse,
      }),
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: true,
    });

    const exit = await Effect.runPromiseExit(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(PollCliLoginError);
    expect(error.message).toBe(message);
  });
});
