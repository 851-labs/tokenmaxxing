import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
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
  LoginTimeoutError,
  LoginTokenInvalidError,
  LoginValidationError,
  PollCliLoginError,
  StartCliLoginError,
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
  sleeps: number[];
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
    sleeps: [],
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
      sleep: (ms) => Effect.sync(() => void state.sleeps.push(ms)),
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.succeed({
          config: options.initialConfig,
          token: options.initialConfig.token,
          tokenCleared: options.initialConfig.token !== undefined,
        }),
      ensureDeviceId: () =>
        Effect.succeed(options.initialConfig.deviceId ?? "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"),
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
      "error: failed to poll CLI login; the tokenmaxxing API had a server error (HTTP 500)\nhint: the problem is on the tokenmaxxing side; try again later",
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

describe("browserLoginEffect rate limits", () => {
  const config = {
    apiUrl: "https://api.tokenmaxxing.example",
    wwwUrl: "https://tokenmaxxing.example",
  };
  const startResponse: StubResponse = {
    body: {
      code: "ABCD-1234",
      deviceCode: "device-code-secret",
      expiresAt: "2026-06-21T18:10:00.000Z",
      intervalSeconds: 2,
      userCode: "ABCD-1234",
      verificationUri: "https://tokenmaxxing.example/login/cli?code=ABCD-1234",
    },
    status: 200,
  };
  const tooManyRequests = (message: string): StubResponse => ({
    body: { _tag: "TooManyRequests", message, retryAfterSeconds: 60 },
    status: 429,
  });
  const pollLimited = tooManyRequests("Checking login status too often; try again in 60 seconds.");

  it("waits out a rate-limited poll and completes the login", async () => {
    const requests: string[] = [];
    const { layer, state } = makeTestLayer({
      client: makeStubApiClient(
        {
          "POST /cli/login/poll": [
            pollLimited,
            { body: { status: "pending" }, status: 200 },
            { body: { status: "complete", token: "tmx_new", user }, status: 200 },
          ],
          "POST /cli/login/start": startResponse,
        },
        requests,
      ),
      initialConfig: config,
      interactive: true,
    });

    const result = await Effect.runPromise(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(result.user).toEqual(user);
    expect(result.config.token).toBe("tmx_new");
    // Retry-After first, then back to the server's poll interval.
    expect(state.sleeps).toEqual([60_000, 2_000]);
    expect(requests.filter((request) => request === "POST /cli/login/poll")).toHaveLength(3);
  });

  it("gives up within the login's attempt budget when every poll is limited", async () => {
    const requests: string[] = [];
    const { layer, state } = makeTestLayer({
      client: makeStubApiClient(
        { "POST /cli/login/poll": pollLimited, "POST /cli/login/start": startResponse },
        requests,
      ),
      initialConfig: config,
      interactive: true,
    });

    const exit = await Effect.runPromiseExit(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(firstFailure(exit)).toBeInstanceOf(LoginTimeoutError);
    // 150 attempts x 2 s: five 60 s waits use the whole budget.
    expect(state.sleeps).toEqual(Array(5).fill(60_000));
    expect(requests.filter((request) => request === "POST /cli/login/poll")).toHaveLength(5);
  });

  it("explains a rate-limited start", async () => {
    const { layer } = makeTestLayer({
      client: makeStubApiClient({
        "POST /cli/login/start": tooManyRequests(
          "Too many login attempts from this network; try again in 60 seconds.",
        ),
      }),
      initialConfig: config,
      interactive: true,
    });

    const exit = await Effect.runPromiseExit(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(StartCliLoginError);
    expect(error.message).toBe(
      "error: failed to start CLI login; the tokenmaxxing API is rate limiting requests\nhint: try again in 60 s",
    );
  });

  it("explains a start rate-limited by something other than the API (an HTML 429)", async () => {
    const { layer } = makeTestLayer({
      client: makeStubApiClient({
        "POST /cli/login/start": {
          body: "<html>Too Many Requests</html>",
          headers: { "retry-after": "37" },
          status: 429,
        },
      }),
      initialConfig: config,
      interactive: true,
    });

    const exit = await Effect.runPromiseExit(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(firstFailure(exit).message).toBe(
      "error: failed to start CLI login; the tokenmaxxing API is rate limiting requests\nhint: try again in 37 s",
    );
  });
});

describe("browserLoginEffect timeouts", () => {
  const config = {
    apiUrl: "https://api.tokenmaxxing.example",
    wwwUrl: "https://tokenmaxxing.example",
  };
  const start = {
    code: "ABCD-1234",
    deviceCode: "device-code-secret",
    expiresAt: "2026-06-21T18:10:00.000Z",
    intervalSeconds: 2,
    userCode: "ABCD-1234",
    verificationUri: "https://tokenmaxxing.example/login/cli?code=ABCD-1234",
  };
  const client = (cliLogin: Record<string, () => Effect.Effect<unknown>>) =>
    Effect.succeed({ cliLogin } as unknown as TokenmaxxingApiClient);
  const runWithClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(effect));
        for (let step = 0; step < 4; step += 1) {
          yield* TestClock.adjust("15 seconds");
        }
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<Exit.Exit<A, E>>,
    );

  it("gives up on a login start that never answers after 15 s", async () => {
    const { layer } = makeTestLayer({
      client: client({ start: () => Effect.never }),
      initialConfig: config,
      interactive: true,
    });

    const exit = await runWithClock(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    const error = firstFailure(exit);
    expect(error).toBeInstanceOf(StartCliLoginError);
    expect(error.message).toBe(
      "error: failed to start CLI login; the tokenmaxxing API did not answer within 15 s\nhint: check your network, then try again",
    );
  });

  it("polls again after a poll that never answers, spending its time from the budget", async () => {
    let polls = 0;
    const { layer, state } = makeTestLayer({
      client: client({
        poll: () => {
          polls += 1;
          return polls === 1
            ? Effect.never
            : Effect.succeed({ status: "complete", token: "tmx_new", user });
        },
        start: () => Effect.succeed(start),
      }),
      initialConfig: config,
      interactive: true,
    });

    const exit = await runWithClock(
      browserLoginEffect({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(polls).toBe(2);
    expect(state.sleeps).toEqual([2_000]);
  });
});
