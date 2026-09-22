import * as Context from "effect/Context";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

import { Unauthorized } from "./errors";
import { AuthUser, CliIdentity } from "./schemas";

/**
 * Middleware DEFINITIONS the contract's groups reference — the server
 * provides the implementations (apps/api/src/http/middleware), clients
 * see them only as error surface + OpenAPI metadata.
 */

class CurrentUser extends Context.Service<CurrentUser, typeof AuthUser.Type>()(
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
 */
class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: CurrentUser }>()(
  "@tokenmaxxing/api/Authorization",
  {
    error: Unauthorized,
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

class CurrentCliIdentity extends Context.Service<CurrentCliIdentity, typeof CliIdentity.Type>()(
  "@tokenmaxxing/api/CurrentCliIdentity",
) {}

/** CLI authentication: a `Bearer tmx_…` token resolved against cli_tokens. */
class CliAuth extends HttpApiMiddleware.Service<CliAuth, { provides: CurrentCliIdentity }>()(
  "@tokenmaxxing/api/CliAuth",
  {
    error: Unauthorized,
  },
) {}

export { AllowCliToken, Authorization, CliAuth, CurrentCliIdentity, CurrentUser };
