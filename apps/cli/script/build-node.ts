import { chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const outfile = join(cliDir, "dist", "index.js");

const result = spawnSync(
  process.execPath,
  ["build", "src/index.ts", "--target", "node", "--outfile", outfile],
  {
    cwd: cliDir,
    stdio: "inherit",
  },
);

if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(typeof result.status === "number" ? result.status : 1);
}

if (process.platform !== "win32") {
  await chmod(outfile, 0o755);
}
