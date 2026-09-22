import { Effect } from "effect";
import { Layer } from "effect";
import { Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  Authorization,
  CurrentUser,
  TokenmaxxingApi,
  type Unauthorized,
} from "@tokenmaxxing/api-contract";
import type { AuthUser } from "@tokenmaxxing/api-contract";

import { AuthService, type AuthServiceShape } from "../../auth/service";
import { makeTestApp, type TestApp } from "../../testing/http";
import { TokensService, type TokensServiceShape } from "../../tokens/service";
import { AuthorizationLive } from "./authorization";

const CLI_TOKEN = "tmx_cli-token";
const SESSION_TOKEN = "browser-session-token";
const USER: AuthUser = { avatarUrl: null, id: "user_1", login: "alex", name: null };

describe("Authorization middleware", () => {
  it("accepts a session token on every session-guarded endpoint", async () => {
    await expect(authorize("me", "approveCliLogin", SESSION_TOKEN)).resolves.toBe("alex");
    await expect(authorize("me", "deleteDevice", SESSION_TOKEN)).resolves.toBe("alex");
    await expect(authorize("admin", "listUsers", SESSION_TOKEN)).resolves.toBe("alex");
  });

  it("lets a CLI token call whoami as its account", async () => {
    await expect(authorize("me", "me", CLI_TOKEN)).resolves.toBe("alex");
  });

  it("rejects CLI tokens on endpoints that did not opt in", async () => {
    for (const [group, endpoint] of [
      ["me", "approveCliLogin"],
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

describe("Authorization middleware through the HTTP stack", () => {
  const cliUser: AuthUser = { avatarUrl: null, id: "cli-user", login: "cli", name: null };
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function request(
    path: string,
    headers: Record<string, string>,
    options: {
      method?: string;
      resolveSession?: AuthServiceShape["resolveSession"];
    } = {},
  ) {
    const resolveSession = vi.fn(
      options.resolveSession ??
        ((token: string) =>
          Effect.succeed(token === SESSION_TOKEN ? Option.some(USER) : Option.none())),
    );
    const resolveCliToken = vi.fn((token: string) =>
      Effect.succeed(
        token === CLI_TOKEN
          ? Option.some({ deviceId: "device", tokenId: "token", user: cliUser })
          : Option.none(),
      ),
    );
    app = await makeTestApp({
      auth: { resolveSession },
      tokens: { resolveCliToken },
    });
    const response = await app.fetch(
      new Request(`https://api.tokenmaxxing.sh${path}`, {
        headers,
        method: options.method ?? "GET",
      }),
    );

    return {
      body: await response.json(),
      resolveCliToken,
      resolveSession,
      status: response.status,
    };
  }

  it("answers 401 with the contract error when signed out", async () => {
    const { body, resolveCliToken, resolveSession, status } = await request("/me", {});

    expect(status).toBe(401);
    expect(body).toMatchObject({ _tag: "Unauthorized", message: "Sign in required." });
    expect(resolveSession).not.toHaveBeenCalled();
    expect(resolveCliToken).not.toHaveBeenCalled();
  });

  it("resolves the session cookie", async () => {
    const { body, resolveSession, status } = await request("/me", {
      cookie: `tmx_session=${SESSION_TOKEN}`,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ user: USER });
    expect(resolveSession).toHaveBeenCalledWith(SESSION_TOKEN);
  });

  it("prefers a bearer session token over the cookie", async () => {
    const { resolveSession, status } = await request("/me", {
      authorization: `Bearer ${SESSION_TOKEN}`,
      cookie: "tmx_session=stale-session",
    });

    expect(status).toBe(200);
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(resolveSession).toHaveBeenCalledWith(SESSION_TOKEN);
  });

  it("lets a CLI token call whoami without touching sessions", async () => {
    const { body, resolveCliToken, resolveSession, status } = await request("/me", {
      authorization: `Bearer ${CLI_TOKEN}`,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ user: cliUser });
    expect(resolveCliToken).toHaveBeenCalledWith(CLI_TOKEN);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("rejects a CLI token on device management before looking it up", async () => {
    const { resolveCliToken, status } = await request(
      "/me/devices/device/delete",
      { authorization: `Bearer ${CLI_TOKEN}` },
      { method: "POST" },
    );

    expect(status).toBe(401);
    expect(resolveCliToken).not.toHaveBeenCalled();
  });

  it("rejects unknown sessions and revoked CLI tokens", async () => {
    const unknownSession = await request("/me", { cookie: "tmx_session=unknown" });
    const revokedToken = await request("/me", { authorization: "Bearer tmx_revoked" });

    expect(unknownSession.status).toBe(401);
    expect(revokedToken.status).toBe(401);
  });

  it("treats a failing session lookup as signed out, not a 500", async () => {
    const { status } = await request(
      "/me",
      { cookie: `tmx_session=${SESSION_TOKEN}` },
      { resolveSession: () => Effect.die(new Error("D1 down")) },
    );

    expect(status).toBe(401);
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
