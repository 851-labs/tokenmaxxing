import { Command } from "effect/cli";

import packageJson from "../../package.json";
import { verboseGlobalFlag } from "../errors";
import { bootstrapCommand } from "./bootstrap";
import { loginCommand } from "./login";
import { logoutCommand } from "./logout";
import { serviceCommand } from "./service";
import { syncCommand } from "./sync";
import { upgradeCommand } from "./upgrade";
import { whoamiCommand } from "./whoami";

const tokenmaxxingCommand = Command.make("tokenmaxxing").pipe(
  Command.withDescription("Sync your LLM token usage to the tokenmaxxing leaderboard"),
  Command.withGlobalFlags([verboseGlobalFlag]),
  Command.withSubcommands([
    bootstrapCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
    syncCommand,
    upgradeCommand,
    serviceCommand,
  ]),
);

const runTokenmaxxingCommand = Command.runWith(tokenmaxxingCommand, {
  version: packageJson.version,
});

export { runTokenmaxxingCommand };
