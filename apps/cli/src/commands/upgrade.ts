import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import packageJson from "../../package.json";
import {
  type DistTags,
  type DistTagVersion,
  fetchDistTags,
  LATEST_DIST_TAG,
  parseSemVer,
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
  npmUpdatePrefix,
  type PackageManagerUpdateOptions,
  PackageManagerUpdateError,
  readInstalledCliVersion,
  readNpmConfiguredPrefix,
  refreshServiceAfterUpdate,
  runPackageManagerUpdate,
  serviceDefinitionUsesConfigDir,
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
      /** The scheduler definition under HOME runs another config dir's wrapper. */
      _tag: "other-config-dir";
    }
  | {
      _tag: "refreshed";
    };

type VersionCheckResult =
  | {
      _tag: "available";
      /** The dist-tag this install follows: its prerelease channel (`alpha`), or `latest`. */
      channel: string;
      /** Version on `channel`; null when the tag is missing or malformed. */
      channelVersion: string | null;
      currentVersion: string;
      /** Version on npm's `latest` dist-tag; null when the tag is missing or malformed. */
      latestVersion: string | null;
      shouldUpdate: boolean;
      /** The dist-tag + version to install; null when already up to date. */
      target: DistTagVersion | null;
    }
  | {
      _tag: "unavailable";
      channel: string;
      channelVersion: null;
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
  readonly command: string;
}> {
  override get message() {
    const output = this.output;
    return [
      "error: failed to upgrade tokenmaxxing",
      `command: ${this.command}`,
      ...(output.length > 0 ? output.split("\n") : []),
      "hint: a release can take a few minutes to reach every registry mirror; retry shortly, or run the command above yourself",
    ].join("\n");
  }

  get jsonFields() {
    return { command: this.command, output: this.output };
  }

  // What the package manager printed (e.g. npm's ETARGET), so the failure
  // is actionable without rerunning the command by hand.
  private get output(): string {
    return this.cause instanceof PackageManagerUpdateError
      ? this.cause.timedOut
        ? `${this.cause.command.split(" ")[0]} did not finish in time`
        : this.cause.output
      : "";
  }
}

/**
 * The package manager exited 0, but the `tokenmaxxing` on PATH is not the
 * version it was asked to install (or its version could not be read).
 */
class UpgradeVerificationError extends Data.TaggedError("UpgradeVerificationError")<{
  readonly command: string;
  readonly commandPath: string;
  readonly expectedVersion: string;
  readonly installedVersion: string | null;
}> {
  override get message() {
    const summary =
      this.installedVersion === null
        ? `error: could not confirm the upgrade to ${this.expectedVersion}; ${this.commandPath} --version failed`
        : `error: upgrade did not take effect; tokenmaxxing is ${this.installedVersion}, expected ${this.expectedVersion}`;
    return `${summary}\ncommand: ${this.command}\npath: ${this.commandPath}\nhint: run tokenmaxxing --version; if it is still old, run the command above yourself or check which -a tokenmaxxing`;
  }

  get jsonFields() {
    return {
      command: this.command,
      commandPath: this.commandPath,
      expectedVersion: this.expectedVersion,
      installedVersion: this.installedVersion,
    };
  }
}

/** A stable install cannot upgrade without knowing the exact version to install. */
class UpgradeVersionCheckError extends Data.TaggedError("UpgradeVersionCheckError")<{
  readonly currentVersion: string;
}> {
  override get message() {
    return `error: could not check the latest tokenmaxxing version\ncurrent: ${this.currentVersion}\nhint: upgrade installs the exact version the registry reports; retry when online`;
  }
}

