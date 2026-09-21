import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ApiClientService, ConfigService } from "../services";
import { humanFrame, humanSpinner, writeJson } from "../output";
import { isUnauthorizedError } from "../auth-validation";

class NotLoggedInError extends Data.TaggedError("NotLoggedInError")<{}> {
  override message = "error: not logged in\nhint: run tokenmaxxing login";
}

class WhoamiError extends Data.TaggedError("WhoamiError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to fetch the signed-in user\nhint: run tokenmaxxing login again";
}

const whoamiCommand = Command.make(
  "whoami",
  {
    json: Flag.Boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => whoamiEffect({ json }),
).pipe(Command.withDescription("Show the signed-in user"));

function whoamiEffect(options: { json: boolean }) {
  return humanFrame(
    "Account",
    options,
    Effect.gen(function* () {
      const config = yield* Effect.service(ConfigService);
      const clients = yield* Effect.service(ApiClientService);

      const stored = yield* config.readConfig();
      if (stored.token === undefined) {
        return yield* Effect.fail(new NotLoggedInError());
      }

      const client = yield* clients.make({ baseUrl: stored.apiUrl, token: stored.token });
      const spinner = yield* humanSpinner("Fetching account", options);
      const me = yield* client.me.me().pipe(
        Effect.mapError((cause) =>
          isUnauthorizedError(cause) ? new NotLoggedInError() : new WhoamiError({ cause }),
        ),
        Effect.tapError(() => Effect.sync(() => spinner.error("Could not fetch account"))),
      );

      if (options.json) {
        yield* writeJson({ user: me.user });
      } else {
        const label = me.user.name === null ? me.user.login : `${me.user.login} (${me.user.name})`;
        yield* Effect.sync(() => spinner.stop(label));
      }
    }),
  );
}

export { NotLoggedInError, whoamiCommand, whoamiEffect };
