#!/usr/bin/env bun
/**
 * A read-only npm registry for the e2e: packs each package directory with
 * `npm pack` and serves just enough of the registry protocol (packuments and
 * tarballs) for `npm install -g` and `bun add -g`. There is no uplink, so a
 * package that is not listed here fails to install instead of reaching
 * registry.npmjs.org.
 *
 *   bun apps/cli/e2e/windows/registry-server.ts --port 4873 --out <dir> <package dir>...
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface PackResult {
  filename: string;
  integrity: string;
  shasum: string;
}

type Manifest = Record<string, unknown> & { name: string; version: string };

const argv = process.argv.slice(2);
const port = Number(takeFlag("port") ?? "4873");
const outDir = resolve(takeFlag("out") ?? "registry");
const origin = `http://127.0.0.1:${port}`;
mkdirSync(outDir, { recursive: true });

const packuments = new Map<string, { "dist-tags": Record<string, string>; versions: object }>();
const tarballs = new Map<string, string>();
for (const packageDir of argv.map((dir) => resolve(dir))) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Manifest;
  const packed = npmPack(packageDir);
  tarballs.set(packed.filename, join(outDir, packed.filename));
  packuments.set(manifest.name, {
    "dist-tags": { latest: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: {
          integrity: packed.integrity,
          shasum: packed.shasum,
          tarball: `${origin}/-/tarballs/${packed.filename}`,
        },
        hasInstallScript: manifest.scripts !== undefined,
      },
    },
  });
  console.log(`serving ${manifest.name}@${manifest.version} (${packed.filename})`);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === "/-/ping") {
      return Response.json({});
    }
    if (path.startsWith("/-/tarballs/")) {
      const file = tarballs.get(path.slice("/-/tarballs/".length));
      return file === undefined ? notFound(path) : new Response(Bun.file(file));
    }
    const packument = packuments.get(path.slice(1).toLowerCase());
    if (packument === undefined) {
      return notFound(path);
    }
    const name = path.slice(1);
    return Response.json({ _id: name, name, ...packument });
  },
});

console.log(`e2e registry listening on http://127.0.0.1:${server.port}`);

function npmPack(packageDir: string): PackResult {
  // Bun starts npm's .cmd shim on Windows directly, without a shell.
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", packageDir, "--json", "--ignore-scripts", "--pack-destination", outDir],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`npm pack ${packageDir} failed: ${result.stderr}`);
  }
  const [packed] = JSON.parse(result.stdout) as PackResult[];
  if (packed === undefined) {
    throw new Error(`npm pack ${packageDir} printed no result`);
  }
  return packed;
}

function notFound(path: string): Response {
  console.log(`404 ${path}`);
  return Response.json({ error: "not_found" }, { status: 404 });
}

function takeFlag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const [, value] = argv.splice(index, 2);
  return value;
}
