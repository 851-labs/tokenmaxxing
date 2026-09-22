import { Context, Data, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { AppConfig, type AppConfigShape } from "../config";
import type { OAuthProfile } from "../auth/service";

/**
 * Every call this worker makes to GitHub: the OAuth code exchange and the
 * user profile read. Identity only — no repo access, no GitHub App.
 */

class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly cause: unknown;
}> {}

interface GitHubClientShape {
  /** OAuth authorization-code exchange (PKCE); returns the user access token. */
  exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Effect.Effect<string, GitHubApiError>;
  fetchUser(accessToken: string): Effect.Effect<OAuthProfile, GitHubApiError>;
}

class GitHubClient extends Context.Service<GitHubClient, GitHubClientShape>()(
  "@tokenmaxxing/api/GitHubClient",
) {}

const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  // GitHub rejects requests without a User-Agent.
  "user-agent": "tokenmaxxing",
});

const makeGitHubClient = Effect.fn("makeGitHubClient")(function* () {
  const config = yield* AppConfig;
  const http = yield* HttpClient.HttpClient;

  const requestJson = Effect.fn("GitHubClient.requestJson")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError((cause) => new GitHubApiError({ cause })));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new GitHubApiError({
          cause: new Error(`GitHub responded ${response.status} for ${request.url}`),
        }),
      );
    }

    return yield* response.json.pipe(Effect.mapError((cause) => new GitHubApiError({ cause })));
  });

  return GitHubClient.of({
    exchangeCode: Effect.fn("GitHubClient.exchangeCode")(
      function* (code, redirectUri, codeVerifier) {
        const payload = (yield* requestJson(
          HttpClientRequest.post("https://github.com/login/oauth/access_token", {
            headers: { accept: "application/json" },
          }).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              client_id: config.github.clientId,
              client_secret: config.github.clientSecret,
              code,
              code_verifier: codeVerifier,
              redirect_uri: redirectUri,
            }),
          ),
        )) as { access_token?: string; error?: string };
        if (typeof payload.access_token !== "string") {
          return yield* Effect.fail(
            new GitHubApiError({
              cause: new Error(`GitHub token exchange rejected: ${payload.error ?? "no token"}`),
            }),
          );
        }

        return payload.access_token;
      },
    ),
    fetchUser: Effect.fn("GitHubClient.fetchUser")(function* (accessToken) {
      const payload = (yield* requestJson(
        HttpClientRequest.get("https://api.github.com/user", {
          headers: githubHeaders(accessToken),
        }),
      )) as {
        avatar_url?: string;
        email?: string | null;
        id: number;
        login: string;
        name?: string | null;
      };
      const email = yield* fetchPrimaryVerifiedEmail(accessToken).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );

      return {
        avatarUrl: payload.avatar_url ?? null,
        email: email ?? payload.email ?? null,
        emailVerified: email !== null,
        login: payload.login,
        name: payload.name ?? null,
        provider: "github",
        providerAccountId: String(payload.id),
      };
    }),
  });

  function fetchPrimaryVerifiedEmail(accessToken: string) {
    return Effect.gen(function* () {
      const payload = (yield* requestJson(
        HttpClientRequest.get("https://api.github.com/user/emails", {
          headers: githubHeaders(accessToken),
        }),
      )) as { email?: string; primary?: boolean; verified?: boolean }[];

      return (
        payload.find((email) => email.primary === true && email.verified === true)?.email ?? null
      );
    });
  }
});

function buildAuthorizeUrl(
  config: AppConfigShape["github"],
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", redirectUri);
  // Identity only; the public profile is all the leaderboard needs.
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);

  return url.toString();
}

export { buildAuthorizeUrl, GitHubApiError, GitHubClient, makeGitHubClient };
