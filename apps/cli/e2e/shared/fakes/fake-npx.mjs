// Fake `npx` for the Windows e2e's no-bun scenario, started by an npx.cmd
// batch file the way npm's own shim starts npx-cli.js (`node ... %*`). A
// batch file is the point: Bun 1.4 throws EINVAL for one started without a
// shell. The runner goes through cmd.exe, which drops a ^ outside quotes, so
// this insists the version range still reads `ccusage@^...`, then answers
// like ccusage through fake-ccusage.mjs next to it.
//
// Every call is appended to calls.log next to this file.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
appendFileSync(
  join(here, "calls.log"),
  `${new Date().toISOString()} npx pid=${process.pid} ppid=${process.ppid} ${args.join(" ")}\n`,
);

if (args[0] !== "-y" || !(args[1] ?? "").startsWith("ccusage@^")) {
  console.error(`fake npx: unexpected invocation: ${args.join(" ")}`);
  process.exit(1);
}

const result = spawnSync("node", [join(here, "fake-ccusage.mjs"), ...args.slice(2)], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.error) {
  console.error(`fake npx: failed to start node: ${result.error.message}`);
  process.exit(1);
}
process.stdout.write(result.stdout ?? "");
process.exit(result.status ?? 1);
