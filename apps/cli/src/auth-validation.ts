import { Effect } from "effect";
import { type ApiError, ApiErrors, type AuthUser, Unauthorized } from "@tokenmaxxing/api-contract";

import { type ApiRetryPolicy, ME_TIMEOUT_MS, withApiRetry } from "./api-failure";
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
  /** How to retry a failed `/me`; one attempt when unset. */
  retry?: ApiRetryPolicy | undefined;
  showSpinner?: boolean | undefined;
  successDisposition?: ValidateCurrentLoginSuccessDisposition | undefined;
  successMessage?: ValidateCurrentLoginSuccessMessage;
}

type CurrentLoginValidation =
  | { _tag: "failed"; attempts: number; cause: unknown }
  | { _tag: "unauthorized" }
  | { _tag: "valid"; user: AuthUser };

const SINGLE_ATTEMPT: ApiRetryPolicy = {
  attempts: 1,
  backoffMs: [],
  jitterRatio: 0,
  timeoutMs: ME_TIMEOUT_MS,
};

function validateCurrentLogin(
  client: TokenmaxxingApiClient,
  options: ValidateCurrentLoginOptions = {},
) {
  return Effect.gen(function* () {
    const spinner =
      options.showSpinner === true
        ? yield* humanSpinner("Checking current login", options)
        : undefined;
    const result = yield* withApiRetry(() => client.me.me(), {
      ...(options.retry ?? SINGLE_ATTEMPT),
      // A bad token is final, whatever the policy says.
      retryable: (cause) =>
        !isUnauthorizedError(cause) && (options.retry?.retryable?.(cause) ?? true),
    }).pipe(
      Effect.map((me): CurrentLoginValidation => ({ _tag: "valid", user: me.user })),
      Effect.catch((failure) =>
        Effect.succeed(
          isUnauthorizedError(failure.cause)
            ? ({ _tag: "unauthorized" } satisfies CurrentLoginValidation)
            : ({
                _tag: "failed",
                attempts: failure.attempts,
                cause: failure.cause,
              } satisfies CurrentLoginValidation),
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
