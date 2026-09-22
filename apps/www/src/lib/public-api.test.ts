import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProfileResponse } from "@tokenmaxxing/api-contract";

import { fetchPublicProfile, PublicApiError } from "./public-api";

describe("fetchPublicProfile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves null for an unknown profile", async () => {
    stubFetch(new Response("missing", { status: 404 }));

    await expect(fetchPublicProfile("ghost", "", ProfileResponse)).resolves.toBeNull();
  });

  it("rejects a payload that does not match the contract", async () => {
    stubFetch(Response.json({ user: { login: "pondorasti" } }));

    await expect(fetchPublicProfile("pondorasti", "", ProfileResponse)).rejects.toThrow();
  });

  it("raises a typed error for other failures", async () => {
    stubFetch(new Response("boom", { status: 503 }));

    await expect(fetchPublicProfile("pondorasti", "/identity", ProfileResponse)).rejects.toSatisfy(
      (error) => error instanceof PublicApiError && error.status === 503,
    );
  });

  it("encodes the login into the profile path", async () => {
    const fetch = stubFetch(new Response("missing", { status: 404 }));

    await fetchPublicProfile("a b", "/identity", ProfileResponse);

    expect(fetch.mock.calls[0]?.[0]).toMatch(/\/profiles\/a%20b\/identity$/);
  });
});

function stubFetch(response: Response) {
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
