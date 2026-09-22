import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { AppConfig } from "../config";
import { makeOAuthHttp, type OAuthProvider } from "./provider";

/** Google OpenID Connect: the code exchange and the userinfo read. */

const GoogleUserInfo = Schema.Struct({
  email: Schema.optional(Schema.NullOr(Schema.String)),
  email_verified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  picture: Schema.optional(Schema.NullOr(Schema.String)),
  sub: Schema.String,
});

const makeGoogleProvider = Effect.fn("makeGoogleProvider")(function* () {
  const { google } = yield* AppConfig;
  const http = yield* makeOAuthHttp("google");

  const provider: OAuthProvider = {
    id: "google",
    authorizeUrl: (redirectUri, state, codeChallenge) => {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", google.clientId);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);

      return url.toString();
    },
    exchangeCode: (code, redirectUri, codeVerifier) =>
      http.requestAccessToken(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: google.clientId,
            client_secret: google.clientSecret,
            code,
            code_verifier: codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }),
        ),
      ),
    fetchProfile: (accessToken) =>
      http
        .requestJson(
          HttpClientRequest.get("https://openidconnect.googleapis.com/v1/userinfo", {
            headers: { authorization: `Bearer ${accessToken}` },
          }),
          GoogleUserInfo,
        )
        .pipe(
          Effect.map((user) => ({
            avatarUrl: user.picture ?? null,
            email: user.email ?? null,
            emailVerified: user.email_verified === true,
            login: null,
            name: user.name ?? null,
            provider: "google" as const,
            providerAccountId: user.sub,
          })),
        ),
  };

  return provider;
});

export { makeGoogleProvider };
