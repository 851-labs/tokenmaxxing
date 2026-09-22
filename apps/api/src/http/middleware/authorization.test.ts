import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  Authorization,
  CurrentUser,
  TokenmaxxingApi,
  type Unauthorized,
} from "@tokenmaxxing/api-contract";

import {
  AuthService,
  type AuthServiceShape,
  type CurrentUser as AuthUser,
} from "../../auth/service";
import { TokensService, type TokensServiceShape } from "../../tokens/service";
import { AuthorizationLive } from "./authorization";

const CLI_TOKEN = "tmx_cli-token";
const SESSION_TOKEN = "browser-session-token";
const USER: AuthUser = { avatarUrl: null, id: "user_1", login: "alex", name: null };

describe("Authorization middleware", () => {
  it("accepts a session token on every session-guarded endpoint", async () => {
    await expect(authorize("me", "approveCliLogin", SESSION_TOKEN)).resolves.toBe("alex");
    await expect(authorize("me", "describeCliLogin", SESSION_TOKEN)).resolves.toBe("alex");
    await expect(authorize("me", "deleteDevice", SESSION_TOKEN)).resolves.toBe("alex");
    await expect(authorize("admin", "listUsers", SESSION_TOKEN)).resolves.toBe("alex");
  });

  it("lets a CLI token call whoami as its account", async () => {
    await expect(authorize("me", "me", CLI_TOKEN)).resolves.toBe("alex");
  });

  it("rejects CLI tokens on endpoints that did not opt in", async () => {
    for (const [group, endpoint] of [
      ["me", "approveCliLogin"],
      ["me", "describeCliLogin"],
      ["me", "deleteDevice"],
      ["me", "listTokens"],
      ["me", "revokeToken"],
      ["admin", "listUsers"],
      ["admin", "shadowBanUser"],
    ] as const) {
      await expect(authorize(group, endpoint, CLI_TOKEN)).resolves.toEqual({
        _tag: "Unauthorized",
      });
    }
  });

  it("rejects requests without a token", async () => {
    await expect(authorize("me", "me", null)).resolves.toEqual({ _tag: "Unauthorized" });
  });
});

async function authorize(
  groupName: "admin" | "me",
  endpointName: string,
  token: string | null,
): Promise<string | { _tag: "Unauthorized" }> {
  const group = TokenmaxxingApi.groups[groupName];
  const endpoint = group.endpoints[endpointName as keyof typeof group.endpoints];
  if (endpoint === undefined) {
    throw new Error(`unknown endpoint ${groupName}.${endpointName}`);
  }

  const request = HttpServerRequest.fromWeb(
    new Request("https://api.tokenmaxxing.sh/me", {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }),
  );
  const handler = Effect.gen(function* () {
    const user = yield* CurrentUser;
    return HttpServerResponse.text(user.login);
  });

  const program = Effect.gen(function* () {
    const middleware = yield* Authorization;
    const response = yield* middleware(handler, { endpoint, group } as never) as Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Unauthorized,
      HttpServerRequest.HttpServerRequest
    >;
    return response.body._tag === "Uint8Array" ? new TextDecoder().decode(response.body.body) : "";
  }).pipe(
    Effect.catchTag("Unauthorized", () => Effect.succeed({ _tag: "Unauthorized" as const })),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provide(AuthorizationLive.pipe(Layer.provide(fakeServices))),
  );

  return Effect.runPromise(program);
}

const fakeServices = Layer.mergeAll(
  Layer.succeed(
    AuthService,
    AuthService.of({
      resolveSession: (rawToken) =>
        Effect.succeed(rawToken === SESSION_TOKEN ? Option.some(USER) : Option.none()),
    } as Partial<AuthServiceShape> as AuthServiceShape),
  ),
  Layer.succeed(
    TokensService,
    TokensService.of({
      resolveCliToken: (rawToken) =>
        Effect.succeed(
          rawToken === CLI_TOKEN
            ? Option.some({ deviceId: null, tokenId: "token_1", user: USER })
            : Option.none(),
        ),
    } as Partial<TokensServiceShape> as TokensServiceShape),
  ),
);
