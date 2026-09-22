import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  generateLoginCode,
  generateToken,
  hashCliToken,
  normalizeLoginCode,
  sha256Hex,
} from "./crypto";

describe("normalizeLoginCode", () => {
  it.each([
    ["K3QF-W8MT", "K3QF-W8MT"],
    ["k3qf-w8mt", "K3QF-W8MT"],
    ["k3qfw8mt", "K3QF-W8MT"],
    ["  K3QF-W8MT\n", "K3QF-W8MT"],
    ["K3-QF-W8-MT", "K3QF-W8MT"],
    ["--k3qf--w8mt--", "K3QF-W8MT"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeLoginCode(input)).toBe(expected);
  });

  it("is idempotent on generated codes", () => {
    for (let index = 0; index < 50; index += 1) {
      const code = generateLoginCode();
      expect(normalizeLoginCode(code)).toBe(code);
      expect(normalizeLoginCode(code.toLowerCase().replace("-", ""))).toBe(code);
    }
  });
});

describe("generateLoginCode", () => {
  it("uses only the unambiguous alphabet in XXXX-XXXX form", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateLoginCode()).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    }
  });
});

describe("tokens", () => {
  it("generates 32-byte base64url tokens", () => {
    const token = generateToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
  });

  it("prefixes CLI tokens so they can be recognized before lookup", () => {
    const token = generateCliToken();

    expect(token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
    expect(token.slice(CLI_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes with hex sha-256, labelled for CLI tokens", async () => {
    const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    expect(await Effect.runPromise(sha256Hex("abc"))).toBe(digest);
    expect(await Effect.runPromise(hashCliToken("abc"))).toBe(`sha256:${digest}`);
  });
});
