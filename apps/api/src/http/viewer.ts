import { Effect, Option } from "effect";

import type { AuthUser } from "@tokenmaxxing/api-contract";

import { CLI_TOKEN_PREFIX } from "../auth/crypto";
import { AuthService } from "../auth/service";
import { TokensService } from "../tokens/service";

interface ViewerOptions {
  /** Whether a `tmx_` CLI token may stand in for its account. */
  allowCliToken: boolean;
}

/**
 * The signed-in user behind a raw credential, if any. Callers choose where
 * the credential comes from (see sessionTokenFrom, or the session cookie
 * alone for the OAuth round trip); a browser session token resolves to its
 * user, and with `allowCliToken` a `tmx_` CLI token acts as the account it
 * belongs to. Resolution faults read as signed-out — callers decide whether
 * that is a 401 or an anonymous view.
 */
const resolveViewer = Effect.fn("resolveViewer")(
  function* (token: string | null, options: ViewerOptions) {
    if (token === null) {
      return Option.none<AuthUser>();
    }

    if (token.startsWith(CLI_TOKEN_PREFIX)) {
      if (!options.allowCliToken) {
        return Option.none<AuthUser>();
      }

      const tokens = yield* TokensService;
      const identity = yield* tokens.resolveCliToken(token);
      return Option.map(identity, ({ user }) => user);
    }

    const auth = yield* AuthService;
    return yield* auth.resolveSession(token);
  },
  Effect.catchCause(() => Effect.succeedNone),
);

export { resolveViewer };

export type { ViewerOptions };
