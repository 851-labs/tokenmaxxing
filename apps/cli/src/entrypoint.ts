import { constants } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer } from "effect";
import * as Runtime from "effect/Runtime";

import { runTokenmaxxingCommand } from "./commands/root";
import { isJsonArgv, isVerboseArgv, renderCliFailure } from "./errors";
import { CliServicesLive } from "./services";

const rootArgvStarters = new Set([
  "bootstrap",
  "login",
  "logout",
  "service",
  "sync",
  "upgrade",
  "whoami",
]);

function defaultCliArgv(argv = process.argv) {
  const second = argv[1];
  if (second !== undefined && isCliArgvStarter(second)) {
    return argv.slice(1);
  }

  return argv.slice(2);
}

function isCliArgvStarter(value: string) {
  return value.startsWith("-") || rootArgvStarters.has(value);
}

function mainEffect(argv = defaultCliArgv()) {
  const normalizedArgv = normalizeRootVersionArgv(argv);

  return runTokenmaxxingCommand(normalizedArgv).pipe(
    Effect.tapCause((cause) =>
      renderCliFailure(cause, {
        json: isJsonArgv(normalizedArgv),
        verbose: isVerboseArgv(normalizedArgv),
      }),
    ),
  );
}

function normalizeRootVersionArgv(argv: readonly string[]) {
  if (argv.length === 1 && argv[0] === "-v") {
    return ["--version"];
  }

  return argv;
}

// SIGHUP too: a closed terminal (or `kill -HUP`) otherwise kills the process
// by default action, without interrupting the run, and orphans the ccusage
// child it was waiting on.
const INTERRUPT_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/**
 * `NodeRuntime.runMain`, but interrupting on SIGHUP as well as SIGINT and
 * SIGTERM, and exiting 128 + the signal number for the signal that
 * interrupted the run (Effect's default teardown maps every interrupt to 130,
 * so SIGTERM looked like Ctrl+C to supervisors).
 */
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let received: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    received ??= signal;
    fiber.interruptUnsafe(fiber.id);
  };
  for (const signal of INTERRUPT_SIGNALS) {
    process.on(signal, onSignal);
  }

  fiber.addObserver((exit) => {
    for (const signal of INTERRUPT_SIGNALS) {
      process.removeListener(signal, onSignal);
    }
    teardown(exit, (code) => {
      if (received !== undefined) {
        process.exit(signalExitCode(exit, code, received));
      } else if (code !== 0) {
        process.exit(code);
      }
    });
  });
});

/** 128 + N for a run that a signal interrupted; otherwise the teardown's code. */
function signalExitCode(
  exit: Exit.Exit<unknown, unknown>,
  code: number,
  signal: NodeJS.Signals,
): number {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
    ? 128 + (constants.signals[signal] ?? 0)
    : code;
}

function runCliMain() {
  runMain(mainEffect().pipe(Effect.provide(Layer.mergeAll(CliServicesLive, NodeServices.layer))), {
    disableErrorReporting: true,
  });
}

export { defaultCliArgv, mainEffect, normalizeRootVersionArgv, runCliMain, signalExitCode };
