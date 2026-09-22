import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Route search-param validation on Effect Schema: routes pass
 * `Schema.toStandardSchemaV1(Schema.Struct({ ... }))` to `validateSearch`
 * (TanStack Router accepts any Standard Schema). Search params are
 * user-editable URLs, so params decode leniently: a missing or malformed value
 * falls back instead of throwing the route into its error boundary.
 */

/**
 * Optional in links, always present after validation: missing or invalid
 * values decode to `fallback`.
 */
function searchParam<S extends Schema.Top>(schema: S, fallback: S["Type"]) {
  const lenient = Schema.catchDecoding<S>(() => Effect.succeedSome(fallback))(schema);

  return Schema.withDecodingDefaultTypeKey<typeof lenient>(Effect.succeed(fallback))(lenient);
}

/** Optional everywhere: missing or invalid values decode to `undefined`. */
function optionalSearchParam<S extends Schema.Top>(schema: S) {
  const nullable = Schema.UndefinedOr(schema);
  const lenient = Schema.catchDecoding<typeof nullable>(() => Effect.succeedSome(undefined))(
    nullable,
  );

  return Schema.optionalKey(lenient);
}

export { optionalSearchParam, searchParam };
