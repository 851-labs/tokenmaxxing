import { DeviceNotFound, type CliTokenSummary } from "@tokenmaxxing/api-contract";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeTokensService, TokensRepository, type TokensRepositoryShape } from "./service";

type Token = typeof CliTokenSummary.Type;

function repositoryWithDeleteResult(result: boolean) {
  const deleteDevice = vi.fn(() => Effect.succeed(result));

  const repository: TokensRepositoryShape = {
    deleteDevice,
    findIdentityByHash: () => Effect.succeed(Option.none()),
    listDevices: () => Effect.succeed([]),
    listTokens: () => Effect.succeed([]),
    revokeToken: () => Effect.succeed(false),
  };

  return { deleteDevice, repository };
}

function tokenSummary(id: string, revokedAt: string | null): Token {
  return {
    createdAt: "2026-06-20T00:00:00.000Z",
    deviceId: null,
    id,
    lastUsedAt: null,
    name: id,
    revokedAt,
  };
}

async function makeService(repository: TokensRepositoryShape) {
  return Effect.runPromise(
    makeTokensService().pipe(Effect.provideService(TokensRepository, repository)),
  );
}

describe("TokensService.deleteDevice", () => {
  it("deletes an owned device through the repository", async () => {
    const { deleteDevice, repository } = repositoryWithDeleteResult(true);
    const service = await makeService(repository);

    await Effect.runPromise(service.deleteDevice("user_123", "device_123"));

    expect(deleteDevice).toHaveBeenCalledWith("user_123", "device_123", expect.any(Date));
  });

  it("fails with DeviceNotFound when no owned device was deleted", async () => {
    const { repository } = repositoryWithDeleteResult(false);
    const service = await makeService(repository);

    await expect(
      Effect.runPromise(service.deleteDevice("user_123", "device_missing")),
    ).rejects.toBeInstanceOf(DeviceNotFound);
  });
});

describe("TokensService.listTokens", () => {
  it("returns only active tokens", async () => {
    const active = tokenSummary("token_active", null);
    const revoked = tokenSummary("token_revoked", "2026-06-20T01:00:00.000Z");
    const listTokens = vi.fn(() => Effect.succeed([active, revoked]));
    const repository: TokensRepositoryShape = {
      deleteDevice: () => Effect.succeed(false),
      findIdentityByHash: () => Effect.succeed(Option.none()),
      listDevices: () => Effect.succeed([]),
      listTokens,
      revokeToken: () => Effect.succeed(false),
    };
    const service = await makeService(repository);

    await expect(Effect.runPromise(service.listTokens("user_123"))).resolves.toEqual([active]);

    expect(listTokens).toHaveBeenCalledWith("user_123");
  });
});
