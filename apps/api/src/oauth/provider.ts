import { Data, Effect } from "effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import type { OAuthProviderId } from "@tokenmaxxing/api-contract";

import type { OAuthProfile } from "../auth/service";

/**
 * The provider half of the browser OAuth flow. Identity only: the access
 * token is used for one profile read and then dropped.
 */

/** Transport failure, or a response body that does not match its schema. */
class OAuthRequestError extends Data.TaggedError("OAuthRequestError")<{
  readonly cause: unknown;
  readonly provider: OAuthProviderId;
  readonly url: string;
}> {}

class OAuthStatusError extends Data.TaggedError("OAuthStatusError")<{
  readonly provider: OAuthProviderId;
  readonly status: number;
  readonly url: string;
}> {}

/** The token endpoint answered 2xx without an access token (e.g. an
 * expired or replayed code). */
class OAuthTokenRejected extends Data.TaggedError("OAuthTokenRejected")<{
  readonly provider: OAuthProviderId;
  readonly reason: string;
}> {}

type OAuthProviderError = OAuthRequestError | OAuthStatusError | OAuthTokenRejected;

interface OAuthProvider {
  readonly id: OAuthProviderId;
  /** Where the browser goes to consent; `codeChallenge` is the PKCE S256 challenge. */
  authorizeUrl(redirectUri: string, state: string, codeChallenge: string): string;
  /** Authorization-code exchange (PKCE); returns the user access token. */
  exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Effect.Effect<string, OAuthProviderError>;
  fetchProfile(accessToken: string): Effect.Effect<OAuthProfile, OAuthProviderError>;
}

const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

/** JSON-over-HTTP for one provider: non-2xx and undecodable bodies become
 * that provider's typed errors. */
const makeOAuthHttp = Effect.fn("makeOAuthHttp")(function* (provider: OAuthProviderId) {
  const http = yield* HttpClient.HttpClient;

  const requestJson = <A>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.ConstraintDecoder<A>,
  ): Effect.Effect<A, OAuthRequestError | OAuthStatusError> =>
    Effect.gen(function* () {
      const response = yield* http.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new OAuthStatusError({ provider, status: response.status, url: request.url }),
        );
      }

      return yield* HttpClientResponse.schemaBodyJson(schema)(response);
    }).pipe(
      Effect.catchTag(["HttpClientError", "SchemaError"], (cause) =>
        Effect.fail(new OAuthRequestError({ cause, provider, url: request.url })),
      ),
      Effect.withSpan("OAuthHttp.requestJson", { attributes: { provider } }),
    );

  const requestAccessToken = (request: HttpClientRequest.HttpClientRequest) =>
    requestJson(request, TokenResponse).pipe(
      Effect.flatMap(({ access_token, error }) =>
        access_token === undefined
          ? Effect.fail(new OAuthTokenRejected({ provider, reason: error ?? "no token" }))
          : Effect.succeed(access_token),
      ),
    );

  return { requestAccessToken, requestJson };
});

export { makeOAuthHttp, OAuthRequestError, OAuthStatusError, OAuthTokenRejected };

export type { OAuthProvider, OAuthProviderError };
