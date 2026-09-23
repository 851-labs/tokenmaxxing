import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { createIsomorphicFn } from "@tanstack/react-start";
import {
  ApiErrors,
  InternalServerError,
  ServiceUnavailable,
  TokenmaxxingApi,
} from "@tokenmaxxing/api-contract";
import type { ApiError, ApiErrorTag } from "@tokenmaxxing/api-contract";

import { resolveApiUrl } from "./config";

/**
 * The typed client derived from the shared contract, cookie-authenticated
 * (credentials ride on every request). Library functions keep Promise
 * signatures — Effects stay inside this module; components never see them.
 *
 * One runtime and one client serve every call. Per-request fetch options
 * (the SSR cookie) are provided to each call's fiber, which is where
 * FetchHttpClient reads them, so nothing is rebuilt or leaked per request.
 */

type TokenmaxxingApiClient = HttpApiClient.ForApi<typeof TokenmaxxingApi>;

class SignOutFailed extends Data.TaggedError("SignOutFailed")<{
  message: string;
  status: number;
}> {}

const runtime = ManagedRuntime.make(FetchHttpClient.layer);
const clients = new Map<string, Promise<TokenmaxxingApiClient>>();

function apiClient(apiUrl: string): Promise<TokenmaxxingApiClient> {
  const baseUrl = apiUrl.replace(/\/$/, "");
  let client = clients.get(baseUrl);
  if (client === undefined) {
    client = runtime.runPromise(HttpApiClient.make(TokenmaxxingApi, { baseUrl }));
    clients.set(baseUrl, client);
  }

  return client;
}

const requestCookie = createIsomorphicFn()
  .client(() => undefined)
  .server(async () => {
    const { getRequestHeader } = await import("@tanstack/react-start/server");

    return getRequestHeader("cookie");
  });

async function requestInit(): Promise<RequestInit> {
  const cookie = await requestCookie();

  return {
    credentials: "include",
    headers: cookie === undefined ? undefined : { cookie },
  };
}

async function runApi<A, E>(
  call: (client: TokenmaxxingApiClient) => Effect.Effect<A, E, never>,
): Promise<A> {
  const [client, init] = await Promise.all([apiClient(resolveApiUrl()), requestInit()]);

  return runtime.runPromise(
    call(client).pipe(Effect.provideService(FetchHttpClient.RequestInit, init)),
  );
}

/**
 * The contract error a failed `runApi` call rejected with, if any. The derived
 * client decodes error bodies into the contract's tagged error classes, and
 * `runPromise` rejects with that failure itself — anything else (network,
 * decode, defects) is not an API error.
 */
function apiError(error: unknown): ApiError | null {
  return ApiErrors.some((ErrorClass) => error instanceof ErrorClass) ? (error as ApiError) : null;
}

function isApiError<const Tag extends ApiErrorTag>(
  error: unknown,
  tag: Tag,
): error is Extract<ApiError, { readonly _tag: Tag }> {
  return apiError(error)?._tag === tag;
}

/** The API's human-readable message for contract errors; `fallback` otherwise. */
function errorMessage(error: unknown, fallback: string): string {
  const message = apiError(error)?.message;

  return message === undefined || message.length === 0 ? fallback : message;
}

/**
 * A profile that does not exist, as the API reports it: `UserNotFound`, or
 * `RouteNotFound` when the router rejects the path before any handler runs
 * (a `:login` past its 100-character param limit).
 */
function isNotFoundApiError(error: unknown): boolean {
  return isApiError(error, "UserNotFound") || isApiError(error, "RouteNotFound");
}

/** Transport failures and 5xx are worth retrying; contract 4xx failures are not. */
function isRetryableApiError(error: unknown): boolean {
  return (
    apiError(error) === null ||
    error instanceof InternalServerError ||
    error instanceof ServiceUnavailable
  );
}

/** Raw routes (OAuth signout) sit outside the derived client. */
async function signOut(): Promise<void> {
  const response = await fetch(`${resolveApiUrl()}/auth/signout`, {
    credentials: "include",
    method: "POST",
  });
  if (!response.ok) {
    throw new SignOutFailed({
      message: `Sign out failed (${response.status}).`,
      status: response.status,
    });
  }
}

export {
  errorMessage,
  isApiError,
  isNotFoundApiError,
  isRetryableApiError,
  runApi,
  SignOutFailed,
  signOut,
};
