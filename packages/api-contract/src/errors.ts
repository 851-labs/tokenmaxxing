import * as Schema from "effect/Schema";

/**
 * Wire-level error catalog. Every error that crosses the HTTP boundary is a
 * Schema.TaggedError whose `httpApiStatus` annotation drives the
 * response status; the body is the encoded tagged struct ({ _tag, ...fields }).
 * Services fail with these directly — handlers declare them per endpoint and
 * pass them through untouched. Store/decode/infrastructure failures are NOT
 * here: those are defects (500) the services convert at their boundary.
 */

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { login: Schema.String },
  { httpApiStatus: 404 },
) {}

class AdminUserNotFound extends Schema.TaggedError<AdminUserNotFound>()(
  "AdminUserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class LoginCodeNotFound extends Schema.TaggedError<LoginCodeNotFound>()(
  "LoginCodeNotFound",
  { code: Schema.String },
  { httpApiStatus: 404 },
) {}

class LoginCodeExpired extends Schema.TaggedError<LoginCodeExpired>()(
  "LoginCodeExpired",
  { code: Schema.String },
  { httpApiStatus: 410 },
) {}

/** Pre-device-code CLI after the legacy login sunset: it must upgrade. */
class CliUpgradeRequired extends Schema.TaggedError<CliUpgradeRequired>()(
  "CliUpgradeRequired",
  { message: Schema.String },
  { httpApiStatus: 426 },
) {}

class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  "TokenNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class DeviceNotFound extends Schema.TaggedError<DeviceNotFound>()(
  "DeviceNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class DeviceMissing extends Schema.TaggedError<DeviceMissing>()(
  "DeviceMissing",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export {
  AdminUserNotFound,
  CliUpgradeRequired,
  DeviceNotFound,
  DeviceMissing,
  Forbidden,
  LoginCodeExpired,
  LoginCodeNotFound,
  TokenNotFound,
  Unauthorized,
  UserNotFound,
};
