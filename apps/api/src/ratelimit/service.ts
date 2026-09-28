import { Context, Effect } from "effect";

/**
 * Per-client request caps for unauthenticated endpoints that do D1 work.
 * Production counts in Cloudflare's Workers Rate Limiting bindings (one per
 * rule, declared in cloudflare/rate-limits.ts): counters are per Cloudflare
 * location and eventually consistent, so a cap is approximate — enough to
 * stop a flood, never a precise quota. Tests and the sandbox inject their own
 * RateLimiter.
 */

/**
 * The single place the numbers live. `period` is 10 or 60 seconds (all the
 * binding supports) and doubles as the Retry-After a limited client gets: the
 * binding does not say when its window resets. `message` is completed with
 * that wait. `namespaceId` must be unique
 * within the Cloudflare account; never reuse one for a different rule.
 */
const RATE_LIMIT_RULES = {
  /** A login is one start; 10/min leaves room for retries and shared NATs. */
  cliLoginStart: {
    binding: "CLI_LOGIN_START_RATE_LIMIT",
    limit: 10,
    message: "Too many login attempts from this network",
    namespaceId: 1001,
    period: 60,
  },
  /** A CLI polls every 2 s (30/min); 60/min is 2x headroom for one login. */
  cliLoginPoll: {
    binding: "CLI_LOGIN_POLL_RATE_LIMIT",
    limit: 60,
    message: "Checking login status too often",
    namespaceId: 1002,
    period: 60,
  },
} as const satisfies Record<
  string,
  {
    binding: string;
    limit: number;
    message: string;
    namespaceId: number;
    period: 10 | 60;
  }
>;

type RateLimitRule = keyof typeof RATE_LIMIT_RULES;

interface RateLimiterShape {
  /** Counts one request for `key` under `rule`; false once over the cap. */
  limit(rule: RateLimitRule, key: string): Effect.Effect<boolean>;
}

class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()(
  "@tokenmaxxing/api/RateLimiter",
) {}

/** The Effect client of one Workers Rate Limiting binding. */
interface RateLimitBindingClient {
  limit(options: { key: string }): Effect.Effect<{ readonly success: boolean }, unknown>;
}

/**
 * A RateLimiter over one binding per rule. A binding that fails (missing,
 * or the runtime call errors) lets the request through: the cap only guards
 * against floods, and failing closed would lock every user out of login.
 */
function makeRateLimiter(bindings: Record<RateLimitRule, RateLimitBindingClient>) {
  return RateLimiter.of({
    limit: (rule, key) =>
      bindings[rule].limit({ key }).pipe(
        Effect.map(({ success }) => success),
        Effect.catch((error) =>
          Effect.logWarning("rate limiter failed; allowing the request", { error, rule }).pipe(
            Effect.as(true),
          ),
        ),
      ),
  });
}

/** Never limits; for the local sandbox and tests that do not exercise it. */
const unlimitedRateLimiter = RateLimiter.of({ limit: () => Effect.succeed(true) });

/**
 * The bucket a client IP counts under. IPv6 clients usually control a whole
 * /64, so they share one bucket per /64 instead of rotating addresses to
 * dodge the cap. Anything unparseable counts under itself.
 */
function rateLimitKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  // IPv4 stays whole, and so does IPv6 with an embedded IPv4 tail
  // (Cloudflare reports IPv4 clients as plain IPv4).
  if (!address.includes(":") || address.includes(".")) {
    return address;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return address;
  }

  const [head = "", tail = ""] = halves;
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return address;
  }

  const groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return address;
  }

  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

export { makeRateLimiter, RATE_LIMIT_RULES, RateLimiter, rateLimitKey, unlimitedRateLimiter };

export type { RateLimitBindingClient, RateLimiterShape, RateLimitRule };
