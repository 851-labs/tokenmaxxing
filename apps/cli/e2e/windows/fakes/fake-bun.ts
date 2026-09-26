/**
 * Fake `bun` for the service e2e, compiled with `bun build --compile` to
 * <fakebin>/bun.exe and put first on PATH when the service is installed, so
 * the scheduled runner's `bun x ccusage@... <source> <daily|session> ...`
 * lands here. Like `bun x` running ccusage's node bin, it starts a node child
 * (fake-ccusage.mjs next to this exe). The child is spawned WITHOUT
 * windowsHide so it behaves like any console child: it opens a window only if
 * it has no console to inherit, which is exactly what the e2e watches for.
 *
 * Every call is appended to <fakebin>/calls.log.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = dirname(process.execPath);
const args = process.argv.slice(2);
appendFileSync(
  join(dir, "calls.log"),
  `${new Date().toISOString()} bun pid=${process.pid} ppid=${process.ppid} ${args.join(" ")}\n`,
);

const specIndex = args.findIndex((arg) => arg.startsWith("ccusage"));
if (args[0] !== "x" || specIndex < 0) {
  console.error(`fake bun: unsupported invocation: ${args.join(" ")}`);
  process.exit(1);
}

const result = spawnSync("node", [join(dir, "fake-ccusage.mjs"), ...args.slice(specIndex + 1)], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.error) {
  console.error(`fake bun: failed to start node: ${result.error.message}`);
  process.exit(1);
}
process.stdout.write(result.stdout ?? "");
process.exit(result.status ?? 1);
