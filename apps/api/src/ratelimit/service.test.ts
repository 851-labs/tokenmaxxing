import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { POLL_INTERVAL_SECONDS } from "../clilogin/service";
import { makeTestLogger } from "../testing/logger";
import { makeRateLimiter, RATE_LIMIT_RULES, rateLimitKey } from "./service";

describe("rateLimitKey", () => {
  it("keeps IPv4 addresses whole", () => {
    expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKey(" 203.0.113.9 ")).toBe("203.0.113.9");
  });

  it("buckets IPv6 addresses by /64, however they are written", () => {
    const key = "2001:db8:0:1::/64";
    for (const ip of [
      "2001:db8:0:1::1",
      "2001:DB8:0000:0001:ffff:ffff:ffff:ffff",
      "2001:db8::1:0:0:0:2",
      "2001:0db8:0:1:1:2:3:4",
    ]) {
      expect(rateLimitKey(ip)).toBe(key);
    }

    expect(rateLimitKey("2001:db8:0:2::1")).not.toBe(key);
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("counts unparseable values under themselves", () => {
    for (const ip of [
      "::ffff:203.0.113.9",
      "1::2::3",
      "1:2:3",
      "2001:db8::g",
      "1:2:3:4:5:6:7:8:9",
    ]) {
      expect(rateLimitKey(ip)).toBe(ip);
    }
  });
});

describe("makeRateLimiter", () => {
  const allowing = { limit: () => Effect.succeed({ success: true }) };
  const refusing = { limit: () => Effect.succeed({ success: false }) };

  it("allows and refuses as the rule's binding says", async () => {
    const limiter = makeRateLimiter({ cliLoginPoll: refusing, cliLoginStart: allowing });

    expect(await Effect.runPromise(limiter.limit("cliLoginStart", "203.0.113.9"))).toBe(true);
    expect(await Effect.runPromise(limiter.limit("cliLoginPoll", "203.0.113.9"))).toBe(false);
  });

  it("passes the client key to the binding", async () => {
    const keys: string[] = [];
    const limiter = makeRateLimiter({
      cliLoginPoll: allowing,
      cliLoginStart: {
        limit: ({ key }) => Effect.sync(() => keys.push(key)).pipe(Effect.as({ success: true })),
      },
    });

    await Effect.runPromise(limiter.limit("cliLoginStart", "203.0.113.9"));

    expect(keys).toEqual(["203.0.113.9"]);
  });

  it("fails open, with a warning, when the binding errors", async () => {
    const logs = makeTestLogger();
    const limiter = makeRateLimiter({
      cliLoginPoll: allowing,
      cliLoginStart: { limit: () => Effect.fail(new Error("binding missing")) },
    });

    const allowed = await Effect.runPromise(
      limiter.limit("cliLoginStart", "203.0.113.9").pipe(Effect.provide(logs.layer)),
    );

    expect(allowed).toBe(true);
    expect(logs.entries).toEqual([
      expect.objectContaining({
        args: [{ error: new Error("binding missing"), rule: "cliLoginStart" }],
        level: "Warn",
        message: "rate limiter failed; allowing the request",
      }),
    ]);
  });
});

describe("RATE_LIMIT_RULES", () => {
  it("gives every rule its own binding and namespace", () => {
    const rules = Object.values(RATE_LIMIT_RULES);

    expect(new Set(rules.map((rule) => rule.binding)).size).toBe(rules.length);
    expect(new Set(rules.map((rule) => rule.namespaceId)).size).toBe(rules.length);
  });

  it("leaves a polling CLI at least 2x headroom", () => {
    const pollsPerPeriod = RATE_LIMIT_RULES.cliLoginPoll.period / POLL_INTERVAL_SECONDS;

    expect(RATE_LIMIT_RULES.cliLoginPoll.limit).toBeGreaterThanOrEqual(2 * pollsPerPeriod);
  });
});
