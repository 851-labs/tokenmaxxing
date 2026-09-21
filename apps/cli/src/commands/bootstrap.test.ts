import { Cause, Effect, Layer } from "effect";
import type { AuthUser } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vite-plus/test";

import { ConsoleService, TerminalService, type TokenmaxxingApiClient } from "../services";
import {
  bootstrapProgram,
  BootstrapCancelledError,
  parseBootstrapServiceOption,
  type BootstrapRuntime,
} from "./bootstrap";
import type { SyncAuth, SyncResult } from "./sync";

const user: AuthUser = {
  avatarUrl: null,
  id: "user_123",
  login: "alex",
  name: null,
};

const auth: SyncAuth = {
  authSource: "login",
  client: {} as TokenmaxxingApiClient,
  config: {
    apiUrl: "https://api.tokenmaxxing.example",
    token: "tmx_test",
    wwwUrl: "https://tokenmaxxing.example",
  },
  user,
};

const syncResult: SyncResult = {
  dryRun: false,
  profileUrl: "https://tokenmaxxing.example/alex",
  rows: 12,
  sourceResults: [],
  sources: {},
  status: "ok",
  upserted: 12,
};

function servicesLayer(interactive: boolean, logs: string[] = [], errors: string[] = []) {
  return Layer.mergeAll(
    Layer.succeed(TerminalService)({
      canOpenExternalBrowser: Effect.succeed(interactive),
      isInteractive: Effect.succeed(interactive),
    }),
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        errors.push(String(message));
      },
      log: (message?: unknown) => {
        logs.push(String(message));
      },
    }),
  );
}

function failureTag(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>) {
  if (exit._tag !== "Failure") {
    return undefined;
  }

  const error = Cause.findErrorOption(exit.cause);
  return error._tag === "Some" ? (error.value as { _tag?: string })._tag : undefined;
}

function testRuntime(
  options: {
    auth?: SyncAuth;
    confirm?: boolean | Effect.Effect<boolean, unknown>;
    sync?: SyncResult;
  } = {},
) {
  const calls: string[] = [];
  const runtime: BootstrapRuntime = {
    confirmService: () => {
      calls.push("confirm");
      return Effect.isEffect(options.confirm)
        ? options.confirm
        : Effect.succeed(options.confirm ?? true);
    },
    installService: () =>
      Effect.sync(() => {
        calls.push("install-service");
      }),
    openProfile: (profileUrl) =>
      Effect.sync(() => {
        calls.push(`open:${profileUrl}`);
      }),
    resolveAuth: () =>
      Effect.sync(() => {
        calls.push("auth");
        return options.auth ?? auth;
      }),
    sync: (syncAuth) =>
      Effect.sync(() => {
        calls.push(`sync:${syncAuth.user.login}`);
        return options.sync ?? syncResult;
      }),
  };

  return { calls, runtime };
}

function runBootstrap(
  effect: Effect.Effect<undefined, unknown, unknown>,
  options: { interactive: boolean },
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(servicesLayer(options.interactive))) as Effect.Effect<
      undefined,
      unknown,
      never
    >,
  );
}

function runBootstrapExit(
  effect: Effect.Effect<undefined, unknown, unknown>,
  options: { interactive: boolean },
) {
  return Effect.runPromiseExit(
    effect.pipe(Effect.provide(servicesLayer(options.interactive))) as Effect.Effect<
      undefined,
      unknown,
      never
    >,
  );
}

describe("bootstrapProgram", () => {
  it("logs in, syncs, prompts for service install, installs, and opens the profile", async () => {
    const { calls, runtime } = testRuntime({ confirm: true });

    await runBootstrap(bootstrapProgram({}, runtime), { interactive: true });

    expect(calls).toEqual([
      "auth",
      "sync:alex",
      "confirm",
      "install-service",
      "open:https://tokenmaxxing.example/alex",
    ]);
  });

  it("continues when bootstrap starts from a stored login", async () => {
    const logs: string[] = [];
    const { calls, runtime } = testRuntime({
      auth: {
        ...auth,
        authSource: "stored",
      },
      confirm: false,
    });

    await Effect.runPromise(
      bootstrapProgram({}, runtime).pipe(
        Effect.provide(servicesLayer(true, logs)),
      ) as Effect.Effect<undefined, unknown, never>,
    );

    expect(calls).toEqual([
      "auth",
      "sync:alex",
      "confirm",
      "open:https://tokenmaxxing.example/alex",
    ]);
    expect(logs).toEqual([]);
  });

  it("uses --service yes without prompting and works in non-interactive terminals", async () => {
    const { calls, runtime } = testRuntime();

    await runBootstrap(bootstrapProgram({ service: "yes" }, runtime), { interactive: false });

    expect(calls).toEqual([
      "auth",
      "sync:alex",
      "install-service",
      "open:https://tokenmaxxing.example/alex",
    ]);
  });

  it("uses --service no without prompting or installing", async () => {
    const { calls, runtime } = testRuntime();

    await runBootstrap(bootstrapProgram({ service: "no" }, runtime), { interactive: true });

    expect(calls).toEqual(["auth", "sync:alex", "open:https://tokenmaxxing.example/alex"]);
  });

  it("fails before login when non-interactive callers omit --service", async () => {
    const { calls, runtime } = testRuntime();

    const exit = await runBootstrapExit(bootstrapProgram({}, runtime), { interactive: false });

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("BootstrapServiceDecisionRequiredError");
    expect(calls).toEqual([]);
  });

  it("propagates prompt cancellation without installing or opening the profile", async () => {
    const { calls, runtime } = testRuntime({
      confirm: Effect.fail(new BootstrapCancelledError()),
    });

    const exit = await runBootstrapExit(bootstrapProgram({}, runtime), { interactive: true });

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("BootstrapCancelledError");
    expect(calls).toEqual(["auth", "sync:alex", "confirm"]);
  });

  it("opens the authenticated user's profile when sync has no profile URL", async () => {
    const { calls, runtime } = testRuntime({
      confirm: false,
      sync: { ...syncResult, profileUrl: undefined, rows: 0, upserted: undefined },
    });

    await runBootstrap(bootstrapProgram({}, runtime), { interactive: true });

    expect(calls).toEqual([
      "auth",
      "sync:alex",
      "confirm",
      "open:https://tokenmaxxing.example/alex",
    ]);
  });
});

describe("parseBootstrapServiceOption", () => {
  it("accepts yes and no values", async () => {
    await expect(Effect.runPromise(parseBootstrapServiceOption("yes"))).resolves.toBe(true);
    await expect(Effect.runPromise(parseBootstrapServiceOption("no"))).resolves.toBe(false);
    await expect(
      Effect.runPromise(parseBootstrapServiceOption(undefined)),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid values", async () => {
    const exit = await Effect.runPromiseExit(parseBootstrapServiceOption("maybe"));

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("InvalidBootstrapServiceOptionError");
  });
});
