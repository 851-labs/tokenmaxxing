import { describe, expect, it } from "vite-plus/test";

import { stageNameForResource } from "./stage";

describe("stageNameForResource", () => {
  it("uses dev when alchemy provides an empty local stage", () => {
    expect(stageNameForResource("")).toBe("dev");
    expect(stageNameForResource("   ")).toBe("dev");
  });

  it("preserves explicit stage names", () => {
    expect(stageNameForResource("prod")).toBe("prod");
    expect(stageNameForResource("development")).toBe("development");
  });

  it("sanitizes generated local stage names for Cloudflare resource names", () => {
    expect(stageNameForResource("dev_alexandru")).toBe("dev-alexandru");
    expect(stageNameForResource("Dev Alexandru")).toBe("dev-alexandru");
    expect(stageNameForResource("__dev__alexandru__")).toBe("dev-alexandru");
  });
});
