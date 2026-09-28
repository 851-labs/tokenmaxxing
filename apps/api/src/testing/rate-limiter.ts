import { Effect } from "effect";

import { RATE_LIMIT_RULES, RateLimiter, type RateLimitRule } from "../ratelimit/service";

/**
 * A deterministic RateLimiter: exact per-(rule, key) counters with the
 * production caps (or `limits` overrides) and no time window, so a test
 * trips a cap by sending exactly `limit + 1` requests. `calls` records every
 * check in order.
 */

interface FakeRateLimiter {
  readonly calls: ReadonlyArray<{ readonly key: string; readonly rule: RateLimitRule }>;
  readonly service: RateLimiter["Service"];
}

function makeFakeRateLimiter(limits: Partial<Record<RateLimitRule, number>> = {}): FakeRateLimiter {
  const calls: Array<{ key: string; rule: RateLimitRule }> = [];
  const counts = new Map<string, number>();

  return {
    calls,
    service: RateLimiter.of({
      limit: (rule, key) =>
        Effect.sync(() => {
          calls.push({ key, rule });
          const bucket = `${rule}\u0000${key}`;
          const count = (counts.get(bucket) ?? 0) + 1;
          counts.set(bucket, count);
          return count <= (limits[rule] ?? RATE_LIMIT_RULES[rule].limit);
        }),
    }),
  };
}

export { makeFakeRateLimiter };

export type { FakeRateLimiter };
