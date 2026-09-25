import { describe, expect, it } from "vite-plus/test";

import {
  compareVersions,
  distTagsFromRegistry,
  followedDistTags,
  isNewerVersion,
  parseSemVer,
  releaseChannel,
  resolveUpdate,
} from "./cli-version";

describe("compareVersions", () => {
  // [left, right, sign(left - right)]
  const table: ReadonlyArray<readonly [string, string, -1 | 0 | 1]> = [
    // stable vs stable
    ["0.6.0", "0.6.0", 0],
    ["0.6.0", "0.6.1", -1],
    ["0.6.1", "0.6.0", 1],
    ["0.6.9", "0.7.0", -1],
    ["0.9.0", "0.10.0", -1],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0", "0.99.99", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.2.3", "1.2.10", -1],
    ["99999999999999999999.0.0", "99999999999999999998.0.0", 1],
    // release outranks its own prereleases, but not a higher core
    ["0.7.0-alpha.0", "0.7.0", -1],
    ["0.7.0", "0.7.0-alpha.0", 1],
    ["0.7.0", "0.7.0-rc.99", 1],
    ["0.7.0-alpha.0", "0.6.0", 1],
    ["0.6.0", "0.7.0-alpha.0", -1],
    ["0.7.0-alpha.0", "0.6.9", 1],
    ["0.7.0-alpha.0", "0.7.1", -1],
    ["0.7.1-alpha.0", "0.7.0", 1],
    // prerelease ordering (semver 2.0 §11 example chain)
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    ["1.0.0-beta", "1.0.0-beta.2", -1],
    ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-beta.11", "1.0.0-rc.1", -1],
    ["1.0.0-rc.1", "1.0.0", -1],
    // numeric identifiers compare by value, not lexically
    ["0.7.0-alpha.9", "0.7.0-alpha.10", -1],
    ["0.7.0-alpha.10", "0.7.0-alpha.9", 1],
    ["0.7.0-alpha.2", "0.7.0-alpha.10", -1],
    ["0.7.0-alpha.99999999999999999999", "0.7.0-alpha.100000000000000000000", -1],
    // numeric < alphanumeric; alphanumeric in ASCII order
    ["0.7.0-1", "0.7.0-alpha", -1],
    ["0.7.0-alpha.1", "0.7.0-alpha.a", -1],
    ["0.7.0-alpha", "0.7.0-beta", -1],
    ["0.7.0-Beta", "0.7.0-alpha", -1],
    ["0.7.0-alpha.1a", "0.7.0-alpha.1b", -1],
    // longer identifier list wins once the prefix is equal
    ["0.7.0-alpha", "0.7.0-alpha.0", -1],
    ["0.7.0-alpha.1.0", "0.7.0-alpha.1", 1],
    // equal, ignoring a leading v, surrounding whitespace, and build metadata
    ["0.7.0-alpha.0", "0.7.0-alpha.0", 0],
    ["v0.7.0", "0.7.0", 0],
    [" 0.7.0\n", "0.7.0", 0],
    ["0.7.0+build.1", "0.7.0+build.2", 0],
    ["0.7.0-rc.1+sha.abc", "0.7.0-rc.1", 0],
  ];

  for (const [left, right, expected] of table) {
    it(`${left} vs ${right} -> ${expected}`, () => {
      expect(compareVersions(left, right)).toBe(expected);
      expect(compareVersions(right, left)).toBe(expected === 0 ? 0 : -expected);
    });
  }

  const malformed = [
    "",
    "latest",
    "0.7",
    "0.7.0.1",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "0.7.0-",
    "0.7.0-alpha..1",
    "0.7.0-alpha.01",
    "0.7.0+",
    "0.7.0-alpha_1",
    "=0.7.0",
    "^0.7.0",
    "0.7.x",
  ];

  for (const version of malformed) {
    it(`treats ${JSON.stringify(version)} as malformed`, () => {
      expect(parseSemVer(version)).toBeNull();
      expect(compareVersions(version, "0.7.0")).toBeNull();
      expect(compareVersions("0.7.0", version)).toBeNull();
      expect(isNewerVersion(version, "99.0.0")).toBe(false);
      expect(isNewerVersion("0.0.1", version)).toBe(false);
    });
  }
});

describe("isNewerVersion", () => {
  it("only accepts strictly greater candidates", () => {
    expect(isNewerVersion("0.6.0", "0.6.1")).toBe(true);
    expect(isNewerVersion("0.7.0-alpha.0", "0.7.0-alpha.1")).toBe(true);
    expect(isNewerVersion("0.7.0-alpha.0", "0.7.0")).toBe(true);
    expect(isNewerVersion("0.6.0", "0.6.0")).toBe(false);
    expect(isNewerVersion("0.7.0-alpha.0", "0.6.0")).toBe(false);
    expect(isNewerVersion("0.7.0", "0.7.0-alpha.9")).toBe(false);
  });
});

