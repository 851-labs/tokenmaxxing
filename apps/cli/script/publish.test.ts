import { describe, expect, it } from "vitest";

import { npmDistTagForVersion, parsePublishCliArgs } from "./publish-options";

describe("publish script dist tags", () => {
  it("uses latest for stable versions and the prerelease identifier otherwise", () => {
    expect(npmDistTagForVersion("0.4.18")).toBe("latest");
    expect(npmDistTagForVersion("0.4.18-alpha.0")).toBe("alpha");
    expect(npmDistTagForVersion("0.4.18-beta.2")).toBe("beta");
    expect(npmDistTagForVersion("0.4.18-rc.1")).toBe("rc");
  });

  it("parses an explicit npm dist-tag override", () => {
    expect(
      parsePublishCliArgs(["--dry-run", "--tag", "alpha", "--out-dir", ".tmp/publish"]),
    ).toEqual({
      dryRun: true,
      outDir: ".tmp/publish",
      tag: "alpha",
    });
  });
});
