import { Context } from "effect";
import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import {
  AllowCliToken,
  Authorization,
  CurrentUser,
  Unauthorized,
} from "@tokenmaxxing/api-contract";
import type { AuthUser } from "@tokenmaxxing/api-contract";

import { CLI_TOKEN_PREFIX } from "../../auth/crypto";
import { sessionTokenFrom } from "../../auth/cookies";
import { AuthService } from "../../auth/service";
import { TokensService } from "../../tokens/service";

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
    const auth = yield* AuthService;
    const tokens = yield* TokensService;

    const resolve = Effect.fn("Authorization.resolve")(function* (
      token: string,
      allowCliToken: boolean,
    ) {
      if (token.startsWith(CLI_TOKEN_PREFIX)) {
        if (!allowCliToken) {
          return Option.none<AuthUser>();
        }

        const identity = yield* tokens.resolveCliToken(token);
        return Option.map(identity, ({ user }) => user);
      }

      return yield* auth.resolveSession(token);
    });

    return Authorization.of((httpEffect, { endpoint }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = sessionTokenFrom(request);
        const allowCliToken = Context.get(endpoint.annotations, AllowCliToken);
        const user =
          token === null
            ? Option.none<AuthUser>()
            : yield* resolve(token, allowCliToken).pipe(
                Effect.catchCause(() => Effect.succeedNone),
              );
        if (Option.isNone(user)) {
          return yield* Effect.fail(new Unauthorized({ message: "Sign in required." }));
        }

        return yield* Effect.provideService(httpEffect, CurrentUser, user.value);
      }),
    );
  }),
);

export { AuthorizationLive };
