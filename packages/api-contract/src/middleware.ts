import * as Context from "effect/Context";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

import {
  BadRequest,
  InternalServerError,
  ServiceUnavailable,
  Unauthorized,
  UnsupportedMediaType,
} from "./errors";
import type { AuthUser, CliIdentity } from "./schemas";

/**
 * Middleware DEFINITIONS the contract's groups reference — the server
 * provides the implementations (apps/api/src/http/middleware), clients
 * see them only as error surface + OpenAPI metadata.
 */

class CurrentUser extends Context.Service<CurrentUser, AuthUser>()(
  "@tokenmaxxing/api/CurrentUser",
) {}

/**
 * Browser authentication: the session cookie (or a bearer session token).
 * A `tmx_` CLI token is rejected unless the endpoint opts in with
 * `AllowCliToken` — CLI tokens must never reach admin, CLI-login approval
 * (which mints more tokens), or device/token management.
 * Deliberately NOT an HttpApiSecurity-scheme middleware: the builder's
 * scheme fall-through re-runs the wrapped handler per scheme and replaces
 * its domain failures with the last scheme's decode error.
 *
 * Unauthorized means the credential is missing, unknown, revoked or expired;
 * ServiceUnavailable means it could not be checked (keep it and retry).
 */
class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: CurrentUser }>()(
  "@tokenmaxxing/api/Authorization",
  {
    error: [Unauthorized, ServiceUnavailable],
  },
) {}

/**
 * Endpoint annotation: lets `Authorization` accept a `tmx_` CLI token as the
 * account it belongs to. Default false — opt in only for read-only identity
 * endpoints the CLI calls (`tokenmaxxing whoami`, auth validation).
 */
const AllowCliToken = Context.Reference<boolean>("@tokenmaxxing/api/AllowCliToken", {
  defaultValue: () => false,
});

class CurrentCliIdentity extends Context.Service<CurrentCliIdentity, CliIdentity>()(
  "@tokenmaxxing/api/CurrentCliIdentity",
) {}

/**
 * CLI authentication: a `Bearer tmx_…` token resolved against cli_tokens.
 * Unauthorized only when the token is missing, unknown or revoked — the CLI
 * discards its token on it — and ServiceUnavailable when the lookup failed.
 */
class CliAuth extends HttpApiMiddleware.Service<CliAuth, { provides: CurrentCliIdentity }>()(
  "@tokenmaxxing/api/CliAuth",
  {
    error: [Unauthorized, ServiceUnavailable],
  },
) {}

/**
 * Applied to every endpoint: turns request decode failures into BadRequest,
 * an unsupported request content-type into UnsupportedMediaType, and
 * unexpected server faults into InternalServerError, so these render as
 * typed `{ _tag, message }` bodies like every other contract error.
 */
class ErrorBoundary extends HttpApiMiddleware.Service<ErrorBoundary>()(
  "@tokenmaxxing/api/ErrorBoundary",
  {
    error: [BadRequest, UnsupportedMediaType, InternalServerError],
  },
) {}

export { AllowCliToken, Authorization, CliAuth, CurrentCliIdentity, CurrentUser, ErrorBoundary };
