import { createFileRoute } from "@tanstack/react-router";

import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, profileOgVersion } from "../../lib/og";
import { loadProfileOgData } from "../../lib/og-data";
import type { ProfileOgData } from "../../lib/og-data";
import { getOgRuntimeEnv } from "../../lib/og-runtime";
import type { OgBrowser, OgR2Bucket, OgRuntimeEnv } from "../../lib/og-runtime";

interface OgRouteContext {
  context?: unknown;
  params: {
    login: string;
  };
  request: Request;
}

interface OgRouteDeps {
  captureScreenshot(browser: OgBrowser, url: string): Promise<Uint8Array>;
  getRuntimeEnv(context?: unknown): Promise<OgRuntimeEnv>;
  loadProfileOgData(login: string): Promise<ProfileOgData | null>;
}

const VERSIONED_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PREVIEW_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const TRANSIENT_CACHE_CONTROL = "public, max-age=60";
const OG_CACHE_PREFIX = "og";
const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const defaultDeps: OgRouteDeps = {
  captureScreenshot: captureOgCardScreenshot,
  getRuntimeEnv: getOgRuntimeEnv,
  loadProfileOgData,
};

function makeOgImageHandler(deps: OgRouteDeps = defaultDeps) {
  return async function handleOgImageRequest({ context, params, request }: OgRouteContext) {
    const url = new URL(request.url);
    let data: ProfileOgData | null;
    try {
      data = await deps.loadProfileOgData(params.login);
    } catch (error) {
      // Upstream API failure: we cannot tell whether the profile is still
      // public, so never serve a prior cached card — only the neutral
      // fallback, briefly cached so crawlers retry soon.
      return pngResponse(fallbackPngBytes(), TRANSIENT_CACHE_CONTROL, {
        error,
        source: "fallback",
      });
    }
    if (data === null) {
      return new Response("Not found", {
        headers: {
          "cache-control": "public, max-age=60",
        },
        status: 404,
      });
    }

    // The fingerprint always comes from the profile itself. `?v=` is honoured
    // (immutable caching) only when it matches; any other value is ignored so
    // arbitrary `v`s cannot mint new R2 keys or Browser Run screenshots.
    const fingerprint = profileOgVersion(data.profile);
    const isVersioned = url.searchParams.get("v") === fingerprint;
    const cacheControl = isVersioned ? VERSIONED_CACHE_CONTROL : PREVIEW_CACHE_CONTROL;
    const login = data.profile.user.login;
    const cacheKey = ogCacheKey(login, fingerprint);
    const env = await deps.getRuntimeEnv(context);
    const cached = env.BUCKET === undefined ? null : await readCachedPng(env.BUCKET, cacheKey);
    if (cached !== null) {
      return pngResponse(cached, cacheControl, { source: "cache" });
    }

    try {
      if (env.BROWSER === undefined) {
        throw new Error("Cloudflare Browser binding is unavailable");
      }

      const cardUrl = ogCardUrl(request.url, login);
      const png = await deps.captureScreenshot(env.BROWSER, cardUrl);
      if (env.BUCKET !== undefined) {
        await env.BUCKET.put(cacheKey, png, {
          httpMetadata: {
            cacheControl: VERSIONED_CACHE_CONTROL,
            contentType: "image/png",
          },
        });
      }

      return pngResponse(png, cacheControl, { source: "browser" });
    } catch (error) {
      const previous =
        env.BUCKET === undefined ? null : await readLatestCachedPng(env.BUCKET, login, cacheKey);
      if (previous !== null) {
        return pngResponse(previous, PREVIEW_CACHE_CONTROL, {
          error,
          source: "prior-cache",
        });
      }

      return pngResponse(fallbackPngBytes(), PREVIEW_CACHE_CONTROL, {
        error,
        source: "fallback",
      });
    }
  };
}

async function captureOgCardScreenshot(browser: OgBrowser, url: string): Promise<Uint8Array> {
  const response = await browser.quickAction("screenshot", {
    gotoOptions: {
      timeout: 30_000,
      waitUntil: "networkidle2",
    },
    screenshotOptions: {
      omitBackground: false,
      type: "png",
    },
    selector: "#og-card",
    url,
    viewport: {
      deviceScaleFactor: 1,
      height: OG_IMAGE_HEIGHT,
      width: OG_IMAGE_WIDTH,
    },
    waitForSelector: {
      selector: "#og-card",
      timeout: 10_000,
      visible: true,
    },
  });

  if (!response.ok) {
    throw new Error(`Cloudflare Browser screenshot failed: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function ogCardUrl(requestUrl: string, login: string): string {
  return new URL(`/og-card/${encodeURIComponent(login)}`, requestUrl).toString();
}

function ogCacheKey(login: string, fingerprint: string): string {
  return `${OG_CACHE_PREFIX}/${encodeURIComponent(login)}/${encodeURIComponent(fingerprint)}.png`;
}

async function readCachedPng(bucket: OgR2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }

  return new Uint8Array(await object.arrayBuffer());
}

async function readLatestCachedPng(
  bucket: OgR2Bucket,
  login: string,
  requestedKey: string,
): Promise<Uint8Array | null> {
  const prefix = `${OG_CACHE_PREFIX}/${encodeURIComponent(login)}/`;
  const listed = await bucket.list({ limit: 50, prefix });
  const previous = listed.objects
    .filter((object) => object.key !== requestedKey)
    .sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0))
    .at(0);
  if (previous === undefined) {
    return null;
  }

  return readCachedPng(bucket, previous.key);
}

function pngResponse(
  bytes: Uint8Array,
  cacheControl: string,
  metadata: { error?: unknown; source: "browser" | "cache" | "fallback" | "prior-cache" },
): Response {
  const headers = new Headers({
    "cache-control": cacheControl,
    "content-type": "image/png",
    "x-og-source": metadata.source,
  });
  const message = errorMessage(metadata.error);
  if (message !== null) {
    headers.set("x-og-error", message);
  }

  return new Response(responseBody(bytes), {
    headers,
  });
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fallbackPngBytes(): Uint8Array {
  const binary = atob(FALLBACK_PNG_BASE64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function errorMessage(error: unknown): string | null {
  if (error === undefined) {
    return null;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? "Unknown error");
  return message.slice(0, 200);
}

const handleOgImageRequest = makeOgImageHandler();

const Route = createFileRoute("/og/{$login}.png")({
  server: {
    handlers: {
      GET: handleOgImageRequest,
    },
  },
});

export {
  captureOgCardScreenshot,
  handleOgImageRequest,
  makeOgImageHandler,
  ogCacheKey,
  PREVIEW_CACHE_CONTROL,
  Route,
  TRANSIENT_CACHE_CONTROL,
  VERSIONED_CACHE_CONTROL,
};

export type { OgRouteContext, OgRouteDeps };
