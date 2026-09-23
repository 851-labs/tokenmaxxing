import { notFoundResponse } from "./http";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "./og";
import type { OgBrowser, OgR2Bucket, OgRuntimeEnv } from "./og-runtime";

/**
 * Screenshot an HTML OG card into a PNG, cached in R2 per fingerprint. Shared
 * by the profile images (`/og/:login.png`) and the site image (`/og.png`).
 */

interface OgImageDeps {
  captureScreenshot(browser: OgBrowser, url: string): Promise<Uint8Array>;
  getRuntimeEnv(context?: unknown): Promise<OgRuntimeEnv>;
}

interface OgImageTarget {
  /** Path of the HTML card to capture, e.g. "/og-card/pondorasti". */
  cardPath: string;
  /** Fingerprint of the card as it renders now — the only source of the R2 key. */
  currentVersion: string;
  /** R2 key namespace — the login, or `SITE_OG_CACHE_SCOPE`. */
  scope: string;
}

type OgImageSource = "browser" | "cache" | "fallback" | "prior-cache";

const VERSIONED_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PREVIEW_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
/** Upstream failure: retry soon rather than pin a fallback for minutes. */
const TRANSIENT_CACHE_CONTROL = "public, max-age=60";
const OG_NOT_FOUND_CACHE_CONTROL = "public, max-age=60";
const OG_CACHE_PREFIX = "og";
/** `_` never appears in a GitHub login, so the site scope can't collide with one. */
const SITE_OG_CACHE_SCOPE = "_site";
const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

/**
 * Resolve the card to capture, then serve its PNG.
 *
 * - `resolveTarget` rejecting (upstream API down): we cannot tell whether the
 *   card is still public, so never serve a prior cached card — only the
 *   neutral fallback, briefly cached so crawlers retry soon.
 * - `null` (unknown or hidden): 404, before any cached image is read.
 * - The R2 key always derives from `target.currentVersion`. `?v=` only earns
 *   immutable caching when it matches; any other value falls back to preview
 *   caching of the canonical key, so arbitrary `v`s cannot mint new R2 keys
 *   or Browser Run screenshots.
 */
async function renderOgImage(
  deps: OgImageDeps,
  {
    context,
    request,
    resolveTarget,
  }: {
    context?: unknown;
    request: Request;
    resolveTarget: () => Promise<OgImageTarget | null>;
  },
): Promise<Response> {
  let target: OgImageTarget | null;
  try {
    target = await resolveTarget();
  } catch (error) {
    return pngResponse(fallbackPngBytes(), TRANSIENT_CACHE_CONTROL, { error, source: "fallback" });
  }
  if (target === null) {
    return notFoundResponse(OG_NOT_FOUND_CACHE_CONTROL);
  }

  const fingerprint = target.currentVersion;
  const isVersioned = new URL(request.url).searchParams.get("v") === fingerprint;
  const cacheControl = isVersioned ? VERSIONED_CACHE_CONTROL : PREVIEW_CACHE_CONTROL;
  const cacheKey = ogCacheKey(target.scope, fingerprint);
  let env: OgRuntimeEnv;
  try {
    env = await deps.getRuntimeEnv(context);
  } catch (error) {
    return pngResponse(fallbackPngBytes(), TRANSIENT_CACHE_CONTROL, { error, source: "fallback" });
  }

  const cached = env.BUCKET === undefined ? null : await readCachedPngSafely(env.BUCKET, cacheKey);
  if (cached !== null) {
    return pngResponse(cached, cacheControl, { source: "cache" });
  }

  try {
    if (env.BROWSER === undefined) {
      throw new Error("Cloudflare Browser binding is unavailable");
    }

    const png = await deps.captureScreenshot(
      env.BROWSER,
      new URL(target.cardPath, request.url).toString(),
    );
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
      env.BUCKET === undefined
        ? null
        : await readLatestCachedPngSafely(env.BUCKET, target.scope, cacheKey);
    if (previous !== null) {
      return pngResponse(previous, PREVIEW_CACHE_CONTROL, { error, source: "prior-cache" });
    }

    return pngResponse(fallbackPngBytes(), PREVIEW_CACHE_CONTROL, { error, source: "fallback" });
  }
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

function ogCacheKey(scope: string, fingerprint: string): string {
  return `${OG_CACHE_PREFIX}/${encodeURIComponent(scope)}/${encodeURIComponent(fingerprint)}.png`;
}

async function readCachedPng(bucket: OgR2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }

  return new Uint8Array(await object.arrayBuffer());
}

async function readCachedPngSafely(bucket: OgR2Bucket, key: string): Promise<Uint8Array | null> {
  try {
    return await readCachedPng(bucket, key);
  } catch {
    return null;
  }
}

async function readLatestCachedPng(
  bucket: OgR2Bucket,
  scope: string,
  requestedKey: string,
): Promise<Uint8Array | null> {
  const prefix = `${OG_CACHE_PREFIX}/${encodeURIComponent(scope)}/`;
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

async function readLatestCachedPngSafely(
  bucket: OgR2Bucket,
  scope: string,
  requestedKey: string,
): Promise<Uint8Array | null> {
  try {
    return await readLatestCachedPng(bucket, scope, requestedKey);
  } catch {
    return null;
  }
}

function pngResponse(
  bytes: Uint8Array,
  cacheControl: string,
  metadata: { error?: unknown; source: OgImageSource },
): Response {
  const headers = new Headers({
    "cache-control": cacheControl,
    "content-type": "image/png",
    "x-og-source": metadata.source,
  });
  const message = errorHeaderValue(metadata.error);
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

function errorHeaderValue(error: unknown): string | null {
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

export {
  captureOgCardScreenshot,
  OG_NOT_FOUND_CACHE_CONTROL,
  ogCacheKey,
  PREVIEW_CACHE_CONTROL,
  renderOgImage,
  SITE_OG_CACHE_SCOPE,
  TRANSIENT_CACHE_CONTROL,
  VERSIONED_CACHE_CONTROL,
};

export type { OgImageDeps, OgImageSource, OgImageTarget };
