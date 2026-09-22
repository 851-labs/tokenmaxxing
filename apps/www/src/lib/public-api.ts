import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

import { resolveApiUrl } from "./config";

/**
 * Anonymous reads of public API resources for server routes (OG card,
 * favicon, sitemap) that run outside the cookie-authenticated client.
 * Responses are schema-validated, never cast.
 */

class PublicApiError extends Data.TaggedError("PublicApiError")<{
  message: string;
  status: number;
}> {}

interface FetchPublicOptions {
  signal?: AbortSignal;
}

/**
 * GET an API path and decode it with `schema`. Resolves `null` on 404 (an
 * unknown or hidden resource); rejects on any other non-2xx.
 */
async function fetchPublicJson<S extends Schema.ConstraintDecoder<unknown>>(
  path: `/${string}`,
  schema: S,
  { signal }: FetchPublicOptions = {},
): Promise<S["Type"] | null> {
  const apiUrl = resolveApiUrl().replace(/\/$/, "");
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new PublicApiError({
      message: `Failed to load ${path}: ${response.status}`,
      status: response.status,
    });
  }

  return Schema.decodeUnknownPromise(schema)(await response.json());
}

/** GET `/profiles/:login{path}`, e.g. `fetchPublicProfile(login, "/identity", schema)`. */
function fetchPublicProfile<S extends Schema.ConstraintDecoder<unknown>>(
  login: string,
  path: "" | `/${string}`,
  schema: S,
  options?: FetchPublicOptions,
): Promise<S["Type"] | null> {
  return fetchPublicJson(`/profiles/${encodeURIComponent(login)}${path}`, schema, options);
}

export { fetchPublicJson, fetchPublicProfile, PublicApiError };

export type { FetchPublicOptions };
