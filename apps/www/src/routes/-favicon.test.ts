import { describe, expect, it, vi } from "vitest";

import { handleDefaultFaviconRequest } from "./favicon[.]svg";
import type { FaviconCache } from "./favicon/{$login}[.]svg";
import { makeProfileFaviconHandler } from "./favicon/{$login}[.]svg";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("default favicon route", () => {
  it("renders the shared gradient without an avatar", async () => {
    const response = handleDefaultFaviconRequest();
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("default");
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(svg).toContain('id="gradient"');
    expect(svg).not.toContain('id="avatar"');
  });
});

describe("profile favicon route", () => {
  it("uses the lightweight identity and embeds a provider-sized avatar", async () => {
    const fetchAvatar = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(PNG_SIGNATURE, {
          headers: { "content-type": "image/png" },
        }),
    );
    const loadIdentity = vi.fn(async () => ({
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      login: "pondorasti",
    }));
    const handler = makeProfileFaviconHandler({
      cache: () => null,
      fetchAvatar,
      loadIdentity,
    });

    const response = await handler(routeContext("pondorasti"));
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("profile");
    expect(loadIdentity).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://avatars.githubusercontent.com/u/1?v=4&s=64",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    );
    expect(svg).toContain('id="avatar"');
    expect(svg).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(new TextEncoder().encode(svg).byteLength).toBeLessThan(10_000);
  });

  it("returns a short-lived gradient fallback when identity loading fails", async () => {
    const handler = makeProfileFaviconHandler({
      cache: () => null,
      loadIdentity: async () => {
        throw new Error("API unavailable");
      },
    });

    const response = await handler(routeContext("pondorasti"));
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("fallback");
    expect(response.headers.get("x-favicon-fallback")).toBe("identity-load-failed");
    expect(response.headers.get("cache-control")).toContain("max-age=30");
    expect(svg).toContain('id="gradient"');
    expect(svg).not.toContain('id="avatar"');
  });

  it("returns the gradient when an avatar redirects instead of following it", async () => {
    const fetchAvatar = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 302 }),
    );
    const handler = makeProfileFaviconHandler({
      cache: () => null,
      fetchAvatar,
      loadIdentity: async () => ({
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        login: "pondorasti",
      }),
    });

    const response = await handler(routeContext("pondorasti"));

    expect(response.headers.get("x-favicon-source")).toBe("fallback");
    expect(response.headers.get("x-favicon-fallback")).toBe("avatar-response-rejected");
    expect(fetchAvatar.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("uses one canonical cache entry regardless of query parameters", async () => {
    const cache = memoryCache();
    const loadIdentity = vi.fn(async () => ({ avatarUrl: null, login: "pondorasti" }));
    const handler = makeProfileFaviconHandler({ cache: () => cache, loadIdentity });

    await handler(routeContext("pondorasti", "?v=one"));
    await handler(routeContext("pondorasti", "?v=two"));

    expect(loadIdentity).toHaveBeenCalledOnce();
    expect(cache.keys()).toEqual(["https://tokenmaxxing.sh/favicon/pondorasti.svg?v=10"]);
  });

  it("returns not found for an unknown profile", async () => {
    const handler = makeProfileFaviconHandler({
      cache: () => null,
      loadIdentity: async () => null,
    });

    expect((await handler(routeContext("missing"))).status).toBe(404);
  });
});

function routeContext(login: string, search = "") {
  return {
    params: { login },
    request: new Request(`https://tokenmaxxing.sh/favicon/${login}.svg${search}`),
  };
}

function memoryCache(): FaviconCache & { keys(): string[] } {
  const entries = new Map<string, Response>();
  return {
    keys: () => [...entries.keys()],
    match: async (request) => entries.get(request.url)?.clone(),
    put: async (request, response) => {
      entries.set(request.url, response.clone());
    },
  };
}
