import { describe, expect, it, vi } from "vitest";

import { makeProfileBadgeResolver, type FetchRequest } from "./badges";

describe("profile badge resolver", () => {
  it("combines owner, contributor, star, and configured Discord badges", async () => {
    const fetchRequest = vi.fn<FetchRequest>(async () => {
      const payload = [{ login: "pondorasti" }, { login: "Alice" }];
      return Response.json(payload);
    });
    const resolve = resolver(fetchRequest, ["ALICE"]);

    await expect(resolve(identity("pondorasti"))).resolves.toEqual(["owner", "contributor"]);
    await expect(resolve(identity("Alice", true))).resolves.toEqual([
      "contributor",
      "starred",
      "discord",
    ]);
    await expect(resolve(identity("nobody"))).resolves.toEqual([]);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("requires a linked GitHub login", async () => {
    const fetchRequest = vi.fn<FetchRequest>();
    const resolve = resolver(fetchRequest, ["pondorasti"]);

    await expect(resolve(null)).resolves.toEqual([]);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("keeps deterministic badges when GitHub is unavailable", async () => {
    const fetchRequest = vi.fn<FetchRequest>(async () => new Response(null, { status: 503 }));
    const resolve = resolver(fetchRequest, ["pondorasti"]);

    await expect(resolve(identity("Pondorasti", true))).resolves.toEqual([
      "owner",
      "starred",
      "discord",
    ]);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("follows GitHub pagination and caches the resulting snapshot", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ login: `user-${index}` }));
    const fetchRequest = vi.fn<FetchRequest>(async (input) => {
      const url = input instanceof URL ? input : new URL(input);
      const page = url.searchParams.get("page");
      if (url.pathname.endsWith("/contributors")) {
        return Response.json(page === "1" ? firstPage : [{ login: "late-user" }]);
      }
      return Response.json([]);
    });
    const resolve = resolver(fetchRequest);

    await expect(resolve(identity("late-user"))).resolves.toEqual(["contributor"]);
    await expect(resolve(identity("late-user"))).resolves.toEqual(["contributor"]);
    expect(fetchRequest).toHaveBeenCalledTimes(2);
  });
});

function resolver(fetchRequest: FetchRequest, discordGithubLogins: readonly string[] = []) {
  return makeProfileBadgeResolver({
    discordGithubLogins,
    fetch: fetchRequest,
    githubClientId: "client-id",
    githubClientSecret: "client-secret",
  });
}

function identity(login: string, starredTokenmaxxing = false) {
  return { login, starredTokenmaxxing };
}
