import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Context, Data, Effect, Layer, Option } from "effect";

/** Unrecoverable persistence fault (D1 failure or a row that fails to
 * decode); services convert these to defects at their boundary. */
class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

interface D1ConnectionLike {
  raw: Effect.Effect<D1Database>;
}

interface DrizzleShape {
  /**
   * Runs drizzle work against the bound D1 database. D1 has no interactive
   * transactions — `db.batch([...])` inside the callback is the atomicity
   * unit. The ONE place Promise-based persistence enters Effect.
   */
  use<A>(run: (db: DrizzleD1Database) => Promise<A>): Effect.Effect<A, DatabaseError>;
}

class Drizzle extends Context.Service<Drizzle, DrizzleShape>()("@tokenmaxxing/api/Drizzle") {
  static layer(connection: D1ConnectionLike): Layer.Layer<Drizzle> {
    return Layer.succeed(
      Drizzle,
      Drizzle.of({
        use: (run) =>
          connection.raw.pipe(
            Effect.flatMap((db) =>
              Effect.tryPromise({
                try: () => run(drizzle(db)),
                catch: (cause) => new DatabaseError({ cause }),
              }),
            ),
          ),
      }),
    );
  }
}

/** First row of a query result — the shape every `.limit(1)` lookup returns. */
function firstRow<A>(rows: ReadonlyArray<A>): Option.Option<A> {
  return Option.fromUndefinedOr(rows[0]);
}

export { DatabaseError, Drizzle, firstRow };
