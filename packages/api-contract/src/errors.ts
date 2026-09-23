import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DeviceId, TokenId, UserId } from "./schemas";

/**
 * Wire-level error catalog. Every error that crosses the HTTP boundary is a
 * Schema.TaggedError whose `httpApiStatus` annotation drives the
 * response status; the body is the encoded tagged struct ({ _tag, ...fields }).
 * Services fail with these directly — handlers declare them per endpoint and
 * pass them through untouched. Store/decode/infrastructure failures are
 * defects the services convert at their boundary; the server renders them as
 * InternalServerError (or ServiceUnavailable while resolving credentials).
 *
 * The request-level errors (BadRequest, UnsupportedMediaType, RouteNotFound,
 * MethodNotAllowed, InternalServerError, ServiceUnavailable) are produced by
 * the server's HTTP stack rather than by services, so every non-2xx response
 * shares the same `{ _tag, message }` envelope.
 *
 * Every error carries a human-readable `message`, defaulted per class so call
 * sites only override it when they know more. Adding it was safe for released
 * CLIs (their frozen decoders ignore unknown fields); wire `_tag`s are frozen,
 * because CLIs branch on them.
 */

function message(text: string) {
  return Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed(text)));
}

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: message("Sign in required.") },
  { httpApiStatus: 401 },
) {}

class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: message("You do not have access to this.") },
  { httpApiStatus: 403 },
) {}

class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { login: Schema.String, message: message("User not found.") },
  { httpApiStatus: 404 },
) {}

class AdminUserNotFound extends Schema.TaggedError<AdminUserNotFound>()(
  "AdminUserNotFound",
  { id: UserId, message: message("User not found.") },
  { httpApiStatus: 404 },
) {}

class LoginCodeNotFound extends Schema.TaggedError<LoginCodeNotFound>()(
  "LoginCodeNotFound",
  {
    code: Schema.String,
    message: message("Login code not found; run `tokenmaxxing login` again."),
  },
  { httpApiStatus: 404 },
) {}

class LoginCodeExpired extends Schema.TaggedError<LoginCodeExpired>()(
  "LoginCodeExpired",
  {
    code: Schema.String,
    message: message("Login code expired; run `tokenmaxxing login` again."),
  },
  { httpApiStatus: 410 },
) {}

/** Pre-device-code CLI after the legacy login sunset: it must upgrade. */
class CliUpgradeRequired extends Schema.TaggedError<CliUpgradeRequired>()(
  "CliUpgradeRequired",
  { message: message("This CLI is too old to sign in; upgrade tokenmaxxing.") },
  { httpApiStatus: 426 },
) {}

class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  "TokenNotFound",
  { id: TokenId, message: message("Token not found or already revoked.") },
  { httpApiStatus: 404 },
) {}

/** A device the signed-in user tried to act on does not exist (or is not theirs). */
class DeviceNotFound extends Schema.TaggedError<DeviceNotFound>()(
  "DeviceNotFound",
  { id: DeviceId, message: message("Device not found or already deleted.") },
  { httpApiStatus: 404 },
) {}

/**
 * The CLI's bearer token was minted without a device, so usage cannot be
 * attributed. The wire tag keeps its original `DeviceMissing` name because
 * released CLIs decode it.
 */
class TokenDeviceUnbound extends Schema.TaggedError<TokenDeviceUnbound>()(
  "DeviceMissing",
  {
    message: message("This token has no device; run `tokenmaxxing login` to mint a new one."),
  },
  { httpApiStatus: 400 },
) {}

/** A path parameter, header, query parameter or body failed to decode. The
 * message names the failing field, never the decoder's internals. */
class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: message("Invalid request.") },
  { httpApiStatus: 400 },
) {}

class UnsupportedMediaType extends Schema.TaggedError<UnsupportedMediaType>()(
  "UnsupportedMediaType",
  { message: message("Send the request body as application/json.") },
  { httpApiStatus: 415 },
) {}

/** No route matches the request path under any method. */
class RouteNotFound extends Schema.TaggedError<RouteNotFound>()(
  "RouteNotFound",
  { message: message("No such endpoint.") },
  { httpApiStatus: 404 },
) {}

/** The path exists, but not for this method; the `allow` header lists the
 * methods that do. */
class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()(
  "MethodNotAllowed",
  { message: message("Method not allowed for this endpoint.") },
  { httpApiStatus: 405 },
) {}

/** An unexpected server fault. Details are logged under the response's
 * x-request-id, never sent. */
class InternalServerError extends Schema.TaggedError<InternalServerError>()(
  "InternalServerError",
  { message: message("Something went wrong on our side; try again later.") },
  { httpApiStatus: 500 },
) {}

/**
 * A dependency (the database) failed while resolving credentials. Distinct
 * from Unauthorized on purpose: clients must keep their token and retry,
 * not treat an outage as a revoked login.
 */
class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  "ServiceUnavailable",
  { message: message("Temporarily unavailable; try again shortly.") },
  { httpApiStatus: 503 },
) {}

/** Every wire error class — the single source for the `ApiError` union. */
const ApiErrors = [
  AdminUserNotFound,
  BadRequest,
  CliUpgradeRequired,
  DeviceNotFound,
  Forbidden,
  InternalServerError,
  LoginCodeExpired,
  LoginCodeNotFound,
  MethodNotAllowed,
  RouteNotFound,
  ServiceUnavailable,
  TokenDeviceUnbound,
  TokenNotFound,
  Unauthorized,
  UnsupportedMediaType,
  UserNotFound,
] as const;

type ApiError = InstanceType<(typeof ApiErrors)[number]>;

type ApiErrorTag = ApiError["_tag"];

export {
  AdminUserNotFound,
  ApiErrors,
  BadRequest,
  CliUpgradeRequired,
  DeviceNotFound,
  Forbidden,
  InternalServerError,
  LoginCodeExpired,
  LoginCodeNotFound,
  MethodNotAllowed,
  RouteNotFound,
  ServiceUnavailable,
  TokenDeviceUnbound,
  TokenNotFound,
  Unauthorized,
  UnsupportedMediaType,
  UserNotFound,
};

export type { ApiError, ApiErrorTag };
