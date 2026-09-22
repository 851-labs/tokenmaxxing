import { Context, Effect, Layer } from "effect";

/** Builds a layer and hands back the service it provides. */
function buildService<I, S, E>(key: Context.Key<I, S>, layer: Layer.Layer<I, E>): Promise<S> {
  return Effect.runPromise(key.pipe(Effect.provide(layer)));
}

export { buildService };
