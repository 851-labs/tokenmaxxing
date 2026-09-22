import { arch, hostname } from "node:os";

import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { DeviceId, type AuthUser } from "@tokenmaxxing/api-contract";

import packageJson from "../../package.json";
import {
  ApiClientService,
  BrowserService,
  ClockService,
  type CliConfig,
  ConfigService,
  TerminalService,
} from "../services";
import { formatUrl, humanFrame, humanLog, humanSpinner, writeJson } from "../output";
import {
  alreadyLoggedInAsMessage,
  loggedInAsMessage,
  validateCurrentLogin,
} from "../auth-validation";

class StartCliLoginError extends Data.TaggedError("StartCliLoginError")<{
  readonly cause: unknown;
}> {
  override message = "error: failed to start CLI login\nhint: check your network and try again";
}

class PollCliLoginError extends Data.TaggedError("PollCliLoginError")<{
  readonly cause: unknown;
}> {
  override message = "error: failed to poll CLI login\nhint: run tokenmaxxing login again";
}

class OpenBrowserError extends Data.TaggedError("OpenBrowserError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to open browser\nhint: run tokenmaxxing login without --json to approve manually, or set TOKENMAXXING_API_TOKEN";
}

class WriteCliTokenError extends Data.TaggedError("WriteCliTokenError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to write CLI token\nhint: check TOKENMAXXING_CONFIG_DIR permissions";
}

class LoginSleepError extends Data.TaggedError("LoginSleepError")<{
  readonly cause: unknown;
}> {
  override message = "error: failed while waiting for CLI login";
}

class LoginTimeoutError extends Data.TaggedError("LoginTimeoutError")<{}> {
  override message = "error: timed out waiting for CLI login\nhint: run tokenmaxxing login again";
}

class AlreadyLoggedInError extends Data.TaggedError("AlreadyLoggedInError")<{
  readonly envTokenActive: boolean;
  readonly login?: string | undefined;
  readonly primaryMessageRendered?: boolean | undefined;
}> {
  override get message() {
    const message =
      this.login === undefined ? "already logged in" : `already logged in as ${this.login}`;

    if (this.envTokenActive) {
      return `error: ${message}\nhint: run tokenmaxxing logout first, or unset TOKENMAXXING_API_TOKEN before logging in again`;
    }

    return `error: ${message}\nhint: run tokenmaxxing logout first before logging in again`;
  }
}

class LoginTokenInvalidError extends Data.TaggedError("LoginTokenInvalidError")<{
  readonly envTokenActive: boolean;
}> {
  override get message() {
    if (this.envTokenActive) {
      return "error: login token is no longer valid\nhint: unset TOKENMAXXING_API_TOKEN or set a valid token";
    }

    return "error: stored login is no longer valid\nhint: run tokenmaxxing logout, then run tokenmaxxing login";
  }
}

class LoginValidationError extends Data.TaggedError("LoginValidationError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to validate stored login\nhint: check your network and try again";
}

class NonInteractiveLoginError extends Data.TaggedError("NonInteractiveLoginError")<{}> {
  override message =
    "error: cannot run browser login without an interactive terminal\nhint: set TOKENMAXXING_API_TOKEN for non-interactive environments";
}

const MAX_POLL_ATTEMPTS = 150;

interface BrowserLoginOptions {
  json: boolean;
}

interface BrowserLoginResult {
  config: CliConfig;
  user: AuthUser;
}

const loginCommand = Command.make(
  "login",
  {
    json: Flag.Boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => loginEffect({ json }),
).pipe(Command.withDescription("Log in to tokenmaxxing via your browser"));

function loginEffect(options: { json: boolean }) {
  return humanFrame(
    "Login",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);
      const clients = yield* Effect.service(ApiClientService);

      const stored = yield* config.readConfig();
      const envTokenActive = yield* config.hasEnvToken();
      if (stored.token !== undefined) {
        const client = yield* clients.make({ baseUrl: stored.apiUrl, token: stored.token });
        const validated = yield* validateCurrentLogin(client, {
          ...options,
          showSpinner: true,
          successDisposition: "error",
          successMessage: alreadyLoggedInAsMessage,
        });

        if (validated._tag === "valid") {
          return yield* Effect.fail(
            new AlreadyLoggedInError({
              envTokenActive,
              login: validated.user.login,
              primaryMessageRendered: true,
            }),
          );
        }

        if (validated._tag === "unauthorized") {
          return yield* Effect.fail(new LoginTokenInvalidError({ envTokenActive }));
        }

        return yield* Effect.fail(new LoginValidationError({ cause: validated.cause }));
      }

      if (envTokenActive) {
        return yield* Effect.fail(new LoginValidationError({ cause: "missing env token" }));
      }

      const login = yield* browserLoginEffect(options);
      if (options.json) {
        yield* writeJson({ login: login.user.login, status: "ok" });
      }
    }),
  );
}

