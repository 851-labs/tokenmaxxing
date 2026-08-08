import { describe, expect, it, vi } from "vitest";

import { safeFilename, shareProfileImage } from "./share-profile";

describe("shareProfileImage", () => {
  it("shares the generated OG image as a PNG file", async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => undefined);
    const download = vi.fn();

    await expect(
      shareProfileImage(input(), {
        canShare: () => true,
        download,
        fetch: imageFetch(),
        share,
      }),
    ).resolves.toBe("shared");

    const data = share.mock.calls[0]?.[0];
    expect(data?.files?.[0]).toMatchObject({
      name: "pondorasti-tokenmaxxing.png",
      type: "image/png",
    });
    expect(data?.text).toContain("https://tokenmaxxing.sh/pondorasti");
    expect(download).not.toHaveBeenCalled();
  });

  it("downloads the image when file sharing is unavailable", async () => {
    const download = vi.fn();

    await expect(
      shareProfileImage(input(), {
        canShare: () => false,
        download,
        fetch: imageFetch(),
        share: vi.fn(),
      }),
    ).resolves.toBe("downloaded");

    expect(download.mock.calls[0]?.[0]).toMatchObject({
      name: "pondorasti-tokenmaxxing.png",
      type: "image/png",
    });
  });

  it("does not download after the user cancels the share sheet", async () => {
    const download = vi.fn();

    await expect(
      shareProfileImage(input(), {
        download,
        fetch: imageFetch(),
        share: async () => {
          throw new DOMException("cancelled", "AbortError");
        },
      }),
    ).resolves.toBe("cancelled");
    expect(download).not.toHaveBeenCalled();
  });

  it("sanitizes usernames used in downloaded filenames", () => {
    expect(safeFilename(" alex/test ")).toBe("alex-test");
    expect(safeFilename("///")).toBe("profile");
  });
});

function input() {
  return {
    imagePath: "/og/pondorasti.png?v=abc",
    login: "pondorasti",
    profileUrl: "https://tokenmaxxing.sh/pondorasti",
  };
}

function imageFetch(): (input: string) => Promise<Response> {
  return vi.fn<(input: string) => Promise<Response>>(
    async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
  );
}
