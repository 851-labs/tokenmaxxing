import { describe, expect, it } from "vite-plus/test";

import { cliLoginVerificationUri } from "./service";

describe("cliLoginVerificationUri", () => {
  it("points CLI login requests at the canonical login route", () => {
    expect(cliLoginVerificationUri("https://tokenmaxxing.example", "ABCD-1234")).toBe(
      "https://tokenmaxxing.example/login/cli?code=ABCD-1234",
    );
  });

  it("encodes the login code query parameter", () => {
    expect(cliLoginVerificationUri("https://tokenmaxxing.example", "ABCD 1234")).toBe(
      "https://tokenmaxxing.example/login/cli?code=ABCD%201234",
    );
  });
});
