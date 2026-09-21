import { Cause, Effect, Option } from "effect";
import { CliError, Flag, GlobalFlag } from "effect/unstable/cli";

import { formatHighlight, humanFailure, type HumanFailureContent, shouldUseClack } from "./output";
import { ConsoleService } from "./services";

/**
 * Failure rendering for the whole CLI: tagged errors whose message starts
 * with "error:" reach the user verbatim (with a hint line); everything else
 * collapses to a generic failure unless --verbose is set.
 */

const userFacingErrorTags = new Set([
  "AlreadyLoggedInError",
  "BootstrapCancelledError",
  "BootstrapServiceDecisionRequiredError",
  "ConfigReadError",
  "ConfigWriteError",
  "InvalidBootstrapServiceOptionError",
  "LoginSleepError",
  "LoginTimeoutError",
  "LoginTokenInvalidError",
  "LoginValidationError",
  "NonInteractiveLoginError",
  "NotLoggedInError",
  "OpenBrowserError",
  "PollCliLoginError",
  "ServiceCommandNotFoundError",
  "ServiceEnvTokenError",
  "ServiceEphemeralCommandError",
  "ServiceInstallError",
  "ServiceNotInstalledError",
  "ServiceRunError",
  "ServiceUninstallError",
  "ServiceUnsupportedPlatformError",
  "SyncAuthValidationError",
  "StartCliLoginError",
  "SyncPushError",
  "UnknownSourceError",
  "UpgradeCommandNotFoundError",
  "UpgradeEphemeralCommandError",
  "UpgradeFailedError",
  "UpgradeManagerError",
  "WhoamiError",
  "WriteCliTokenError",
]);

const verboseGlobalFlag = GlobalFlag.Setting("verbose")({
  flag: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Print internal stack traces on failures"),
  ),
});

function isVerboseArgv(argv: readonly string[]) {
  let verbose = false;

  for (const value of argv) {
    if (value === "--") {
      break;
    }

    if (value === "--verbose") {
      verbose = true;
      continue;
    }

    if (value === "--no-verbose") {
      verbose = false;
    }
  }

  return verbose;
}

function isJsonArgv(argv: readonly string[]) {
  let json = false;

  for (const value of argv) {
    if (value === "--") {
      break;
    }

    if (value === "--json") {
      json = true;
      continue;
    }

    if (value === "--no-json") {
      json = false;
    }
  }

  return json;
}

function renderCliFailure<E>(
  cause: Cause.Cause<E>,
  options: {
    json: boolean;
    verbose: boolean;
  },
) {
  const failure = failureForCause(cause);

  if (!failure) {
    return Effect.void;
  }

  if (options.json) {
    return Effect.gen(function* () {
      const output = yield* Effect.service(ConsoleService);

      yield* Effect.sync(() => {
        output.error(JSON.stringify(jsonFailureForCliFailure(failure)));
      });
    });
  }

  return Effect.gen(function* () {
    const output = yield* Effect.service(ConsoleService);
    const renderedFailure = failureForHumanOutput(failure);

    yield* humanFailure(renderedFailure);

    if (options.verbose) {
      yield* Effect.sync(() => {
        output.error(`debug:\n${Cause.pretty(cause)}`);
      });
    }
  });
}

function failureForHumanOutput(failure: CliFailure): string | HumanFailureContent {
  if (shouldUseClack()) {
    return clackFailureForCliFailure(failure.message, {
      primaryMessageRendered: failure.primaryMessageRendered,
    });
  }

  if (failure.primaryMessageRendered) {
    return clackFailureForCliFailure(failure.message, {
      primaryMessageRendered: true,
    });
  }

  return failure.message;
}

interface CliFailure {
  code: string;
  message: string;
  primaryMessageRendered: boolean;
}

function failureForCause<E>(cause: Cause.Cause<E>): CliFailure | undefined {
  if (Cause.hasInterruptsOnly(cause)) {
    return undefined;
  }

  const error = Cause.findErrorOption(cause);

  if (Option.isSome(error)) {
    if (isShowHelpError(error.value)) {
      return undefined;
    }

    if (isUserFacingCliError(error.value)) {
      return {
        code: codeForTaggedError(error.value),
        message: error.value.message,
        primaryMessageRendered: isPrimaryMessageRendered(error.value),
      };
    }
  }

  return {
    code: "unexpected_cli_failure",
    message: "error: unexpected CLI failure\nhint: rerun with --verbose and report the output",
    primaryMessageRendered: false,
  };
}

function isShowHelpError(value: unknown) {
  return CliError.isCliError(value) && value._tag === "ShowHelp";
}

function isUserFacingCliError(value: unknown): value is Error {
  const tag = (value as { _tag?: unknown })._tag;

  return (
    value instanceof Error &&
    typeof tag === "string" &&
    userFacingErrorTags.has(tag) &&
    value.message.startsWith("error:")
  );
}

function codeForTaggedError(error: Error): string {
  const tag = (error as { _tag?: unknown })._tag;

  if (typeof tag !== "string") {
    return "cli_error";
  }

  const name = tag.endsWith("Error") ? tag.slice(0, -"Error".length) : tag;

  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function isPrimaryMessageRendered(error: Error): boolean {
  return (error as { primaryMessageRendered?: unknown }).primaryMessageRendered === true;
}

function jsonFailureForCliFailure(failure: CliFailure) {
  const parsed = parseCliMessage(failure.message);

  return {
    error: {
      code: failure.code,
      ...(parsed.hint === undefined ? {} : { hint: parsed.hint }),
      message: parsed.message,
    },
    status: "error",
  };
}

function parseCliMessage(message: string) {
  const lines = message.split("\n");
  const first = lines[0] ?? message;
  const parsedMessage = first.startsWith("error: ") ? first.slice("error: ".length) : first;
  const hint = lines.find((line) => line.startsWith("hint: "))?.slice("hint: ".length);

  return { hint, message: parsedMessage };
}

function clackFailureForCliFailure(
  message: string,
  options: { primaryMessageRendered?: boolean | undefined } = {},
): HumanFailureContent {
  const lines = message.split("\n");
  const first = lines[0] ?? message;
  const parsedMessage = first.startsWith("error: ") ? first.slice("error: ".length) : first;
  const context: string[] = [];
  let hint: string | undefined;

  for (const line of lines.slice(1)) {
    if (hint === undefined && line.startsWith("hint: ")) {
      hint = line.slice("hint: ".length);
      continue;
    }

    context.push(line);
  }

  return {
    context,
    hint,
    message: highlightCliFailureMessage(parsedMessage),
    ...(options.primaryMessageRendered === undefined
      ? {}
      : { primaryMessageRendered: options.primaryMessageRendered }),
  };
}

function highlightCliFailureMessage(message: string): string {
  const prefix = "already logged in as ";
  if (message.startsWith(prefix)) {
    return `${prefix}${formatHighlight(message.slice(prefix.length))}`;
  }

  return message;
}

export {
  clackFailureForCliFailure,
  isJsonArgv,
  isVerboseArgv,
  renderCliFailure,
  verboseGlobalFlag,
};