describe("releaseChannel", () => {
  it("maps a version to the dist-tag it is published under", () => {
    expect(releaseChannel("0.4.18")).toBe("latest");
    expect(releaseChannel("v0.4.18")).toBe("latest");
    expect(releaseChannel("0.4.18-alpha.1")).toBe("alpha");
    expect(releaseChannel("0.4.18-beta.2")).toBe("beta");
    expect(releaseChannel("0.4.18-rc.0+build")).toBe("rc");
    expect(releaseChannel("0.4.18-next")).toBe("next");
    expect(releaseChannel("0.4.18-0")).toBe("latest");
    expect(releaseChannel("not-a-version")).toBe("latest");
  });

  it("follows latest for stable versions and channel + latest for prereleases", () => {
    expect(followedDistTags("0.6.0")).toEqual(["latest"]);
    expect(followedDistTags("0.7.0-alpha.0")).toEqual(["alpha", "latest"]);
    expect(followedDistTags("1.0.0-latest.1")).toEqual(["latest"]);
  });
});

describe("resolveUpdate", () => {
  const cases: ReadonlyArray<{
    current: string;
    distTags: Record<string, string>;
    name: string;
    newest: string | null;
    update: { distTag: string; version: string } | null;
  }> = [
    {
      current: "0.7.0-alpha.0",
      distTags: { alpha: "0.7.0-alpha.0", latest: "0.6.0" },
      name: "alpha user on the newest alpha stays put (never 0.6.0)",
      newest: "0.7.0-alpha.0",
      update: null,
    },
    {
      current: "0.7.0-alpha.0",
      distTags: { alpha: "0.7.0-alpha.1", latest: "0.6.0" },
      name: "alpha user follows alpha",
      newest: "0.7.0-alpha.1",
      update: { distTag: "alpha", version: "0.7.0-alpha.1" },
    },
    {
      current: "0.7.0-alpha.1",
      distTags: { alpha: "0.7.0-alpha.1", latest: "0.7.0" },
      name: "alpha user graduates to the release on latest",
      newest: "0.7.0",
      update: { distTag: "latest", version: "0.7.0" },
    },
    {
      current: "0.7.0-alpha.1",
      distTags: { alpha: "0.8.0-alpha.0", latest: "0.7.0" },
      name: "alpha user takes the highest of the two tags",
      newest: "0.8.0-alpha.0",
      update: { distTag: "alpha", version: "0.8.0-alpha.0" },
    },
    {
      current: "0.7.0-alpha.1",
      distTags: { alpha: "0.7.0", latest: "0.7.0" },
      name: "ties prefer latest",
      newest: "0.7.0",
      update: { distTag: "latest", version: "0.7.0" },
    },
    {
      current: "0.7.0-alpha.3",
      distTags: { alpha: "0.7.0-alpha.2", latest: "0.6.0" },
      name: "a rolled-back channel tag never downgrades",
      newest: "0.7.0-alpha.2",
      update: null,
    },
    {
      current: "0.7.0-alpha.0",
      distTags: { latest: "0.6.0" },
      name: "missing channel tag falls back to latest without downgrading",
      newest: "0.6.0",
      update: null,
    },
    {
      current: "0.7.0-beta.0",
      distTags: { alpha: "0.7.0-alpha.5", beta: "0.7.0-beta.1", latest: "0.6.0" },
      name: "beta user ignores the alpha channel",
      newest: "0.7.0-beta.1",
      update: { distTag: "beta", version: "0.7.0-beta.1" },
    },
    {
      current: "0.6.0",
      distTags: { alpha: "0.7.0-alpha.1", latest: "0.6.0" },
      name: "stable user ignores prerelease channels",
      newest: "0.6.0",
      update: null,
    },
    {
      current: "0.6.0",
      distTags: { alpha: "0.7.0-alpha.1", latest: "0.6.1" },
      name: "stable user follows latest",
      newest: "0.6.1",
      update: { distTag: "latest", version: "0.6.1" },
    },
    {
      current: "0.6.1",
      distTags: { latest: "0.6.0" },
      name: "stable user ahead of latest stays put",
      newest: "0.6.0",
      update: null,
    },
    {
      current: "0.7.0-alpha.0",
      distTags: { alpha: "garbage", latest: "0.6.0" },
      name: "malformed tag values are ignored",
      newest: "0.6.0",
      update: null,
    },
    {
      current: "garbage",
      distTags: { latest: "0.6.0" },
      name: "malformed current version never updates",
      newest: "0.6.0",
      update: null,
    },
    {
      current: "0.6.0",
      distTags: {},
      name: "no usable tags",
      newest: null,
      update: null,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const resolution = resolveUpdate(testCase.current, testCase.distTags);
      expect(resolution.newest?.version ?? null).toBe(testCase.newest);
      expect(resolution.update).toEqual(testCase.update);
    });
  }
});

describe("distTagsFromRegistry", () => {
  it("keeps string dist-tags and rejects non-objects", () => {
    expect(distTagsFromRegistry({ alpha: "0.7.0-alpha.0", latest: "0.6.0", bad: 1 })).toEqual({
      alpha: "0.7.0-alpha.0",
      latest: "0.6.0",
    });
    expect(distTagsFromRegistry(null)).toBeNull();
    expect(distTagsFromRegistry("0.6.0")).toBeNull();
    expect(distTagsFromRegistry(["0.6.0"])).toBeNull();
  });
});