class UpgradePrereleaseVersionCheckError extends Data.TaggedError(
  "UpgradePrereleaseVersionCheckError",
)<{
  readonly currentVersion: string;
}> {
  override get message() {
    return `error: could not check the latest tokenmaxxing versions\ncurrent: ${this.currentVersion}\nhint: upgrade installs the exact version the registry reports; retry when online`;
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
    readInstalledVersion?: (commandPath: string) => Effect.Effect<string | null, never>;
    readNpmPrefix?: () => Effect.Effect<string | null, never>;
    refreshService?: (options: { commandPath: string }) => Effect.Effect<void, unknown>;
    runPackageManagerUpdate?: (
      manager: AutoUpdateManager,
      version: string,
      options?: PackageManagerUpdateOptions,
    ) => Effect.Effect<void, unknown>;
    serviceUsesConfigDir?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
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

    // Without a registry answer there is no exact version to install, and a
    // dist-tag is resolved from the package manager's own (possibly stale)
    // cache, which can install an older release and still exit 0.
    if (versionCheck._tag === "unavailable") {
      yield* Effect.sync(() => versionSpinner.error("Could not check latest version"));
      return yield* Effect.fail(
        releaseChannel(currentVersion) === LATEST_DIST_TAG
          ? new UpgradeVersionCheckError({ currentVersion })
          : new UpgradePrereleaseVersionCheckError({ currentVersion }),
      );
    }

    const target = versionCheck.target;
    if (target === null) {
      yield* Effect.sync(() =>
        versionSpinner.stop(`Already up to date (${versionCheck.currentVersion})`),
      );
      if (options.json) {
        yield* writeJson({
          channel: versionCheck.channel,
          channelVersion: versionCheck.channelVersion,
          // Nothing runs, so there is no command to report.
          command: null,
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

    // A `npm i -g --prefix <dir>` install is updated in <dir>, not in npm's
    // default prefix (a second copy that PATH never reaches).
    const updateOptions: PackageManagerUpdateOptions =
      manager === "npm"
        ? {
            npmPrefix: npmUpdatePrefix(
              install,
              yield* (runtime.readNpmPrefix ?? readNpmConfiguredPrefix)(),
              platform,
            ),
          }
        : {};
    const command = autoUpdateCommandDescription(manager, target.version, updateOptions);
    yield* Effect.sync(() =>
      versionSpinner.stop(`From ${versionCheck.currentVersion} -> ${target.version}`),
    );

    const upgradeSpinner = yield* humanSpinner(`Running ${command}`, options);
    yield* (runtime.runPackageManagerUpdate ?? runPackageManagerUpdate)(
      manager,
      target.version,
      updateOptions,
    ).pipe(
      Effect.tapError(() => Effect.sync(() => upgradeSpinner.error("Upgrade failed"))),
      Effect.mapError((cause) => new UpgradeFailedError({ cause, command })),
    );

    // Never report an upgrade that did not land: the package manager's exit
    // code alone has claimed success while leaving the old version installed.
    const installedVersion = yield* (runtime.readInstalledVersion ?? readInstalledCliVersion)(
      install.commandPath,
    );
    if (installedVersion === null || !sameVersion(installedVersion, target.version)) {
      yield* Effect.sync(() => upgradeSpinner.error("Upgrade did not take effect"));
      return yield* Effect.fail(
        new UpgradeVerificationError({
          command,
          commandPath: install.commandPath,
          expectedVersion: target.version,
          installedVersion,
        }),
      );
    }
    yield* Effect.sync(() => upgradeSpinner.stop(formatUpgradeSuccess(target.version)));

    const refreshSpinner = yield* humanSpinner("Refreshing service", options);
    const refreshResult = yield* refreshInstalledService(install, runtime);
    if (refreshResult._tag === "failed") {
      yield* Effect.sync(() => refreshSpinner.error(formatServiceRefreshResult(refreshResult)));
    } else {
      yield* Effect.sync(() => refreshSpinner.stop(formatServiceRefreshResult(refreshResult)));
    }
    if (options.json) {
      yield* writeJson({
        channel: versionCheck.channel,
        channelVersion: versionCheck.channelVersion,
        command,
        currentVersion: versionCheck.currentVersion,
        distTag: target.distTag,
        installedVersion,
        latestVersion: versionCheck.latestVersion,
        packageManager: manager,
        service: serviceRefreshJson(refreshResult),
        skipped: false,
        status: "ok",
        targetVersion: target.version,
        updated: true,
        versionCheck: "ok",
      });
      return;
    }
  });
}

function checkLatestVersion(
  currentVersion: string,
  getDistTags: () => Effect.Effect<DistTags, unknown>,
): Effect.Effect<VersionCheckResult, never> {
  const channel = releaseChannel(currentVersion);
  const unavailable = {
    _tag: "unavailable" as const,
    channel,
    channelVersion: null,
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
              channel,
              channelVersion: wellFormedDistTagVersion(distTags, channel),
              currentVersion,
              latestVersion: wellFormedDistTagVersion(distTags, LATEST_DIST_TAG),
              shouldUpdate: update !== null,
              target: update,
            };
      },
    }),
  );
}

function wellFormedDistTagVersion(distTags: DistTags, distTag: string): string | null {
  const version = distTags[distTag];
  return version !== undefined && parseSemVer(version) !== null ? version : null;
}

function formatUpgradeSuccess(version: string): string {
  return `Upgraded to v${version}`;
}

function sameVersion(left: string, right: string): boolean {
  const normalize = (version: string) => version.trim().replace(/^v/i, "").replace(/\+.*/, "");
  return normalize(left) === normalize(right);
}

function refreshInstalledService(
  install: CommandInstall,
  runtime: {
    env?: Record<string, string | undefined>;
    home?: string;
    isServiceInstalled?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
    platform?: NodeJS.Platform;
    refreshService?: (options: { commandPath: string }) => Effect.Effect<void, unknown>;
    serviceUsesConfigDir?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
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

    // `service install --refresh` would point that definition at this
    // config dir, taking the service over from whoever installed it.
    const ownsService = yield* (runtime.serviceUsesConfigDir ?? serviceDefinitionUsesConfigDir)(
      paths,
    );
    if (!ownsService) {
      return { _tag: "other-config-dir" as const };
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
    case "other-config-dir":
      return "Service: left alone; the installed service uses another config dir";
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
  UpgradeVerificationError,
  UpgradeVersionCheckError,
};
