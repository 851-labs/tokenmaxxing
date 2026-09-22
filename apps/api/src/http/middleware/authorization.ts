import { Context, Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import {
  AllowCliToken,
  Authorization,
  CurrentUser,
  Unauthorized,
} from "@tokenmaxxing/api-contract";

import { sessionTokenFrom } from "../../auth/cookies";
import type { AuthService } from "../../auth/service";
import type { TokensService } from "../../tokens/service";
import { resolveViewer } from "../viewer";

/**
 * Request authentication for the session-guarded contract groups: the
 * session cookie (browsers) or a bearer session token. A `tmx_` CLI token
 * acts as the account it belongs to ONLY on endpoints annotated
 * `AllowCliToken` (whoami); everywhere else — admin, CLI-login approval,
 * device/token management — it is rejected, so a leaked CLI token cannot
 * mint more tokens or escalate beyond usage sync.
 *
 * Deliberately NOT an HttpApiSecurity-scheme middleware: the builder's
 * scheme fall-through re-runs the wrapped handler per scheme and treats the
 * handler's own domain failures as scheme failures, replacing them with the
 * last scheme's decode error. One plain middleware, one execution.
 */

const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const services = yield* Effect.context<AuthService | TokensService>();

    return Authorization.of((httpEffect, { endpoint }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const user = yield* resolveViewer(sessionTokenFrom(request), {
          allowCliToken: Context.get(endpoint.annotations, AllowCliToken),
        }).pipe(Effect.provideContext(services));
        if (Option.isNone(user)) {
          return yield* Effect.fail(new Unauthorized({ message: "Sign in required." }));
        }

        return yield* Effect.provideService(httpEffect, CurrentUser, user.value);
      }),
    );
  }),
);

export { AuthorizationLive };
