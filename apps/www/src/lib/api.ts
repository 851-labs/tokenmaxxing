import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { createIsomorphicFn } from "@tanstack/react-start";
import {
  AdminUserNotFound,
  CliUpgradeRequired,
  DeviceMissing,
  DeviceNotFound,
  Forbidden,
  LoginCodeExpired,
  LoginCodeNotFound,
  TokenmaxxingApi,
  TokenNotFound,
  Unauthorized,
  UserNotFound,
} from "@tokenmaxxing/api-contract";

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

/** Contract failures are deliberate 4xx answers; retrying cannot change them. */
const CONTRACT_ERRORS = [
  AdminUserNotFound,
  CliUpgradeRequired,
  DeviceMissing,
  DeviceNotFound,
  Forbidden,
  LoginCodeExpired,
  LoginCodeNotFound,
  TokenNotFound,
  Unauthorized,
  UserNotFound,
] as const;

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

/** Best-effort message extraction from the contract's tagged errors. */
function errorMessage(error: unknown, fallback: string): string {
  const inner = apiError(error);
  const message = (inner as { message?: unknown }).message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  return fallback;
}

function isApiError(error: unknown, tag: string): boolean {
  const inner = apiError(error);
  const innerTag = (inner as { _tag?: unknown })._tag;

  return innerTag === tag;
}

/** Transport failures and 5xx are worth retrying; contract 4xx failures are not. */
function isRetryableApiError(error: unknown): boolean {
  const inner = apiError(error);

  return !CONTRACT_ERRORS.some((ContractError) => inner instanceof ContractError);
}

function apiError(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    return typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Fail"
      ? ((cause as { error?: unknown }).error ?? cause)
      : cause;
  }

  return error;
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

export { errorMessage, isApiError, isRetryableApiError, runApi, SignOutFailed, signOut };
