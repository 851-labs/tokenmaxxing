import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import {
  makeRateLimiter,
  RATE_LIMIT_RULES,
  type RateLimitBindingClient,
  type RateLimitRule,
} from "../ratelimit/service";

/**
 * Binds one Workers Rate Limiting binding per rule to the surrounding
 * Worker and returns the RateLimiter over them. Yield it inside the Worker
 * effect (like the D1/R2 bindings) with `Cloudflare.Workers.RateLimitBinding`
 * provided; alchemy dev emulates the bindings locally.
 */
const RateLimiterBindings = Effect.gen(function* () {
  const bind = Effect.fnUntraced(function* (rule: RateLimitRule) {
    const { binding, limit, namespaceId, period } = RATE_LIMIT_RULES[rule];
    const client = yield* Cloudflare.RateLimit(binding, {
      namespaceId,
      simple: { limit, period },
    });
    return {
      limit: (options) => client.limit(options).pipe(Effect.provide(RuntimeContext.phantom)),
    } satisfies RateLimitBindingClient;
  });

  return makeRateLimiter({
    cliLoginPoll: yield* bind("cliLoginPoll"),
    cliLoginStart: yield* bind("cliLoginStart"),
  });
});

export { RateLimiterBindings };
