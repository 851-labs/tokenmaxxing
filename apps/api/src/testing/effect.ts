import { Context, Effect, Exit, Layer } from "effect";

/** Runs repository/service effects whose requirements are erased as `any`. */
function runTest<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, E, never>);
}

function runTestExit<A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect as Effect.Effect<A, E, never>);
}

/** Builds a layer and hands back the service it provides. */
function buildService<I, S, E>(key: Context.Key<I, S>, layer: Layer.Layer<I, E>): Promise<S> {
  return Effect.runPromise(key.pipe(Effect.provide(layer)));
}

export { buildService, runTest, runTestExit };
