import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, it, vi } from "vitest";

import { AppConfig } from "../config";
import { makeGitHubClient } from "./client";

describe("GitHubClient", () => {
  it("persists the authenticated user's Tokenmaxxing star status", async () => {
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.endsWith("/user/emails")) {
        return Response.json([{ email: "pondorasti@example.com", primary: true, verified: true }]);
      }
      if (url.endsWith("/user/starred/851-labs/tokenmaxxing")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/user")) {
        return Response.json({ id: 1, login: "pondorasti", name: "Pondorasti" });
      }

      return new Response(null, { status: 404 });
    });
    const fetchImplementation = fetchRequest as unknown as typeof globalThis.fetch;
    const profile = await Effect.runPromise(
      makeGitHubClient().pipe(
        Effect.flatMap((client) => client.fetchUser("github-token")),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchImplementation),
        Effect.provideService(AppConfig, appConfig()),
      ),
    );

    expect(profile).toMatchObject({
      email: "pondorasti@example.com",
      login: "pondorasti",
      starredTokenmaxxing: true,
    });
    expect(fetchRequest.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
      "https://api.github.com/user/starred/851-labs/tokenmaxxing",
    ]);
  });

  it("records an unstarred repository without failing sign-in", async () => {
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.endsWith("/user/starred/851-labs/tokenmaxxing")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/user/emails")) {
        return Response.json([]);
      }
      return Response.json({ id: 2, login: "someone" });
    });
    const profile = await Effect.runPromise(
      makeGitHubClient().pipe(
        Effect.flatMap((client) => client.fetchUser("github-token")),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          fetchRequest as unknown as typeof globalThis.fetch,
        ),
        Effect.provideService(AppConfig, appConfig()),
      ),
    );

    expect(profile.starredTokenmaxxing).toBe(false);
  });
});

function appConfig() {
  return {
    apiWorkerName: "tokenmaxxing-api",
    corsOrigins: ["https://tokenmaxxing.sh"],
    discordGithubLogins: [],
    github: { clientId: "client-id", clientSecret: "client-secret" },
    google: { clientId: "google-id", clientSecret: "google-secret" },
    productName: "Tokenmaxxing",
    urls: {
      apiUrl: "https://api.tokenmaxxing.sh",
      sandbox: "production" as const,
      wwwUrl: "https://tokenmaxxing.sh",
    },
  };
}

function requestUrl(input: URL | RequestInfo): string {
  if (input instanceof URL || typeof input === "string") {
    return input.toString();
  }

  return input.url;
}
