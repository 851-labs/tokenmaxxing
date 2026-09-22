import { type Cause, Layer, Logger, type LogLevel } from "effect";
import { onTestFailed } from "vite-plus/test";

/**
 * Captures Effect log output so tests that exercise a logging path assert the
 * log instead of printing it. Captured entries are replayed through the
 * default logger if the test fails, so a failing test still shows everything
 * that was logged. Must be created inside a running test (or beforeEach).
 */

interface CapturedLog {
  /** Log arguments after the message; a `Cause` argument lands in `cause`. */
  readonly args: ReadonlyArray<unknown>;
  readonly cause: Cause.Cause<unknown>;
  readonly level: LogLevel.LogLevel;
  readonly message: unknown;
}

interface TestLogger {
  readonly entries: ReadonlyArray<CapturedLog>;
  /** Replaces the current loggers, so nothing reaches the console. */
  readonly layer: Layer.Layer<never>;
  readonly logger: Logger.Logger<unknown, void>;
}

function makeTestLogger(): TestLogger {
  const captured: Array<Logger.Options<unknown>> = [];
  const entries: CapturedLog[] = [];
  const logger = Logger.make<unknown, void>((options) => {
    captured.push(options);
    const [message, ...args] = Array.isArray(options.message) ? options.message : [options.message];
    entries.push({ args, cause: options.cause, level: options.logLevel, message });
  });

  onTestFailed(() => {
    for (const options of captured) {
      Logger.defaultLogger.log(options);
    }
  });

  return { entries, layer: Logger.layer([logger]), logger };
}

export { makeTestLogger };

export type { CapturedLog, TestLogger };
