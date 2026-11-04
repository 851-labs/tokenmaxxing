import { Context, type Effect } from "effect";

/**
 * Runs work after the current response is sent, without delaying it. The
 * worker provides it per request around the router, backed by that request's
 * `ctx.waitUntil`, which keeps the invocation alive until the work settles.
 *
 * It must never join the shared services: handlers run with the router's
 * build-time context layered over the request's, so a build-time value would
 * shadow the per-request one (alchemy's own `WorkerExecutionContext` is
 * shadowed exactly that way). Absent (tests, cron), callers run work inline.
 */
class AfterResponse extends Context.Service<
  AfterResponse,
  { run(effect: Effect.Effect<void>): Effect.Effect<void> }
>()("@tokenmaxxing/api/AfterResponse") {}

export { AfterResponse };
