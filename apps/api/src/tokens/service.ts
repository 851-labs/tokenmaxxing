import { Context } from "effect";
import { Effect } from "effect";
import { Option } from "effect";

import { DeviceNotFound, TokenNotFound } from "@tokenmaxxing/api-contract";
import type { CliIdentity, CliTokenSummary, DeviceSummary } from "@tokenmaxxing/api-contract";

import { CLI_TOKEN_PREFIX, hashCliToken } from "../auth/crypto";
import type { DatabaseError } from "../database";

/**
 * CLI token resolution and the settings surface (devices + tokens). Tokens
 * never expire — `revokedAt` is the only kill switch, so resolution checks
 * revocation and freshness only via `lastUsedAt` bookkeeping.
 */

interface TokensServiceShape {
  /** Resolves a raw `tmx_` bearer; touches lastUsedAt on success. */
  resolveCliToken(
    rawToken: string,
  ): Effect.Effect<Option.Option<typeof CliIdentity.Type>, never, any>;
  listDevices(userId: string): Effect.Effect<(typeof DeviceSummary.Type)[], never, any>;
  listTokens(userId: string): Effect.Effect<(typeof CliTokenSummary.Type)[], never, any>;
  deleteDevice(userId: string, deviceId: string): Effect.Effect<void, DeviceNotFound, any>;
  revokeToken(userId: string, tokenId: string): Effect.Effect<void, TokenNotFound, any>;
}

interface TokensRepositoryShape {
  findIdentityByHash(
    tokenHash: string,
    now: Date,
  ): Effect.Effect<Option.Option<typeof CliIdentity.Type>, DatabaseError, any>;
  listDevices(userId: string): Effect.Effect<(typeof DeviceSummary.Type)[], DatabaseError, any>;
  listTokens(userId: string): Effect.Effect<(typeof CliTokenSummary.Type)[], DatabaseError, any>;
  deleteDevice(
    userId: string,
    deviceId: string,
    now: Date,
  ): Effect.Effect<boolean, DatabaseError, any>;
  revokeToken(
    userId: string,
    tokenId: string,
    now: Date,
  ): Effect.Effect<boolean, DatabaseError, any>;
}

class TokensService extends Context.Service<TokensService, TokensServiceShape>()(
  "@tokenmaxxing/api/TokensService",
) {}

class TokensRepository extends Context.Service<TokensRepository, TokensRepositoryShape>()(
  "@tokenmaxxing/api/TokensRepository",
) {}

const makeTokensService = Effect.fn("makeTokensService")(function* () {
  const repository = yield* TokensRepository;

  return TokensService.of({
    resolveCliToken: Effect.fn("TokensService.resolveCliToken")(function* (rawToken) {
      if (!rawToken.startsWith(CLI_TOKEN_PREFIX)) {
        return Option.none();
      }
      const tokenHash = yield* hashCliToken(rawToken);

      return yield* repository.findIdentityByHash(tokenHash, new Date()).pipe(Effect.orDie);
    }),
    listDevices: Effect.fn("TokensService.listDevices")(function* (userId) {
      return yield* repository.listDevices(userId).pipe(Effect.orDie);
    }),
    listTokens: Effect.fn("TokensService.listTokens")(function* (userId) {
      const tokens = yield* repository.listTokens(userId).pipe(Effect.orDie);

      return tokens.filter((token) => token.revokedAt === null);
    }),
    deleteDevice: Effect.fn("TokensService.deleteDevice")(function* (userId, deviceId) {
      const deleted = yield* repository
        .deleteDevice(userId, deviceId, new Date())
        .pipe(Effect.orDie);
      if (!deleted) {
        return yield* Effect.fail(new DeviceNotFound({ id: deviceId }));
      }
    }),
    revokeToken: Effect.fn("TokensService.revokeToken")(function* (userId, tokenId) {
      const revoked = yield* repository.revokeToken(userId, tokenId, new Date()).pipe(Effect.orDie);
      if (!revoked) {
        return yield* Effect.fail(new TokenNotFound({ id: tokenId }));
      }
    }),
  });
});

export { makeTokensService, TokensRepository, TokensService };

export type { TokensRepositoryShape, TokensServiceShape };
