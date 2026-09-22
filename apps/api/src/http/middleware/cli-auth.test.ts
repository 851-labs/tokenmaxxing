import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CurrentUser } from "../../auth/service";
import { makeTestApp, type TestApp } from "../../testing/http";

const user: CurrentUser = { avatarUrl: null, id: "user", login: "user", name: null };

describe("CliAuth middleware", () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function logout(
    headers: Record<string, string>,
    resolved: Effect.Effect<
      Option.Option<{ deviceId: string | null; tokenId: string; user: CurrentUser }>
    > = Effect.succeed(Option.some({ deviceId: "device", tokenId: "token", user })),
  ) {
    const resolveCliToken = vi.fn(() => resolved);
    const revokeToken = vi.fn(() => Effect.void);
    app = await makeTestApp({ tokens: { resolveCliToken, revokeToken } });
    const response = await app.fetch(
      new Request("https://api.tokenmaxxing.sh/cli/logout", { headers, method: "POST" }),
    );

    return { body: await response.json(), resolveCliToken, revokeToken, status: response.status };
  }

  it("provides the resolved CLI identity to the handler", async () => {
    const { body, resolveCliToken, revokeToken, status } = await logout({
      authorization: "Bearer tmx_token",
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(resolveCliToken).toHaveBeenCalledWith("tmx_token");
    expect(revokeToken).toHaveBeenCalledWith("user", "token");
  });

  it("requires a bearer token", async () => {
    const missing = await logout({});
    const basic = await logout({ authorization: "Basic dXNlcjpwYXNz" });

    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({
      _tag: "Unauthorized",
      message: "Run `tokenmaxxing login` first.",
    });
    expect(basic.status).toBe(401);
    expect(missing.resolveCliToken).not.toHaveBeenCalled();
    expect(basic.resolveCliToken).not.toHaveBeenCalled();
  });

  it("ignores the browser session cookie", async () => {
    const { resolveCliToken, status } = await logout({ cookie: "tmx_session=tmx_token" });

    expect(status).toBe(401);
    expect(resolveCliToken).not.toHaveBeenCalled();
  });

  it("rejects unknown tokens and failing lookups", async () => {
    const unknown = await logout(
      { authorization: "Bearer tmx_unknown" },
      Effect.succeed(Option.none()),
    );
    const failing = await logout(
      { authorization: "Bearer tmx_token" },
      Effect.die(new Error("D1 down")),
    );

    expect(unknown.status).toBe(401);
    expect(failing.status).toBe(401);
    expect(unknown.revokeToken).not.toHaveBeenCalled();
  });
});
