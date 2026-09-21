import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ConsoleService } from "./services";
import {
  formatClackHintRow,
  formatClackRow,
  formatHighlight,
  formatStatusMessage,
  formatUrl,
  humanConfirm,
  humanFailure,
  humanFrame,
  humanLog,
} from "./output";

const promptCalls = vi.hoisted((): string[] => []);
const promptState = vi.hoisted((): { confirmValue: boolean | "cancel" } => ({
  confirmValue: true,
}));

vi.mock("@clack/prompts", () => ({
  confirm: (options: { initialValue: boolean; message: string }) => {
    promptCalls.push(`confirm:${options.message}:${String(options.initialValue)}`);
    return Promise.resolve(promptState.confirmValue);
  },
  intro: (title: string) => {
    promptCalls.push(`intro:${title}`);
  },
  isCancel: (value: unknown) => value === "cancel",
  log: {
    error: (message: string) => {
      promptCalls.push(`error:${message}`);
    },
    info: (message: string) => {
      promptCalls.push(`info:${message}`);
    },
    step: (message: string) => {
      promptCalls.push(`step:${message}`);
    },
    success: (message: string) => {
      promptCalls.push(`success:${message}`);
    },
    warn: (message: string) => {
      promptCalls.push(`warn:${message}`);
    },
  },
  note: (message: string, title: string) => {
    promptCalls.push(`note:${title}:${message}`);
  },
  outro: (message: string) => {
    promptCalls.push(`outro:${message}`);
  },
  spinner: () => ({
    error: (message?: string) => {
      promptCalls.push(`spinner-error:${message ?? ""}`);
    },
    start: (message: string) => {
      promptCalls.push(`spinner-start:${message}`);
    },
    stop: (message?: string) => {
      promptCalls.push(`spinner-stop:${message ?? ""}`);
    },
  }),
}));

const originalStdoutIsTty = process.stdout.isTTY;
const originalStderrIsTty = process.stderr.isTTY;
const originalCi = process.env.CI;
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

function testConsole() {
  const logs: string[] = [];
  const layer = Layer.succeed(ConsoleService)({
    error: (message?: unknown) => {
      logs.push(`error:${String(message)}`);
    },
    log: (message?: unknown) => {
      logs.push(`log:${String(message)}`);
    },
  });

  return { layer, logs };
}

function setTty(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value });
}

function restoreEnvironment() {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTty,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: originalStderrIsTty,
  });

  if (originalCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCi;
  }
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
  if (originalTerm === undefined) {
    delete process.env.TERM;
  } else {
    process.env.TERM = originalTerm;
  }
}

