import { Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { loggedInAsMessage } from "../auth-validation";
import { humanConfirm, humanFrame } from "../output";
import { TerminalService } from "../services";
import { serviceInstallProgram } from "./service";
import {
  openProfileIfAvailable,
  resolveSyncAuth,
  syncProgram,
  type SyncAuth,
  type SyncResult,
} from "./sync";

class BootstrapServiceDecisionRequiredError extends Data.TaggedError(
  "BootstrapServiceDecisionRequiredError",
)<{}> {
  override message =
    "error: bootstrap needs a service decision in non-interactive terminals\nhint: run tokenmaxxing bootstrap --service yes or tokenmaxxing bootstrap --service no";
}

class BootstrapCancelledError extends Data.TaggedError("BootstrapCancelledError")<{}> {
  override message = "error: bootstrap cancelled";
}

class InvalidBootstrapServiceOptionError extends Data.TaggedError(
  "InvalidBootstrapServiceOptionError",
)<{
  readonly value: string;
}> {
  override get message() {
    return `error: invalid --service value: ${this.value}\nhint: use --service yes or --service no`;
  }
}

interface BootstrapOptions {
  service?: string | undefined;
}

interface BootstrapRuntime {
  confirmService?: () => Effect.Effect<boolean, unknown>;
  installService?: () => Effect.Effect<void, unknown>;
  openProfile?: (profileUrl: string) => Effect.Effect<void, unknown>;
  resolveAuth?: () => Effect.Effect<SyncAuth, unknown>;
  sync?: (auth: SyncAuth) => Effect.Effect<SyncResult, unknown>;
}

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    service: Flag.String("service").pipe(
      Flag.optional,
      Flag.withDescription("Whether to install automatic sync (yes or no)"),
    ),
  },
  ({ service }) =>
    bootstrapEffect({
      service: Option.getOrUndefined(service),
    }),
).pipe(Command.withDescription("Log in, sync usage, and optionally install automatic sync"));

function bootstrapEffect(options: BootstrapOptions) {
  return humanFrame("Bootstrap", {}, bootstrapProgram(options));
}

function bootstrapProgram(options: BootstrapOptions, runtime: BootstrapRuntime = {}) {
  return Effect.gen(function* () {
    const serviceDecision = yield* parseBootstrapServiceOption(options.service);
    const terminal = yield* Effect.service(TerminalService);
    if (serviceDecision === undefined && !(yield* terminal.isInteractive)) {
      return yield* Effect.fail(new BootstrapServiceDecisionRequiredError());
    }

    const auth = yield* (
      runtime.resolveAuth ??
      (() =>
        resolveSyncAuth({
          json: false,
          showStoredLoginSpinner: true,
          storedLoginSuccessMessage: loggedInAsMessage,
        }))
    )();

    const result = yield* (
      runtime.sync ?? ((syncAuth) => syncProgram({ auth: syncAuth, dryRun: false, json: false }))
    )(auth);
    const shouldInstallService =
      serviceDecision ??
      (yield* (
        runtime.confirmService ??
        (() =>
          humanConfirm(
            "Install automatic sync?",
            {},
            {
              cancelError: () => new BootstrapCancelledError(),
              defaultValue: true,
            },
          ))
      )());

    if (shouldInstallService) {
      yield* (
        runtime.installService ??
        (() =>
          serviceInstallProgram({
            force: false,
            refresh: false,
          }))
      )();
    }

    const profileUrl = result.profileUrl ?? `${auth.config.wwwUrl}/${auth.user.login}`;
    yield* (runtime.openProfile ?? openProfileIfAvailable)(profileUrl);
  });
}

function parseBootstrapServiceOption(value: string | undefined) {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") {
    return Effect.succeed(true);
  }

  if (normalized === "no") {
    return Effect.succeed(false);
  }

  return Effect.fail(new InvalidBootstrapServiceOptionError({ value }));
}

export {
  bootstrapCommand,
  bootstrapProgram,
  BootstrapCancelledError,
  BootstrapServiceDecisionRequiredError,
  InvalidBootstrapServiceOptionError,
  parseBootstrapServiceOption,
};

export type { BootstrapOptions, BootstrapRuntime };
