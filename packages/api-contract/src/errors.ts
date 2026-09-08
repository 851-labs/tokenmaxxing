import * as Schema from "effect/Schema";

/**
 * Wire-level error catalog. Every error that crosses the HTTP boundary is a
 * Schema.TaggedErrorClass whose `httpApiStatus` annotation drives the
 * response status; the body is the encoded tagged struct ({ _tag, ...fields }).
 * Services fail with these directly — handlers declare them per endpoint and
 * pass them through untouched. Store/decode/infrastructure failures are NOT
 * here: those are defects (500) the services convert at their boundary.
 */

class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  { login: Schema.String },
  { httpApiStatus: 404 },
) {}

class AdminUserNotFound extends Schema.TaggedErrorClass<AdminUserNotFound>()(
  "AdminUserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class LoginCodeNotFound extends Schema.TaggedErrorClass<LoginCodeNotFound>()(
  "LoginCodeNotFound",
  { code: Schema.String },
  { httpApiStatus: 404 },
) {}

class LoginCodeExpired extends Schema.TaggedErrorClass<LoginCodeExpired>()(
  "LoginCodeExpired",
  { code: Schema.String },
  { httpApiStatus: 410 },
) {}

class TokenNotFound extends Schema.TaggedErrorClass<TokenNotFound>()(
  "TokenNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class DeviceNotFound extends Schema.TaggedErrorClass<DeviceNotFound>()(
  "DeviceNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class DeviceMissing extends Schema.TaggedErrorClass<DeviceMissing>()(
  "DeviceMissing",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

class InvalidUsage extends Schema.TaggedErrorClass<InvalidUsage>()(
  "InvalidUsage",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export {
  AdminUserNotFound,
  DeviceNotFound,
  DeviceMissing,
  Forbidden,
  InvalidUsage,
  LoginCodeExpired,
  LoginCodeNotFound,
  TokenNotFound,
  Unauthorized,
  UserNotFound,
};
