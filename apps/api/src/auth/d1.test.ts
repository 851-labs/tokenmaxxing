import { describe, expect, it } from "vite-plus/test";

import { mergedShadowBan } from "./d1";

const visible = {
  shadowBannedAt: null,
  shadowBannedByUserId: null,
};

const banned = {
  shadowBannedAt: new Date("2026-07-09T20:00:00.000Z"),
  shadowBannedByUserId: "admin_123",
};

describe("mergedShadowBan", () => {
  it("propagates a source account ban to a visible target", () => {
    expect(mergedShadowBan(banned, visible)).toEqual(banned);
  });

  it("keeps an existing target ban", () => {
    expect(mergedShadowBan(visible, banned)).toEqual(banned);
  });

  it("keeps two visible accounts visible", () => {
    expect(mergedShadowBan(visible, visible)).toEqual(visible);
  });
});
