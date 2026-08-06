import { describe, expect, it } from "vitest";

import {
  DEFAULT_FAVICON_URL,
  faviconMimeType,
  faviconUrlFromMatches,
  profileFaviconUrl,
} from "./favicon";
import {
  avatarFetchUrl,
  buildFaviconSvg,
  FAVICON_LAYOUT,
  GRADIENT_CLIP_PATH,
  MAX_AVATAR_BYTES,
  responseImageDataUrl,
} from "./favicon-svg";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("favicon layout", () => {
  it("fills the canvas with the gradient and anchors the avatar to the bottom-right corner", () => {
    const { avatar, canvasSize, gradient } = FAVICON_LAYOUT;

    expect(avatar.x + avatar.size).toBe(canvasSize);
    expect(avatar.y + avatar.size).toBe(canvasSize);
    expect(GRADIENT_CLIP_PATH).toContain(
      `A${avatar.size / 2 + avatar.notchGap} ${avatar.size / 2 + avatar.notchGap}`,
    );
    expect(gradient.x + gradient.size / 2).toBe(canvasSize / 2);
    expect(gradient.y + gradient.size / 2).toBe(canvasSize / 2);
    expect(gradient.size).toBe(64);
    expect(gradient.radius).toBe(8);
  });

  it("uses the same full-size gradient geometry with and without a profile image", () => {
    const defaultSvg = buildFaviconSvg(null);
    const profileSvg = buildFaviconSvg("data:image/png;base64,iVBORw0KGgo=");
    const gradientGeometry = `x="${FAVICON_LAYOUT.gradient.x}" y="${FAVICON_LAYOUT.gradient.y}" width="${FAVICON_LAYOUT.gradient.size}" height="${FAVICON_LAYOUT.gradient.size}"`;

    expect(defaultSvg).toContain(gradientGeometry);
    expect(profileSvg).toContain(gradientGeometry);
    expect(defaultSvg).not.toContain('id="avatar"');
    expect(defaultSvg).toContain(`rx="${FAVICON_LAYOUT.gradient.radius}"`);
    expect(profileSvg).toContain('id="avatar"');
    expect(profileSvg).toContain(`<path d="${GRADIENT_CLIP_PATH}"/>`);
    expect(profileSvg).not.toContain("<mask");
  });
});

describe("favicon URLs", () => {
  it("uses a canonical profile URL without client-controlled cache keys", () => {
    expect(
      profileFaviconUrl({
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        login: "alex test",
      }),
    ).toBe("/favicon/alex%20test.svg?v=9");
  });

  it("selects exactly one favicon from the active route data", () => {
    expect(
      faviconUrlFromMatches([
        { routeId: "__root__" },
        {
          loaderData: {
            profile: {
              user: {
                avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
                login: "pondorasti",
              },
            },
          },
          routeId: "/$user",
        },
      ]),
    ).toBe("/favicon/pondorasti.svg?v=9");
    expect(faviconUrlFromMatches([{ routeId: "__root__" }])).toBe(DEFAULT_FAVICON_URL);
  });

  it("describes the root asset as PNG and composites as SVG", () => {
    expect(faviconMimeType(DEFAULT_FAVICON_URL)).toBe("image/png");
    expect(faviconMimeType("/favicon/pondorasti.svg?v=9")).toBe("image/svg+xml");
  });
});

describe("avatar fetching", () => {
  it("requests a small GitHub avatar and normalizes Google sizes", () => {
    expect(avatarFetchUrl("https://avatars.githubusercontent.com/u/1?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4&s=64",
    );
    expect(avatarFetchUrl("https://lh3.googleusercontent.com/a/example=s96-c")).toBe(
      "https://lh3.googleusercontent.com/a/example=s64-c",
    );
  });

  it("rejects untrusted origins, credentials, and nonstandard ports", () => {
    expect(avatarFetchUrl("https://example.com/avatar.png")).toBeNull();
    expect(avatarFetchUrl("https://user@avatars.githubusercontent.com/u/1")).toBeNull();
    expect(avatarFetchUrl("https://avatars.githubusercontent.com:444/u/1")).toBeNull();
  });

  it("embeds a supported raster image with a valid signature", async () => {
    const dataUrl = await responseImageDataUrl(
      new Response(PNG_SIGNATURE, {
        headers: { "content-type": "image/png" },
      }),
    );

    expect(dataUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("cancels a chunked response as soon as it exceeds the byte limit", async () => {
    let cancelled = false;
    const firstChunk = new Uint8Array(MAX_AVATAR_BYTES);
    firstChunk.set(PNG_SIGNATURE);
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(firstChunk);
        controller.enqueue(new Uint8Array([1]));
      },
    });

    await expect(
      responseImageDataUrl(
        new Response(body, {
          headers: { "content-type": "image/png" },
        }),
      ),
    ).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });
});
