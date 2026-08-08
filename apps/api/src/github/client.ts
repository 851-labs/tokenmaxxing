import { Context, Data, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { AppConfig, type GitHubOAuthConfig } from "../config";
import type { OAuthProfile } from "../auth/service";

/**
 * Every call this worker makes to GitHub: OAuth exchange, identity reads, and
 * the authenticated user's public Tokenmaxxing star check. No repo write access.
 */

class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly cause: unknown;
}> {}

interface GitHubClientShape {
  /** OAuth authorization-code exchange; returns the user access token. */
  exchangeCode(code: string, redirectUri: string): Effect.Effect<string, GitHubApiError>;
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

  const checkTokenmaxxingStar = Effect.fn("GitHubClient.checkTokenmaxxingStar")(function* (
    accessToken: string,
  ) {
    const request = HttpClientRequest.get(
      "https://api.github.com/user/starred/851-labs/tokenmaxxing",
      {
        headers: githubHeaders(accessToken),
      },
    );
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError((cause) => new GitHubApiError({ cause })));
    if (response.status === 204) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }

    return yield* Effect.fail(
      new GitHubApiError({
        cause: new Error(`GitHub responded ${response.status} for ${request.url}`),
      }),
    );
  });

  return GitHubClient.of({
    exchangeCode: Effect.fn("GitHubClient.exchangeCode")(function* (code, redirectUri) {
      const payload = (yield* requestJson(
        HttpClientRequest.post("https://github.com/login/oauth/access_token", {
          headers: { accept: "application/json" },
        }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_id: config.github.clientId,
            client_secret: config.github.clientSecret,
            code,
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
    }),
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
      const starredTokenmaxxing = yield* checkTokenmaxxingStar(accessToken).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      );

      return {
        avatarUrl: payload.avatar_url ?? null,
        email: email ?? payload.email ?? null,
        emailVerified: email !== null,
        login: payload.login,
        name: payload.name ?? null,
        provider: "github",
        providerAccountId: String(payload.id),
        ...(starredTokenmaxxing === undefined ? {} : { starredTokenmaxxing }),
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

function buildAuthorizeUrl(config: GitHubOAuthConfig, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  // Identity only; the public profile is all the leaderboard needs.
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);

  return url.toString();
}

export { buildAuthorizeUrl, GitHubClient, makeGitHubClient };
