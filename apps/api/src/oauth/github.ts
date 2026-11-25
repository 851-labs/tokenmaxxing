import { Context, Data, Duration, Effect, Layer, Option } from "effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

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

/**
 * GitHub account reads outside a sign-in, by the numeric account id stored on
 * user_accounts (logins change; the id never does). Requests authenticate as
 * the OAuth app (client id + secret, HTTP Basic), which GitHub rate-limits
 * per app at 5,000 requests an hour instead of 60 per worker IP.
 */
interface GitHubAccountsShape {
  /** The account's current login; none when GitHub no longer has it. */
  currentLogin(accountId: string): Effect.Effect<Option.Option<string>, GitHubLookupFailed>;
}

class GitHubAccounts extends Context.Service<GitHubAccounts, GitHubAccountsShape>()(
  "@tokenmaxxing/api/GitHubAccounts",
) {}

/** A lookup that did not produce an answer; callers carry on without it. */
class GitHubLookupFailed extends Data.TaggedError("GitHubLookupFailed")<{
  readonly cause?: unknown;
  readonly reason: "rate-limited" | "request" | "status";
  readonly status?: number;
}> {}

const GITHUB_LOOKUP_TIMEOUT = Duration.seconds(5);

const GitHubAccount = Schema.Struct({ login: Schema.String });

const makeGitHubAccounts = Effect.fn("makeGitHubAccounts")(function* () {
  const { github } = yield* AppConfig;
  const http = yield* HttpClient.HttpClient;
  const authorization = `Basic ${btoa(`${github.clientId}:${github.clientSecret}`)}`;

  return GitHubAccounts.of({
    currentLogin: Effect.fn("GitHubAccounts.currentLogin")(function* (accountId) {
      if (!/^\d+$/u.test(accountId)) {
        return Option.none();
      }

      const response = yield* http
        .execute(
          HttpClientRequest.get(`https://api.github.com/user/${accountId}`, {
            headers: {
              accept: "application/vnd.github+json",
              authorization,
              "user-agent": "tokenmaxxing",
              "x-github-api-version": "2022-11-28",
            },
          }),
        )
        .pipe(
          Effect.timeout(GITHUB_LOOKUP_TIMEOUT),
          Effect.mapError((cause) => new GitHubLookupFailed({ cause, reason: "request" })),
        );
      if (response.status === 404) {
        return Option.none();
      }
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0")
      ) {
        return yield* Effect.fail(
          new GitHubLookupFailed({ reason: "rate-limited", status: response.status }),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new GitHubLookupFailed({ reason: "status", status: response.status }),
        );
      }

      const account = yield* HttpClientResponse.schemaBodyJson(GitHubAccount)(response).pipe(
        Effect.mapError((cause) => new GitHubLookupFailed({ cause, reason: "request" })),
      );
      return Option.some(account.login);
    }),
  });
});

const GitHubAccountsLive = Layer.effect(GitHubAccounts, makeGitHubAccounts()).pipe(
  Layer.provide(FetchHttpClient.layer),
);

export {
  GitHubAccounts,
  GitHubAccountsLive,
  GitHubLookupFailed,
  makeGitHubAccounts,
  makeGitHubProvider,
};

export type { GitHubAccountsShape };