describe("humanFrame", () => {
  afterEach(() => {
    promptCalls.length = 0;
    promptState.confirmValue = true;
    restoreEnvironment();
  });

  it("wraps interactive Clack output with intro and outro", async () => {
    const { layer } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(
      humanFrame("Upgrade", {}, humanLog("info", "Running upgrade", {})).pipe(
        Effect.provide(layer),
      ),
    );

    expect(promptCalls).toEqual(["intro:Upgrade", "info:Running upgrade", "outro:Done"]);
  });

  it("does not print an outro when the wrapped effect fails", async () => {
    const { layer } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    const exit = await Effect.runPromiseExit(
      humanFrame("Upgrade", {}, Effect.fail("boom")).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(promptCalls).toEqual(["intro:Upgrade"]);
  });

  it("leaves non-Clack output unframed", async () => {
    const { layer, logs } = testConsole();
    setTty(false);

    await Effect.runPromise(
      humanFrame("Upgrade", {}, humanLog("info", "Running upgrade", {})).pipe(
        Effect.provide(layer),
      ),
    );

    expect(promptCalls).toEqual([]);
    expect(logs).toEqual(["log:Running upgrade"]);
  });

  it("does not frame JSON output", async () => {
    const { layer, logs } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(
      humanFrame(
        "Upgrade",
        { json: true },
        humanLog("info", "Running upgrade", { json: true }),
      ).pipe(Effect.provide(layer)),
    );

    expect(promptCalls).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe("humanFailure", () => {
  afterEach(() => {
    promptCalls.length = 0;
    restoreEnvironment();
  });

  it("renders Clack failures with a failed outro", async () => {
    const { layer, logs } = testConsole();
    setTty(true);
    delete process.env.CI;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";

    await Effect.runPromise(
      humanFailure(
        {
          context: ["path: /usr/local/bin/tokenmaxxing"],
          hint: "run tokenmaxxing login",
          message: "not logged in",
        },
        {},
      ).pipe(Effect.provide(layer)),
    );

    expect(logs).toEqual([]);
    expect(promptCalls).toEqual([
      "error:Not logged in",
      "info:Path: /usr/local/bin/tokenmaxxing",
      "info:Hint: Run \x1b[36mtokenmaxxing login\x1b[0m",
      "outro:Failed",
    ]);
  });

  it("renders plain failures without Clack", async () => {
    const { layer, logs } = testConsole();
    setTty(false);

    await Effect.runPromise(humanFailure("not logged in", {}).pipe(Effect.provide(layer)));

    expect(promptCalls).toEqual([]);
    expect(logs).toEqual(["error:not logged in"]);
  });
});

describe("humanConfirm", () => {
  afterEach(() => {
    promptCalls.length = 0;
    promptState.confirmValue = true;
    restoreEnvironment();
  });

  it("prompts with the provided default value", async () => {
    const { layer } = testConsole();
    promptState.confirmValue = false;

    const result = await Effect.runPromise(
      humanConfirm(
        "install automatic sync?",
        {},
        {
          cancelError: () => new Error("cancelled"),
          defaultValue: true,
        },
      ).pipe(Effect.provide(layer)),
    );

    expect(result).toBe(false);
    expect(promptCalls).toEqual(["confirm:Install automatic sync?:true"]);
  });

  it("fails with the provided cancellation error when cancelled", async () => {
    const { layer } = testConsole();
    promptState.confirmValue = "cancel";

    const exit = await Effect.runPromiseExit(
      humanConfirm(
        "install automatic sync?",
        {},
        {
          cancelError: () => new Error("cancelled"),
          defaultValue: true,
        },
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(promptCalls).toEqual(["confirm:Install automatic sync?:true"]);
  });
});

describe("formatClackRow", () => {
  it("capitalizes the first display letter", () => {
    expect(formatClackRow("already logged in")).toBe("Already logged in");
    expect(formatClackRow("hint: run tokenmaxxing login")).toBe("Hint: run tokenmaxxing login");
  });

  it("preserves initial URLs, paths, packages, and command flags", () => {
    expect(formatClackRow("https://tokenmaxxing.sh/alex")).toBe("https://tokenmaxxing.sh/alex");
    expect(formatClackRow("/usr/local/bin/tokenmaxxing")).toBe("/usr/local/bin/tokenmaxxing");
    expect(formatClackRow("@851-labs/tokenmaxxing")).toBe("@851-labs/tokenmaxxing");
    expect(formatClackRow("--json")).toBe("--json");
  });

  it("preserves leading ANSI sequences and whitespace", () => {
    expect(formatClackRow("  \x1b[36;4mprofile\x1b[0m")).toBe("  \x1b[36;4mProfile\x1b[0m");
  });
});

describe("formatClackHintRow", () => {
  it("highlights copyable tokenmaxxing commands in run hints", () => {
    expect(
      formatClackHintRow("run tokenmaxxing logout first before logging in again", { env: {} }),
    ).toBe("Hint: Run \x1b[36mtokenmaxxing logout\x1b[0m first before logging in again");
  });

  it("highlights multiple tokenmaxxing commands and preserves surrounding prose", () => {
    expect(
      formatClackHintRow(
        "unset TOKENMAXXING_API_TOKEN, run tokenmaxxing login, then run tokenmaxxing service install",
        { env: {} },
      ),
    ).toBe(
      "Hint: Unset TOKENMAXXING_API_TOKEN, run \x1b[36mtokenmaxxing login\x1b[0m, then run \x1b[36mtokenmaxxing service install\x1b[0m",
    );
  });

  it("includes values for tokenmaxxing flags that require values", () => {
    expect(
      formatClackHintRow("run tokenmaxxing bootstrap --service yes to skip this prompt", {
        env: {},
      }),
    ).toBe("Hint: Run \x1b[36mtokenmaxxing bootstrap --service yes\x1b[0m to skip this prompt");
  });

  it("does not highlight commands when NO_COLOR is set", () => {
    expect(
      formatClackHintRow("run tokenmaxxing logout first before logging in again", {
        env: { NO_COLOR: "" },
      }),
    ).toBe("Hint: Run tokenmaxxing logout first before logging in again");
  });
});

describe("formatStatusMessage", () => {
  it("removes terminal punctuation from short status rows", () => {
    expect(formatStatusMessage("Checking current login...")).toBe("Checking current login");
    expect(formatStatusMessage("Validated current login.")).toBe("Validated current login");
    expect(formatStatusMessage("Install automatic sync?")).toBe("Install automatic sync");
  });

  it("preserves multi-sentence explanatory copy", () => {
    expect(formatStatusMessage("Dry run complete. Nothing pushed.")).toBe(
      "Dry run complete. Nothing pushed.",
    );
  });

  it("removes terminal punctuation before ANSI resets", () => {
    expect(formatStatusMessage("\x1b[32mSync complete.\x1b[0m")).toBe(
      "\x1b[32mSync complete\x1b[0m",
    );
  });
});

describe("formatUrl", () => {
  it("highlights URLs", () => {
    expect(formatUrl("https://tokenmaxxing.sh", { env: {} })).toBe(
      "\x1b[36;4mhttps://tokenmaxxing.sh\x1b[0m",
    );
  });

  it("respects NO_COLOR", () => {
    expect(formatUrl("https://tokenmaxxing.sh", { env: { NO_COLOR: "" } })).toBe(
      "https://tokenmaxxing.sh",
    );
  });
});

describe("formatHighlight", () => {
  it("highlights inline CLI values without underlining them", () => {
    expect(formatHighlight("pondorasti", { env: {} })).toBe("\x1b[36mpondorasti\x1b[0m");
  });

  it("respects NO_COLOR", () => {
    expect(formatHighlight("pondorasti", { env: { NO_COLOR: "" } })).toBe("pondorasti");
  });
});
