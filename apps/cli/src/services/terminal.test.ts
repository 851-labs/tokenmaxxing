import { describe, expect, it } from "vite-plus/test";

import { canOpenExternalBrowser } from "./terminal";

describe("canOpenExternalBrowser", () => {
  it("allows local desktop platforms in interactive shells", () => {
    expect(canOpenExternalBrowser({ env: {}, isInteractive: true, platform: "darwin" })).toBe(true);
    expect(canOpenExternalBrowser({ env: {}, isInteractive: true, platform: "win32" })).toBe(true);
    expect(
      canOpenExternalBrowser({
        env: { DISPLAY: ":0" },
        isInteractive: true,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("blocks non-interactive, CI, and SSH sessions", () => {
    expect(canOpenExternalBrowser({ env: {}, isInteractive: false, platform: "darwin" })).toBe(
      false,
    );
    expect(canOpenExternalBrowser({ env: { CI: "true" }, isInteractive: true })).toBe(false);
    expect(canOpenExternalBrowser({ env: { SSH_TTY: "/dev/pts/0" }, isInteractive: true })).toBe(
      false,
    );
  });

  it("blocks Linux shells without a display server", () => {
    expect(canOpenExternalBrowser({ env: {}, isInteractive: true, platform: "linux" })).toBe(false);
    expect(
      canOpenExternalBrowser({
        env: { WAYLAND_DISPLAY: "wayland-0" },
        isInteractive: true,
        platform: "linux",
      }),
    ).toBe(true);
  });
});
