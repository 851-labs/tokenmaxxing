#!/usr/bin/env bun
/**
 * A read-only npm registry for the e2e. Serves just enough of the registry
 * protocol (packuments and tarballs) for `npm install -g` and `bun add -g`
 * from `npm pack` tarballs. There is no uplink, so a package that is not
 * listed here fails to install instead of reaching registry.npmjs.org.
 *
 *   bun apps/cli/e2e/windows/registry-server.ts --port 4873 <package .tgz>...
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

type Manifest = Record<string, unknown> & { name: string; version: string };

const argv = process.argv.slice(2);
const port = Number(takeFlag("port") ?? "4873");
const origin = `http://127.0.0.1:${port}`;

const packuments = new Map<string, { "dist-tags": Record<string, string>; versions: object }>();
const tarballs = new Map<string, string>();
for (const tarball of argv.map((file) => resolve(file))) {
  const bytes = readFileSync(tarball);
  const manifest = readPackageJson(bytes);
  const filename = basename(tarball);
  tarballs.set(filename, tarball);
  packuments.set(manifest.name, {
    "dist-tags": { latest: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: {
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          shasum: createHash("sha1").update(bytes).digest("hex"),
          tarball: `${origin}/-/tarballs/${filename}`,
        },
        hasInstallScript: manifest.scripts !== undefined,
      },
    },
  });
  console.log(`serving ${manifest.name}@${manifest.version} (${filename})`);
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

/** package/package.json from a gzipped tarball (512-byte ustar headers). */
function readPackageJson(tgz: Uint8Array): Manifest {
  const tar = gunzipSync(tgz);
  const text = (start: number, length: number) =>
    tar
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = text(offset, 100);
    if (name === "") {
      break;
    }
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    if (name === "package/package.json") {
      return JSON.parse(text(offset + 512, size)) as Manifest;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("tarball has no package/package.json");
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
