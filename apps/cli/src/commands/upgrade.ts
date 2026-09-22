import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import packageJson from "../../package.json";
import { booleanFlag } from "../flags";
import { humanFrame, humanSpinner, writeJson } from "../output";
import {
  autoUpdateCommandDescription,
  type AutoUpdateManager,
  type CommandInstall,
  findTokenmaxxingCommandInstall,
  isEphemeralCommandPath,
  isServiceInstalled,
  refreshServiceAfterUpdate,
  runPackageManagerUpdate,
  servicePathsEffect,
  type ServicePaths,
} from "./service";

type ServiceRefreshResult =
  | {
      _tag: "failed";
      cause: unknown;
    }
  | {
      _tag: "not-installed";
    }
  | {
      _tag: "refreshed";
    };

type VersionCheckResult =
  | {
      _tag: "available";
      currentVersion: string;
      latestVersion: string;
      shouldUpdate: boolean;
    }
  | {
      _tag: "unavailable";
      currentVersion: string;
      latestVersion: null;
    };

class UpgradeCommandNotFoundError extends Data.TaggedError("UpgradeCommandNotFoundError")<{}> {
  override message =
    "error: tokenmaxxing is not installed globally\nhint: install it with bun, npm, pnpm, or yarn";
}

class UpgradeEphemeralCommandError extends Data.TaggedError("UpgradeEphemeralCommandError")<{
  readonly commandPath: string;
}> {
  override get message() {
    return `error: tokenmaxxing resolved to a temporary runner path\npath: ${this.commandPath}\nhint: install it globally with bun, npm, pnpm, or yarn before running tokenmaxxing upgrade`;
  }
}

class UpgradeManagerError extends Data.TaggedError("UpgradeManagerError")<{
  readonly commandPath: string;
  readonly resolvedCommandPath: string;
}> {
  override get message() {
    return `error: could not detect how tokenmaxxing was globally installed\npath: ${this.commandPath}\nresolved path: ${this.resolvedCommandPath}\nhint: reinstall with bun, npm, pnpm, or yarn`;
  }
}

class UpgradeFailedError extends Data.TaggedError("UpgradeFailedError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to upgrade tokenmaxxing\nhint: try upgrading with your package manager";
}

class UpgradeVersionCheckError extends Data.TaggedError("UpgradeVersionCheckError")<{
  readonly cause: unknown;
}> {}

const npmLatestUrl = "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing/latest";

const upgradeCommand = Command.make(
  "upgrade",
  {
    json: booleanFlag("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => upgradeEffect({ json }),
).pipe(Command.withDescription("Upgrade the globally installed CLI"));

function upgradeEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame("Upgrade", options, upgradeProgram({}, options));
}

function upgradeProgram(
  runtime: {
    currentVersion?: string;
    env?: Record<string, string | undefined>;
    findCommandInstall?: () => Effect.Effect<CommandInstall | null, unknown>;
    getLatestVersion?: () => Effect.Effect<string, unknown>;
    home?: string;
    isServiceInstalled?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
    platform?: NodeJS.Platform;
    refreshService?: (options: { commandPath: string }) => Effect.Effect<void, unknown>;
    runPackageManagerUpdate?: (manager: AutoUpdateManager) => Effect.Effect<void, unknown>;
  } = {},
  options: { json?: boolean | undefined } = {},
) {
  return Effect.gen(function* () {
    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const installSpinner = yield* humanSpinner("Detecting install method", options);
    const install = yield* (
      runtime.findCommandInstall ?? (() => findTokenmaxxingCommandInstall(env, platform))
    )().pipe(
      Effect.flatMap((value) =>
        value === null ? Effect.fail(new UpgradeCommandNotFoundError()) : Effect.succeed(value),
      ),
      Effect.tapError(() =>
        Effect.sync(() => installSpinner.error("Could not detect install method")),
      ),
    );

    if (isEphemeralCommandPath(install.commandPath)) {
      yield* Effect.sync(() => installSpinner.error("Could not detect install method"));
      return yield* Effect.fail(
        new UpgradeEphemeralCommandError({ commandPath: install.commandPath }),
      );
    }

    const manager = install.autoUpdateManager;
    if (manager === null) {
      yield* Effect.sync(() => installSpinner.error("Could not detect install method"));
      return yield* Effect.fail(
        new UpgradeManagerError({
          commandPath: install.commandPath,
          resolvedCommandPath: install.resolvedCommandPath,
        }),
      );
    }
    yield* Effect.sync(() => installSpinner.stop(`Using method: ${manager}`));

    const command = autoUpdateCommandDescription(manager);
    const currentVersion = runtime.currentVersion ?? packageJson.version;
    const versionSpinner = yield* humanSpinner("Checking latest version", options);
    const versionCheck = yield* checkLatestVersion(
      currentVersion,
      runtime.getLatestVersion ?? getLatestCliVersion,
    );

    if (versionCheck._tag === "available" && !versionCheck.shouldUpdate) {
      yield* Effect.sync(() =>
        versionSpinner.stop(`No updates pending (${versionCheck.currentVersion}); upgrade skipped`),
      );
      if (options.json) {
        yield* writeJson({
          command,
          currentVersion: versionCheck.currentVersion,
          latestVersion: versionCheck.latestVersion,
          packageManager: manager,
          service: { status: "skipped" },
          skipped: true,
          status: "ok",
          updated: false,
          versionCheck: "ok",
        });
        return;
      }

      return;
    }

    if (versionCheck._tag === "available") {
      yield* Effect.sync(() =>
        versionSpinner.stop(`From ${versionCheck.currentVersion} -> ${versionCheck.latestVersion}`),
      );
    } else {
      yield* Effect.sync(() =>
        versionSpinner.stop("Could not check latest version; running upgrade anyway"),
      );
    }

    const upgradeSpinner = yield* humanSpinner(`Running ${command}`, options);
    yield* (runtime.runPackageManagerUpdate ?? runPackageManagerUpdate)(manager).pipe(
      Effect.tap(() => Effect.sync(() => upgradeSpinner.stop(formatUpgradeSuccess(versionCheck)))),
      Effect.tapError(() => Effect.sync(() => upgradeSpinner.error("Upgrade failed"))),
      Effect.mapError((cause) => new UpgradeFailedError({ cause })),
    );

    const refreshSpinner = yield* humanSpinner("Refreshing service", options);
    const refreshResult = yield* refreshInstalledService(install, runtime);
    if (refreshResult._tag === "failed") {
      yield* Effect.sync(() => refreshSpinner.error(formatServiceRefreshResult(refreshResult)));
    } else {
      yield* Effect.sync(() => refreshSpinner.stop(formatServiceRefreshResult(refreshResult)));
    }
    if (options.json) {
      yield* writeJson({
        command,
        currentVersion: versionCheck.currentVersion,
        latestVersion: versionCheck.latestVersion,
        packageManager: manager,
        service: serviceRefreshJson(refreshResult),
        skipped: false,
        status: "ok",
        updated: true,
        versionCheck: versionCheck._tag === "available" ? "ok" : "unavailable",
      });
      return;
    }
  });
}

function checkLatestVersion(
  currentVersion: string,
  getLatestVersion: () => Effect.Effect<string, unknown>,
): Effect.Effect<VersionCheckResult, never> {
  return getLatestVersion().pipe(
    Effect.match({
      onFailure: () => ({
        _tag: "unavailable" as const,
        currentVersion,
        latestVersion: null,
      }),
      onSuccess: (latestVersion) => ({
        _tag: "available" as const,
        currentVersion,
        latestVersion,
        shouldUpdate: shouldUpdateVersion(currentVersion, latestVersion),
      }),
    }),
  );
}

function getLatestCliVersion(): Effect.Effect<string, UpgradeVersionCheckError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(npmLatestUrl, {
          headers: {
            accept: "application/json",
          },
        }),
      catch: (cause) => new UpgradeVersionCheckError({ cause }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new UpgradeVersionCheckError({ cause: `registry returned ${response.status}` }),
      );
    }

    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new UpgradeVersionCheckError({ cause }),
    });
    const latestVersion = registryLatestVersion(body);
    if (latestVersion === null) {
      return yield* Effect.fail(
        new UpgradeVersionCheckError({ cause: "registry response missing version" }),
      );
    }

    return latestVersion;
  });
}

