import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { AppConfig } from "../config";
import { makeOAuthHttp, type OAuthProvider } from "./provider";

/**
 * GitHub OAuth app: the code exchange and the user profile read. Identity
 * only — no repo access, no GitHub App.
 */

const GitHubUser = Schema.Struct({
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.Number,
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubEmails = Schema.Array(
  Schema.Struct({
    email: Schema.optional(Schema.String),
    primary: Schema.optional(Schema.Boolean),
    verified: Schema.optional(Schema.Boolean),
  }),
);

const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  // GitHub rejects requests without a User-Agent.
  "user-agent": "tokenmaxxing",
});

const makeGitHubProvider = Effect.fn("makeGitHubProvider")(function* () {
  const { github } = yield* AppConfig;
  const http = yield* makeOAuthHttp("github");

  const fetchPrimaryVerifiedEmail = (accessToken: string) =>
    http
      .requestJson(
        HttpClientRequest.get("https://api.github.com/user/emails", {
          headers: githubHeaders(accessToken),
        }),
        GitHubEmails,
      )
      .pipe(
        Effect.map(
          (emails) =>
            emails.find((email) => email.primary === true && email.verified === true)?.email ??
            null,
        ),
      );

  const provider: OAuthProvider = {
    id: "github",
    authorizeUrl: (redirectUri, state, codeChallenge) => {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", github.clientId);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("redirect_uri", redirectUri);
      // Identity only; the public profile is all the leaderboard needs.
      url.searchParams.set("scope", "read:user user:email");
      url.searchParams.set("state", state);

      return url.toString();
    },
    exchangeCode: (code, redirectUri, codeVerifier) =>
      http.requestAccessToken(
        HttpClientRequest.post("https://github.com/login/oauth/access_token", {
          headers: { accept: "application/json" },
        }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_id: github.clientId,
            client_secret: github.clientSecret,
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
          }),
        ),
      ),
    fetchProfile: Effect.fn("GitHubProvider.fetchProfile")(function* (accessToken) {
      const user = yield* http.requestJson(
        HttpClientRequest.get("https://api.github.com/user", {
          headers: githubHeaders(accessToken),
        }),
        GitHubUser,
      );
      // Without the email scope (or on any hiccup) the profile still signs
      // in; it just can't auto-link by verified email.
      const email = yield* fetchPrimaryVerifiedEmail(accessToken).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );

      return {
        avatarUrl: user.avatar_url ?? null,
        email: email ?? user.email ?? null,
        emailVerified: email !== null,
        login: user.login,
        name: user.name ?? null,
        provider: "github",
        providerAccountId: String(user.id),
      };
    }),
  };

  return provider;
});

export { makeGitHubProvider };
