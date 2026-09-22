import { Data, Effect, Option } from "effect";

import { ServiceUnavailable, type AuthUser } from "@tokenmaxxing/api-contract";

import { CLI_TOKEN_PREFIX } from "../auth/crypto";
import { AuthService } from "../auth/service";
import { TokensService } from "../tokens/service";

/**
 * The credential could not be checked (the store failed). Never a reason to
 * treat the caller as signed out: a 401 makes the CLI discard its token.
 */
class CredentialLookupFailed extends Data.TaggedError("CredentialLookupFailed")<{
  readonly defect: unknown;
}> {}

interface ViewerOptions {
  /** Whether a `tmx_` CLI token may stand in for its account. */
  allowCliToken: boolean;
}

/**
 * The signed-in user behind a raw credential, if any. Callers choose where
 * the credential comes from (see sessionTokenFrom, or the session cookie
 * alone for the OAuth round trip); a browser session token resolves to its
 * user, and with `allowCliToken` a `tmx_` CLI token acts as the account it
 * belongs to. Unknown, revoked and expired credentials resolve to none;
 * store faults fail with CredentialLookupFailed, and callers decide whether
 * that is a 503 or an anonymous view.
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
  Effect.catchDefect((defect) => Effect.fail(new CredentialLookupFailed({ defect }))),
);

/** Answers a failed credential lookup: logged, and a 503 the client retries
 * with the same credential. */
function credentialLookupUnavailable(defect: unknown) {
  return Effect.logError("credential lookup failed", defect).pipe(
    Effect.andThen(
      Effect.fail(
        new ServiceUnavailable({
          message: "Could not verify your credentials; try again shortly.",
        }),
      ),
    ),
  );
}

export { CredentialLookupFailed, credentialLookupUnavailable, resolveViewer };

export type { ViewerOptions };
