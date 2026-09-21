import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ApiClientService, ConfigService } from "../services";
import { humanFrame, humanLog, humanSpinner, writeJson } from "../output";

const logoutCommand = Command.make(
  "logout",
  {
    json: Flag.Boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => logoutEffect({ json }),
).pipe(Command.withDescription("Log out and revoke this device's CLI token"));

function logoutEffect(options: { json: boolean }) {
  return humanFrame(
    "Logout",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);
      const clients = yield* Effect.service(ApiClientService);

      const stored = yield* config.readConfig();
      const cleared = yield* config.clearToken();

      // Best-effort server-side revocation; local logout must succeed even
      // when the API is unreachable.
      if (cleared.token !== undefined) {
        const spinner = yield* humanSpinner("Logging out", options);
        yield* clients.make({ baseUrl: stored.apiUrl, token: cleared.token }).pipe(
          Effect.flatMap((client) => client.usage.logout()),
          Effect.ignore,
        );
        yield* Effect.sync(() => spinner.stop("Logged out"));
      }

      if (options.json) {
        yield* writeJson({ status: "ok", tokenCleared: cleared.tokenCleared });
      } else if (cleared.tokenCleared) {
        return;
      } else {
        yield* humanLog("info", "Not logged in; nothing to do", options);
      }
    }),
  );
}

export { logoutCommand, logoutEffect };
