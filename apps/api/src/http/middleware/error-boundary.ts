import { Cause, Effect, Layer, Result, type Types } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import {
  BadRequest,
  ErrorBoundary,
  InternalServerError,
  UnsupportedMediaType,
} from "@tokenmaxxing/api-contract";

/**
 * Gives every contract endpoint one error envelope. Left alone, the builder
 * turns a request that fails to decode into a defect rendered as an empty
 * 400 (no content-type, no body, and — since it bypasses the router
 * middleware — no x-request-id), answers an unsupported content-type with a
 * text/plain 415, and a defect becomes an empty 500. Here they become typed
 * contract errors, so the builder encodes them like any other: a JSON
 * `{ _tag, message }` body that clients decode.
 *
 * Applied to every endpoint and outermost (see TokenmaxxingApi), so it also
 * sees faults raised by the auth middlewares.
 */

const ErrorBoundaryLive = Layer.succeed(
  ErrorBoundary,
  ErrorBoundary.of((httpEffect) =>
    httpEffect.pipe(
      Effect.flatMap((response) =>
        // The builder's only 415 is its unsupported-content-type reply.
        response.status === 415
          ? Effect.fail(new UnsupportedMediaType())
          : Effect.succeed(response),
      ),
      Effect.catchCause((cause): Effect.Effect<never, BoundaryError | Types.unhandled> => {
        const error = Cause.findErrorOption(cause);
        if (error._tag === "Some") {
          return HttpApiError.HttpApiSchemaError.is(error.value)
            ? schemaFailure(error.value)
            : Effect.failCause(cause);
        }

        const defect = Cause.findDefect(cause);
        if (Result.isFailure(defect)) {
          // Interrupted (client went away): nothing to render.
          return Effect.failCause(cause);
        }

        return HttpApiError.HttpApiSchemaError.is(defect.success)
          ? schemaFailure(defect.success)
          : internalServerError(cause);
      }),
    ),
  ),
);

type BoundaryError = BadRequest | InternalServerError | UnsupportedMediaType;

const REQUEST_PARTS = {
  Headers: "header",
  Params: "path parameter",
  Payload: "request body field",
  Query: "query parameter",
} as const;

/**
 * Request decode failures are the client's: 400 naming the first failing
 * field (never the decoder's message, which echoes internals like brands and
 * filters). Response encoding failures (`Body`, `ResponseHeaders`) are ours.
 */
function schemaFailure(error: HttpApiError.HttpApiSchemaError) {
  if (error.kind === "Body" || error.kind === "ResponseHeaders") {
    return internalServerError(Cause.fail(error));
  }

  return Effect.fail(badRequest(error));
}

function badRequest(error: HttpApiError.HttpApiSchemaError): BadRequest {
  const part = REQUEST_PARTS[error.kind as keyof typeof REQUEST_PARTS];
  const [issue] = SchemaIssue.makeFormatterStandardSchemaV1()(error.cause.issue).issues;
  const path = issue === undefined ? "" : formatPath(issue.path ?? []);
  if (path === "") {
    return new BadRequest({
      message: error.kind === "Payload" ? "Invalid request body." : `Invalid ${part}.`,
    });
  }

  return new BadRequest({ message: `Invalid ${part} \`${path}\`.` });
}

function formatPath(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string {
  let formatted = "";
  for (const segment of path) {
    const key = typeof segment === "object" ? segment.key : segment;
    formatted +=
      typeof key === "number" ? `[${key}]` : formatted === "" ? String(key) : `.${String(key)}`;
  }

  return formatted;
}

function internalServerError(cause: Cause.Cause<unknown>) {
  return Effect.logError("request died", cause).pipe(
    Effect.andThen(Effect.fail(new InternalServerError())),
  );
}

export { badRequest, ErrorBoundaryLive };
