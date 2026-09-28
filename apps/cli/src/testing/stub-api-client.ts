import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { TokenmaxxingApi } from "@tokenmaxxing/api-contract";

import type { TokenmaxxingApiClient } from "../services";

interface StubResponse {
  /** Objects are sent as JSON, strings as text/plain, undefined as no body. */
  body?: unknown;
  status: number;
}

/**
 * The real contract client over canned HTTP responses, keyed
 * `"<METHOD> <path>"`. Tests use it where the behaviour depends on how the
 * client decodes a response (status + body → typed error), which fake client
 * objects would paper over. A list answers successive requests in order and
 * then keeps repeating its last entry. Unmatched requests get an empty 500.
 * Every request's key is appended to `requests`.
 */
function makeStubApiClient(
  responses: Record<string, StubResponse | ReadonlyArray<StubResponse>>,
  requests: string[] = [],
) {
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const key = `${request.method} ${url.pathname}`;
      const answered = requests.filter((previous) => previous === key).length;
      requests.push(key);
      const response = responses[key] ?? { status: 500 };
      return HttpClientResponse.fromWeb(
        request,
        toWebResponse(
          Array.isArray(response)
            ? response[Math.min(answered, response.length - 1)]!
            : (response as StubResponse),
        ),
      );
    }),
  );

  return HttpApiClient.make(TokenmaxxingApi, { baseUrl: "https://api.tokenmaxxing.example" }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.map((client) => client as TokenmaxxingApiClient),
  );
}

// String bodies, not Response.json: under Node, a Response.json body whose
// decode fails is read twice and dies on a detached buffer, which real fetch
// responses never do.
function toWebResponse({ body, status }: StubResponse) {
  if (body === undefined) {
    return new Response(null, { status });
  }

  return typeof body === "string"
    ? new Response(body, { headers: { "content-type": "text/plain" }, status })
    : new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });
}

export { makeStubApiClient };
export type { StubResponse };
