import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { optionalSearchParam, searchParam } from "./search";

const validator = Schema.toStandardSchemaV1(
  Schema.Struct({
    window: searchParam(Schema.Literals(["7d", "30d"]), "30d"),
  }),
);

function validate(input: unknown) {
  return validator["~standard"].validate(input);
}

describe("searchParam", () => {
  it("keeps valid values", () => {
    expect(validate({ window: "7d" })).toEqual({ value: { window: "7d" } });
  });

  it("falls back when the param is missing or malformed", () => {
    expect(validate({})).toEqual({ value: { window: "30d" } });
    expect(validate({ window: "2026" })).toEqual({ value: { window: "30d" } });
    expect(validate({ window: 7 })).toEqual({ value: { window: "30d" } });
  });

  it("drops unrelated params", () => {
    expect(validate({ utm_source: "x", window: "7d" })).toEqual({ value: { window: "7d" } });
  });
});

describe("optionalSearchParam", () => {
  const optional = Schema.toStandardSchemaV1(
    Schema.Struct({ provider: optionalSearchParam(Schema.Literals(["github", "google"])) }),
  );

  it("keeps valid values and turns missing or malformed ones into undefined", () => {
    expect(optional["~standard"].validate({ provider: "github" })).toEqual({
      value: { provider: "github" },
    });
    expect(optional["~standard"].validate({})).toEqual({ value: {} });
    expect(optional["~standard"].validate({ provider: "evil" })).toEqual({
      value: { provider: undefined },
    });
  });
});
