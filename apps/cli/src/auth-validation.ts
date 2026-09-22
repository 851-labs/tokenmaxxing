import { Effect } from "effect";
import { type ApiError, ApiErrors, type AuthUser, Unauthorized } from "@tokenmaxxing/api-contract";

import {
  formatHighlight,
  humanSpinner,
  type FormatHighlightOptions,
  type HumanOutputOptions,
} from "./output";
import type { TokenmaxxingApiClient } from "./services";

type ValidateCurrentLoginSuccessDisposition = "error" | "success";
type ValidateCurrentLoginSuccessMessage = ((user: AuthUser) => string) | string | undefined;

interface ValidateCurrentLoginOptions extends HumanOutputOptions {
  showSpinner?: boolean | undefined;
  successDisposition?: ValidateCurrentLoginSuccessDisposition | undefined;
  successMessage?: ValidateCurrentLoginSuccessMessage;
}

type CurrentLoginValidation =
  | { _tag: "failed"; cause: unknown }
  | { _tag: "unauthorized" }
  | { _tag: "valid"; user: AuthUser };

function validateCurrentLogin(
  client: TokenmaxxingApiClient,
  options: ValidateCurrentLoginOptions = {},
) {
  return Effect.gen(function* () {
    const spinner =
      options.showSpinner === true
        ? yield* humanSpinner("Checking current login", options)
        : undefined;
    const result = yield* client.me.me().pipe(
      Effect.map((me): CurrentLoginValidation => ({ _tag: "valid", user: me.user })),
      Effect.catch((cause) =>
        Effect.succeed(
          isUnauthorizedError(cause)
            ? ({ _tag: "unauthorized" } satisfies CurrentLoginValidation)
            : ({ _tag: "failed", cause } satisfies CurrentLoginValidation),
        ),
      ),
    );

    if (result._tag === "valid") {
      const successMessage =
        typeof options.successMessage === "function"
          ? options.successMessage(result.user)
          : (options.successMessage ?? "Validated current login");
      const successDisposition = options.successDisposition ?? "success";
      yield* Effect.sync(() => {
        if (successDisposition === "error") {
          spinner?.error(successMessage);
          return;
        }

        spinner?.stop(successMessage);
      });
      return result;
    }

    yield* Effect.sync(() => spinner?.error("Could not validate current login"));
    return result;
  });
}

/**
 * True only for a decoded `Unauthorized` wire error, which the client decodes
 * solely from a 401 whose body is tagged `Unauthorized`. Anything else (other
 * statuses, untagged 401s from a proxy, network or decode failures) is not
 * proof the token is bad, so callers must never clear the token on it.
 */
function isUnauthorizedError(cause: unknown): cause is Unauthorized {
  return cause instanceof Unauthorized;
}

/** The server's human-readable message when `cause` is a typed wire error. */
function apiErrorMessage(cause: unknown): string | undefined {
  return ApiErrors.some((ErrorClass) => cause instanceof ErrorClass)
    ? (cause as ApiError).message
    : undefined;
}

function loggedInAsMessage(
  user: Pick<AuthUser, "login">,
  options: FormatHighlightOptions = {},
): string {
  return `Logged in as ${formatHighlight(user.login, options)}`;
}

function alreadyLoggedInAsMessage(
  user: Pick<AuthUser, "login">,
  options: FormatHighlightOptions = {},
): string {
  return `Already logged in as ${formatHighlight(user.login, options)}`;
}

export {
  alreadyLoggedInAsMessage,
  apiErrorMessage,
  isUnauthorizedError,
  loggedInAsMessage,
  validateCurrentLogin,
};
export type {
  CurrentLoginValidation,
  ValidateCurrentLoginSuccessDisposition,
  ValidateCurrentLoginOptions,
  ValidateCurrentLoginSuccessMessage,
};
