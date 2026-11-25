import { Effect, Exit, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";

import { AppConfig } from "../config";
import { makeGitHubAccounts } from "./github";

const config: AppConfig["Service"] = {
  adminEmails: [],
  apiWorkerName: "tokenmaxxing-api-test",
  github: { clientId: "github-id", clientSecret: "github-secret" },
  google: { clientId: "google-id", clientSecret: "google-secret" },
  productName: "Tokenmaxxing",
};

function makeAccounts(respond: () => Response) {
  const requests: { authorization: string | undefined; url: string }[] = [];
  const http = HttpClient.make((request) => {
    requests.push({ authorization: request.headers["authorization"], url: request.url });
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond()));
  });
  const accounts = Effect.runSync(
    makeGitHubAccounts().pipe(
      Effect.provideService(AppConfig, config),
      Effect.provideService(HttpClient.HttpClient, http),
    ),
  );

  return { accounts, requests };
}

describe("GitHubAccounts.currentLogin", () => {
  it("reads the login by account id, authenticated as the OAuth app", async () => {
    const { accounts, requests } = makeAccounts(() => Response.json({ id: 1, login: "Alex-Dev" }));

    const login = await Effect.runPromise(accounts.currentLogin("1"));

    expect(login).toEqual(Option.some("Alex-Dev"));
    expect(requests).toEqual([
      {
        authorization: `Basic ${btoa("github-id:github-secret")}`,
        url: "https://api.github.com/user/1",
      },
    ]);
  });

  it("answers none for a deleted account or a non-numeric id", async () => {
    const { accounts, requests } = makeAccounts(() => new Response("{}", { status: 404 }));

    expect(await Effect.runPromise(accounts.currentLogin("1"))).toEqual(Option.none());
    expect(await Effect.runPromise(accounts.currentLogin("../orgs/x"))).toEqual(Option.none());
    expect(requests).toHaveLength(1);
  });

  it("tells a rate limit apart from other failures", async () => {
    const limited = makeAccounts(
      () => new Response("{}", { headers: { "x-ratelimit-remaining": "0" }, status: 403 }),
    );
    const broken = makeAccounts(() => new Response("{}", { status: 502 }));

    const limitedExit = await Effect.runPromiseExit(limited.accounts.currentLogin("1"));
    const brokenExit = await Effect.runPromiseExit(broken.accounts.currentLogin("1"));

    expect(Exit.isFailure(limitedExit) && limitedExit.cause.reasons[0]).toMatchObject({
      error: { _tag: "GitHubLookupFailed", reason: "rate-limited", status: 403 },
    });
    expect(Exit.isFailure(brokenExit) && brokenExit.cause.reasons[0]).toMatchObject({
      error: { _tag: "GitHubLookupFailed", reason: "status", status: 502 },
    });
  });
});
