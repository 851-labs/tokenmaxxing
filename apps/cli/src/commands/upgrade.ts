import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import packageJson from "../../package.json";
import {
  type DistTags,
  type DistTagVersion,
  fetchDistTags,
  LATEST_DIST_TAG,
  releaseChannel,
  resolveUpdate,
} from "../cli-version";
import { booleanFlag } from "../flags";
import { humanFrame, humanSpinner, writeJson } from "../output";
import {
  autoUpdateCommandDescription,
  type AutoUpdateManager,
  type CommandInstall,
  findTokenmaxxingCommandInstall,
  isEphemeralCommandPath,
  isServiceInstalled,
  packageManagerSpecifier,
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
      /** Highest version on the dist-tags this install follows (`latest`, plus its prerelease channel). */
      latestVersion: string;
      shouldUpdate: boolean;
      /** The dist-tag + version to install; null when already up to date. */
      target: DistTagVersion | null;
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

class UpgradePrereleaseVersionCheckError extends Data.TaggedError(
  "UpgradePrereleaseVersionCheckError",
)<{
  readonly currentVersion: string;
}> {
  override get message() {
    return `error: could not check the latest tokenmaxxing versions\ncurrent: ${this.currentVersion}\nhint: prereleases only upgrade after a successful registry check (installing latest could downgrade); retry when online`;
  }
}

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
    getDistTags?: () => Effect.Effect<DistTags, unknown>;
    home?: string;
    isServiceInstalled?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
    platform?: NodeJS.Platform;
    refreshService?: (options: { commandPath: string }) => Effect.Effect<void, unknown>;
    runPackageManagerUpdate?: (
      manager: AutoUpdateManager,
      specifier: string,
    ) => Effect.Effect<void, unknown>;
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

    const currentVersion = runtime.currentVersion ?? packageJson.version;
    const versionSpinner = yield* humanSpinner("Checking latest version", options);
    const versionCheck = yield* checkLatestVersion(
      currentVersion,
      runtime.getDistTags ?? (() => fetchDistTags()),
    );

    if (versionCheck._tag === "available" && versionCheck.target === null) {
      yield* Effect.sync(() =>
        versionSpinner.stop(`Already up to date (${versionCheck.currentVersion}); upgrade skipped`),
      );
      if (options.json) {
        yield* writeJson({
          command: autoUpdateCommandDescription(manager),
          currentVersion: versionCheck.currentVersion,
          distTag: null,
          latestVersion: versionCheck.latestVersion,
          packageManager: manager,
          service: { status: "skipped" },
          skipped: true,
          status: "ok",
          targetVersion: null,
          updated: false,
          versionCheck: "ok",
        });
        return;
      }

      return;
    }

    // Without a registry answer a stable install still runs `@latest` (it
    // cannot be ahead of it), but a prerelease could be ahead of `latest`.
    if (versionCheck._tag === "unavailable" && releaseChannel(currentVersion) !== LATEST_DIST_TAG) {
      yield* Effect.sync(() => versionSpinner.error("Could not check latest version"));
      return yield* Effect.fail(new UpgradePrereleaseVersionCheckError({ currentVersion }));
    }

    const target = versionCheck._tag === "available" ? versionCheck.target : null;
    const specifier = target === null ? LATEST_DIST_TAG : packageManagerSpecifier(target);
    const command = autoUpdateCommandDescription(manager, specifier);
    if (target !== null) {
      yield* Effect.sync(() =>
        versionSpinner.stop(`From ${versionCheck.currentVersion} -> ${target.version}`),
      );
    } else {
      yield* Effect.sync(() =>
        versionSpinner.stop("Could not check latest version; running upgrade anyway"),
      );
    }

    const upgradeSpinner = yield* humanSpinner(`Running ${command}`, options);
    yield* (runtime.runPackageManagerUpdate ?? runPackageManagerUpdate)(manager, specifier).pipe(
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
        distTag: target?.distTag ?? null,
        latestVersion: versionCheck.latestVersion,
        packageManager: manager,
        service: serviceRefreshJson(refreshResult),
        skipped: false,
        status: "ok",
        targetVersion: target?.version ?? null,
        updated: true,
        versionCheck: versionCheck._tag === "available" ? "ok" : "unavailable",
      });
      return;
    }
  });
}

function checkLatestVersion(
  currentVersion: string,
  getDistTags: () => Effect.Effect<DistTags, unknown>,
): Effect.Effect<VersionCheckResult, never> {
  const unavailable = {
    _tag: "unavailable" as const,
    currentVersion,
    latestVersion: null,
  };

  return getDistTags().pipe(
    Effect.match({
      onFailure: () => unavailable,
      onSuccess: (distTags): VersionCheckResult => {
        const { newest, update } = resolveUpdate(currentVersion, distTags);
        return newest === null
          ? unavailable
          : {
              _tag: "available",
              currentVersion,
              latestVersion: newest.version,
              shouldUpdate: update !== null,
              target: update,
            };
      },
    }),
  );
}

function formatUpgradeSuccess(versionCheck: VersionCheckResult): string {
  return versionCheck._tag === "available"
    ? `Upgraded to v${versionCheck.latestVersion}`
    : "Upgraded tokenmaxxing";
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
  UpgradePrereleaseVersionCheckError,
};
