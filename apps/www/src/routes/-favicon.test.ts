import { describe, expect, it, vi } from "vitest";

import { handleDefaultFaviconRequest } from "./favicon[.]svg";
import { makeProfileFaviconHandler } from "./favicon/{$login}[.]svg";

describe("default favicon route", () => {
  it("returns the rounded gradient on a transparent SVG canvas", async () => {
    const response = handleDefaultFaviconRequest();
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("x-favicon-source")).toBe("default");
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('id="gradient"');
    expect(svg).not.toContain('id="avatar"');
  });
});

describe("profile favicon route", () => {
  it("embeds the profile image into the composite SVG", async () => {
    const fetchAvatar = vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        }),
    );
    const handler = makeProfileFaviconHandler({
      fetchAvatar,
      loadProfile: async () => ({
        avatarUrl: "https://avatars.example.com/pondorasti.png",
        login: "pondorasti",
      }),
    });
    const response = await handler(routeContext("pondorasti"));
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("profile");
    expect(fetchAvatar).toHaveBeenCalledWith("https://avatars.example.com/pondorasti.png");
    expect(svg).toContain('id="avatar"');
    expect(svg).toContain("data:image/png;base64,iVBORw==");
  });

  it("keeps the gradient fallback when the avatar cannot be loaded", async () => {
    const handler = makeProfileFaviconHandler({
      fetchAvatar: async () => new Response("unavailable", { status: 503 }),
      loadProfile: async () => ({
        avatarUrl: "https://avatars.example.com/pondorasti.png",
        login: "pondorasti",
      }),
    });
    const response = await handler(routeContext("pondorasti"));
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("fallback");
    expect(svg).toContain('id="gradient"');
    expect(svg).not.toContain('id="avatar"');
  });

  it("returns not found for an unknown profile", async () => {
    const handler = makeProfileFaviconHandler({
      fetchAvatar: async () => new Response(),
      loadProfile: async () => null,
    });

    expect((await handler(routeContext("missing"))).status).toBe(404);
  });
});

function routeContext(login: string) {
  return {
    params: { login },
    request: new Request(`https://tokenmaxxing.sh/favicon/${login}.svg`),
  };
}
