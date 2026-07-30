import { describe, expect, it } from "vitest";

import { DEFAULT_FAVICON_URL, profileFaviconUrl } from "./favicon";
import { buildFaviconSvg, FAVICON_LAYOUT, responseImageDataUrl } from "./favicon-svg";

describe("favicon layout", () => {
  it("centers the gradient and anchors the avatar at its center", () => {
    const { avatar, canvasSize, gradient } = FAVICON_LAYOUT;

    expect(avatar.x).toBe(gradient.x + gradient.size / 2);
    expect(avatar.y).toBe(gradient.y + gradient.size / 2);
    expect(gradient.x + gradient.size / 2).toBe(canvasSize / 2);
    expect(gradient.y + gradient.size / 2).toBe(canvasSize / 2);
    expect(gradient.size).toBe(40);
    expect(gradient.radius).toBeGreaterThan(0);
  });

  it("uses the same rounded gradient geometry with and without a profile image", () => {
    const defaultSvg = buildFaviconSvg(null);
    const profileSvg = buildFaviconSvg("data:image/png;base64,YXZhdGFy");
    const gradientTag = defaultSvg.match(/<image id="gradient"[^>]+>/)?.[0];

    expect(gradientTag).toBeDefined();
    expect(profileSvg).toContain(gradientTag);
    expect(defaultSvg).not.toContain('id="avatar"');
    expect(profileSvg).toContain('id="avatar"');
    expect(profileSvg).toContain('clip-path="url(#avatar-clip)"');
  });
});

describe("favicon URLs", () => {
  it("versions profile icons by avatar URL", () => {
    const first = profileFaviconUrl({
      avatarUrl: "https://avatars.example.com/one.png",
      login: "alex test",
    });
    const second = profileFaviconUrl({
      avatarUrl: "https://avatars.example.com/two.png",
      login: "alex test",
    });

    expect(first).toMatch(/^\/favicon\/alex%20test\.svg\?v=[a-z0-9]+$/);
    expect(second).not.toBe(first);
  });

  it("falls back to the default icon for profiles without avatars", () => {
    expect(profileFaviconUrl({ avatarUrl: null, login: "alex" })).toBe(DEFAULT_FAVICON_URL);
  });
});

describe("avatar embedding", () => {
  it("embeds supported raster responses as data URLs", async () => {
    const dataUrl = await responseImageDataUrl(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    );

    expect(dataUrl).toBe("data:image/png;base64,iVBORw==");
  });

  it("rejects unsupported image types", async () => {
    const dataUrl = await responseImageDataUrl(
      new Response("<svg/>", {
        headers: { "content-type": "image/svg+xml" },
      }),
    );

    expect(dataUrl).toBeNull();
  });
});