function browserLoginEffect(options: BrowserLoginOptions) {
  return Effect.gen(function* () {
    const browser = yield* Effect.service(BrowserService);
    const clock = yield* Effect.service(ClockService);
    const config = yield* Effect.service(ConfigService);
    const clients = yield* Effect.service(ApiClientService);
    const terminal = yield* Effect.service(TerminalService);

    const stored = yield* config.readConfig();
    if (!(yield* terminal.isInteractive)) {
      return yield* Effect.fail(new NonInteractiveLoginError());
    }
    const canOpenBrowser = yield* terminal.canOpenExternalBrowser;
    if (options.json && !canOpenBrowser) {
      return yield* Effect.fail(
        new OpenBrowserError({ cause: "External browser launch is unavailable" }),
      );
    }

    const deviceId = yield* config.ensureDeviceId();
    const client = yield* clients.make({ baseUrl: stored.apiUrl });

    const startSpinner = yield* humanSpinner("Creating login code", options);
    const start = yield* client.cliLogin
      .start({
        payload: {
          deviceArch: arch(),
          deviceId: DeviceId.make(deviceId),
          deviceName: hostname(),
          devicePlatform: process.platform,
          deviceVersion: packageJson.version,
          flow: "device_code",
        },
      })
      .pipe(
        Effect.mapError((cause) => new StartCliLoginError({ cause })),
        // The deviceCode is the only credential poll accepts; never proceed
        // (or fall back to polling by the user code) without it.
        Effect.flatMap(({ deviceCode, ...login }) =>
          deviceCode === undefined
            ? Effect.fail(new StartCliLoginError({ cause: "missing deviceCode" }))
            : Effect.succeed({ ...login, deviceCode }),
        ),
        Effect.tap((login) => Effect.sync(() => startSpinner.stop(`Code: ${login.userCode}`))),
        Effect.tapError(() => Effect.sync(() => startSpinner.error("Failed to start CLI login"))),
      );

    if (canOpenBrowser) {
      const openSpinner = yield* humanSpinner(
        `Opening ${formatUrl(start.verificationUri)}`,
        options,
      );
      const openResult = yield* browser.open(start.verificationUri).pipe(
        Effect.tap(() =>
          Effect.sync(() => openSpinner.stop(`Opened ${formatUrl(start.verificationUri)}`)),
        ),
        Effect.tapError(() => Effect.sync(() => openSpinner.error("Could not open browser"))),
        Effect.match({
          onFailure: (cause) => ({ _tag: "failure" as const, cause }),
          onSuccess: () => ({ _tag: "success" as const }),
        }),
      );
      if (openResult._tag === "failure") {
        if (options.json) {
          return yield* Effect.fail(new OpenBrowserError({ cause: openResult.cause }));
        }

        yield* humanLog(
          "info",
          `Open ${formatUrl(start.verificationUri)} in your browser to continue`,
          options,
        );
      }
    } else {
      yield* humanLog(
        "info",
        `Open ${formatUrl(start.verificationUri)} in your browser to continue`,
        options,
      );
    }

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const poll = yield* client.cliLogin
        .poll({ payload: { deviceCode: start.deviceCode } })
        .pipe(Effect.mapError((cause) => new PollCliLoginError({ cause })));

      if (poll.status === "complete") {
        const written = yield* config
          .writeToken(poll.token)
          .pipe(Effect.mapError((cause) => new WriteCliTokenError({ cause })));
        const nextConfig = {
          ...written,
          apiUrl: stored.apiUrl,
          token: poll.token,
          wwwUrl: stored.wwwUrl,
        };

        yield* humanLog("success", loggedInAsMessage(poll.user), options);
        return { config: nextConfig, user: poll.user };
      }

      yield* clock
        .sleep(start.intervalSeconds * 1000)
        .pipe(Effect.mapError((cause) => new LoginSleepError({ cause })));
    }

    return yield* Effect.fail(new LoginTimeoutError());
  });
}

export {
  AlreadyLoggedInError,
  browserLoginEffect,
  loginCommand,
  loginEffect,
  LoginSleepError,
  LoginTimeoutError,
  LoginTokenInvalidError,
  LoginValidationError,
  NonInteractiveLoginError,
  OpenBrowserError,
  PollCliLoginError,
  StartCliLoginError,
  WriteCliTokenError,
};

export type { BrowserLoginOptions, BrowserLoginResult };
