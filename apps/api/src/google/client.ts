import { Context, Data, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { OAuthProfile } from "../auth/service";
import { AppConfig, type AppConfigShape } from "../config";

class GoogleApiError extends Data.TaggedError("GoogleApiError")<{
  readonly cause: unknown;
}> {}

interface GoogleClientShape {
  exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Effect.Effect<string, GoogleApiError>;
  fetchUser(accessToken: string): Effect.Effect<OAuthProfile, GoogleApiError>;
}

class GoogleClient extends Context.Service<GoogleClient, GoogleClientShape>()(
  "@tokenmaxxing/api/GoogleClient",
) {}

const makeGoogleClient = Effect.fn("makeGoogleClient")(function* () {
  const config = yield* AppConfig;
  const http = yield* HttpClient.HttpClient;

  const requestJson = Effect.fn("GoogleClient.requestJson")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError((cause) => new GoogleApiError({ cause })));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new GoogleApiError({
          cause: new Error(`Google responded ${response.status} for ${request.url}`),
        }),
      );
    }

    return yield* response.json.pipe(Effect.mapError((cause) => new GoogleApiError({ cause })));
  });

  return GoogleClient.of({
    exchangeCode: Effect.fn("GoogleClient.exchangeCode")(
      function* (code, redirectUri, codeVerifier) {
        const payload = (yield* requestJson(
          HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: config.google.clientId,
              client_secret: config.google.clientSecret,
              code,
              code_verifier: codeVerifier,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
            }),
          ),
        )) as { access_token?: string; error?: string };
        if (typeof payload.access_token !== "string") {
          return yield* Effect.fail(
            new GoogleApiError({
              cause: new Error(`Google token exchange rejected: ${payload.error ?? "no token"}`),
            }),
          );
        }

        return payload.access_token;
      },
    ),
    fetchUser: Effect.fn("GoogleClient.fetchUser")(function* (accessToken) {
      const payload = (yield* requestJson(
        HttpClientRequest.get("https://openidconnect.googleapis.com/v1/userinfo", {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
      )) as {
        email?: string;
        email_verified?: boolean;
        name?: string | null;
        picture?: string | null;
        sub: string;
      };

      return {
        avatarUrl: payload.picture ?? null,
        email: payload.email ?? null,
        emailVerified: payload.email_verified === true,
        login: null,
        name: payload.name ?? null,
        provider: "google",
        providerAccountId: payload.sub,
      };
    }),
  });
});

function buildGoogleAuthorizeUrl(
  config: AppConfigShape["google"],
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);

  return url.toString();
}

export { buildGoogleAuthorizeUrl, GoogleClient, makeGoogleClient };
