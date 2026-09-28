#!/usr/bin/env bun
/**
 * A local npm registry for the e2e. Serves just enough of the registry
 * protocol for `npm`, `bun`, `pnpm` and `yarn` global installs from
 * `npm pack` tarballs, plus the two endpoints the CLI itself calls: the
 * dist-tags of @851-labs/tokenmaxxing (`tokenmaxxing upgrade`) and one
 * version of a runner package (`/<name>/<version or dist-tag>`, the service
 * runner's auto-update). There is no uplink, so a package that is not listed
 * here fails to install instead of reaching registry.npmjs.org.
 *
 *   bun apps/cli/e2e/shared/registry-server.ts [--port 4873] [--dist-tag tag=version]... <package .tgz>...
 *
 * Several versions of one package may be served. Without --dist-tag,
 * `latest` is the last tarball given for each package. --dist-tag applies to
 * every package that has that version.
 *
 * Control routes (the e2e changes what the registry advertises mid-run):
 *   POST /-/e2e/state     { distTags?: { tag: version | null }, mode?: "ok" | "metadata-down" | "down" }
 *                         "metadata-down" answers 503 on the endpoints the CLI uses for version
 *                         checks (dist-tags, /<name>/<tag>) while packuments and tarballs still
 *                         work; "down" answers 503 on everything.
 *   GET  /-/e2e/requests  every registry request so far: { at, method, path, status }
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

type Manifest = Record<string, unknown> & { name: string; version: string };
type Mode = "ok" | "metadata-down" | "down";

interface Package {
  distTags: Record<string, string>;
  versions: Map<string, Record<string, unknown>>;
}

const argv = process.argv.slice(2);
const port = Number(takeFlag("port") ?? "4873");
const initialDistTags = takeAllFlags("dist-tag").map((pair) => pair.split("=") as [string, string]);
const origin = `http://127.0.0.1:${port}`;

const packages = new Map<string, Package>();
const tarballs = new Map<string, string>();
const requestLog: { at: string; method: string; path: string; status: number }[] = [];
let mode: Mode = "ok";

for (const tarball of argv.map((file) => resolve(file))) {
  const bytes = readFileSync(tarball);
  const manifest = readPackageJson(bytes);
  const filename = basename(tarball);
  tarballs.set(filename, tarball);
  const entry: Package = packages.get(manifest.name) ?? { distTags: {}, versions: new Map() };
  entry.versions.set(manifest.version, {
    ...manifest,
    _id: `${manifest.name}@${manifest.version}`,
    dist: {
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      tarball: `${origin}/-/tarballs/${filename}`,
    },
    hasInstallScript: manifest.scripts !== undefined,
  });
  entry.distTags.latest = manifest.version;
  packages.set(manifest.name, entry);
  console.log(`serving ${manifest.name}@${manifest.version} (${filename})`);
}
setDistTags(Object.fromEntries(initialDistTags));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const response = await route(request, path);
    if (!path.startsWith("/-/e2e/")) {
      requestLog.push({
        at: new Date().toISOString(),
        method: request.method,
        path,
        status: response.status,
      });
      console.log(`${new Date().toISOString()} ${request.method} ${path} -> ${response.status}`);
    }
    return response;
  },
});

console.log(`e2e registry listening on http://127.0.0.1:${server.port}`);

async function route(request: Request, path: string): Promise<Response> {
  if (path === "/-/ping") {
    return Response.json({});
  }
  if (path === "/-/e2e/requests") {
    return Response.json({ requests: requestLog });
  }
  if (path === "/-/e2e/state" && request.method === "POST") {
    const body = (await request.json()) as {
      distTags?: Record<string, string | null>;
      mode?: Mode;
    };
    if (body.mode !== undefined) {
      mode = body.mode;
    }
    if (body.distTags !== undefined) {
      setDistTags(body.distTags);
    }
    return Response.json(state());
  }
  if (path === "/-/e2e/state") {
    return Response.json(state());
  }
  if (mode === "down") {
    return unavailable();
  }
  if (path.startsWith("/-/tarballs/")) {
    const file = tarballs.get(path.slice("/-/tarballs/".length));
    return file === undefined ? notFound() : new Response(Bun.file(file));
  }

  const distTagsPath = /^\/-\/package\/(.+)\/dist-tags$/.exec(path);
  if (distTagsPath !== null) {
    if (mode === "metadata-down") {
      return unavailable();
    }
    const entry = packages.get(distTagsPath[1]!.toLowerCase());
    return entry === undefined ? notFound() : noStore(Response.json(entry.distTags));
  }

  // /<name> or /@scope/<name>, optionally followed by /<version or dist-tag>.
  const segments = path.slice(1).split("/");
  const nameLength = segments[0]?.startsWith("@") ? 2 : 1;
  const name = segments.slice(0, nameLength).join("/").toLowerCase();
  const specifier = segments.slice(nameLength).join("/");
  const entry = packages.get(name);
  if (entry === undefined) {
    return notFound();
  }
  if (specifier !== "") {
    if (mode === "metadata-down") {
      return unavailable();
    }
    const version = entry.distTags[specifier] ?? specifier;
    const manifest = entry.versions.get(version);
    return manifest === undefined ? notFound() : noStore(Response.json(manifest));
  }

  return noStore(
    Response.json({
      _id: name,
      name,
      "dist-tags": entry.distTags,
      versions: Object.fromEntries(entry.versions),
    }),
  );
}

function setDistTags(distTags: Record<string, string | null>) {
  for (const [tag, version] of Object.entries(distTags)) {
    for (const entry of packages.values()) {
      if (version === null) {
        delete entry.distTags[tag];
      } else if (entry.versions.has(version)) {
        entry.distTags[tag] = version;
      }
    }
  }
}

function state() {
  return {
    mode,
    packages: Object.fromEntries(
      [...packages].map(([name, entry]) => [
        name,
        { distTags: entry.distTags, versions: [...entry.versions.keys()] },
      ]),
    ),
  };
}

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

// Package managers cache packuments; dist-tags change mid-run here.
function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function unavailable(): Response {
  return Response.json({ error: "e2e registry is down" }, { status: 503 });
}

function takeFlag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const [, value] = argv.splice(index, 2);
  return value;
}

function takeAllFlags(name: string): string[] {
  const values: string[] = [];
  for (let value = takeFlag(name); value !== undefined; value = takeFlag(name)) {
    values.push(value);
  }
  return values;
}