function formatUpgradeSuccess(versionCheck: VersionCheckResult): string {
  return versionCheck._tag === "available"
    ? `Upgraded to v${versionCheck.latestVersion}`
    : "Upgraded tokenmaxxing";
}

function registryLatestVersion(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("version" in body)) {
    return null;
  }

  const version = body.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function shouldUpdateVersion(currentVersion: string, latestVersion: string): boolean {
  if (currentVersion === latestVersion) {
    return false;
  }

  const comparison = compareStableVersions(currentVersion, latestVersion);
  return comparison === null ? true : comparison < 0;
}

function compareStableVersions(left: string, right: string): number | null {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  if (leftParts === null || rightParts === null) {
    return null;
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function stableVersionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function refreshInstalledService(
  install: CommandInstall,
  runtime: {
    env?: Record<string, string | undefined>;
    home?: string;
    isServiceInstalled?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
    platform?: NodeJS.Platform;
    refreshService?: (options: { commandPath: string }) => Effect.Effect<void, unknown>;
  },
): Effect.Effect<ServiceRefreshResult, never> {
  return Effect.gen(function* () {
    const paths = yield* servicePathsEffect(runtime.env, runtime.home, runtime.platform).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
    );
    if (paths === null) {
      return { _tag: "not-installed" as const };
    }

    const installed = yield* (runtime.isServiceInstalled ?? isServiceInstalled)(paths);
    if (!installed) {
      return { _tag: "not-installed" as const };
    }

    const result = yield* (runtime.refreshService ?? refreshServiceAfterUpdate)({
      commandPath: install.commandPath,
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failed" as const, cause }),
        onSuccess: () => ({ _tag: "refreshed" as const }),
      }),
    );

    return result;
  });
}

function formatServiceRefreshResult(result: ServiceRefreshResult): string {
  switch (result._tag) {
    case "failed":
      return "Service: refresh failed; run tokenmaxxing service install if needed";
    case "not-installed":
      return "Service: not installed";
    case "refreshed":
      return "Service: refreshed";
  }
}

function serviceRefreshJson(result: ServiceRefreshResult) {
  return result._tag === "failed"
    ? { status: result._tag, recoverable: true }
    : { status: result._tag };
}

export {
  formatServiceRefreshResult,
  formatUpgradeSuccess,
  refreshInstalledService,
  upgradeCommand,
  upgradeEffect,
  upgradeProgram,
  UpgradeCommandNotFoundError,
  UpgradeEphemeralCommandError,
  UpgradeFailedError,
  UpgradeManagerError,
};
