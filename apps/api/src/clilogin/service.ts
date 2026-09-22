import { Context } from "effect";
import { Data } from "effect";
import { Effect } from "effect";
import { Option } from "effect";

import {
  CliUpgradeRequired,
  LoginCodeExpired,
  LoginCodeNotFound,
  type CliLoginPollInput,
  type CliLoginRequestSummary,
} from "@tokenmaxxing/api-contract";
import type { CliLoginRequest } from "@tokenmaxxing/db";

import type { DatabaseError } from "../database";
import {
  deriveDeviceId,
  generateCliToken,
  generateDeviceCode,
  generateLoginCode,
  hashCliToken,
  hashDeviceCode,
  normalizeLoginCode,
} from "../auth/crypto";
import type { AuthUser as CurrentUser } from "@tokenmaxxing/api-contract";

/**
 * The device-code login flow (RFC 8628 shaped):
 *
 * - start: the CLI gets a secret `deviceCode` (only its hash is stored) and
 *   a short `userCode` it sends the user to the browser with.
 * - approve: a signed-in user explicitly approves the userCode. One
 *   conditional UPDATE flips `pending → approved`; nothing is minted yet.
 * - poll: the CLI presents its deviceCode. One conditional DELETE claims
 *   the approved row, and only the poller that got the row back mints the
 *   never-expiring CLI token — delivered exactly once, never stored raw.
 *
 * Legacy: pre-device-code CLIs start without `flow` and poll by userCode.
 * Those requests have no deviceCodeHash and are the only ones pollable by
 * userCode; after LEGACY_LOGIN_SUNSET such starts are refused outright.
 */

const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 2;
const LEGACY_LOGIN_SUNSET = new Date("2027-11-01T00:00:00.000Z");

interface StartInput {
  deviceArch?: string | undefined;
  deviceId: string;
  deviceName: string;
  devicePlatform: string;
  deviceVersion?: string | undefined;
  flow?: "device_code" | undefined;
}

interface StartResult {
  code: string;
  deviceCode?: string;
  expiresAt: string;
  intervalSeconds: number;
  userCode: string;
  verificationUri: string;
}

type PollResult = { status: "pending" } | { status: "complete"; token: string; user: CurrentUser };

type LoginCodeError = LoginCodeExpired | LoginCodeNotFound;

interface CliLoginServiceShape {
  /** wwwOrigin derives from the request host (see cookieScopeFor) so dev
   * and prod mint the right verification URL from one deploy. */
  start(input: StartInput, wwwOrigin: string): Effect.Effect<StartResult, CliUpgradeRequired, any>;
  poll(input: CliLoginPollInput): Effect.Effect<PollResult, LoginCodeError, any>;
  describe(code: string): Effect.Effect<CliLoginRequestSummary, LoginCodeError, any>;
  approve(
    user: CurrentUser,
    code: string,
  ): Effect.Effect<{ deviceName: string }, LoginCodeError, any>;
}

interface CliLoginRepositoryShape {
  insertRequest(input: {
    code: string;
    createdAt: Date;
    deviceArch?: string | undefined;
    deviceCodeHash: string | null;
    deviceId: string;
    deviceName: string;
    devicePlatform: string;
    deviceVersion?: string | undefined;
    expiresAt: Date;
    id: string;
  }): Effect.Effect<void, DatabaseError, any>;
  findRequestByCode(
    code: string,
  ): Effect.Effect<Option.Option<CliLoginRequest>, DatabaseError, any>;
  findRequestByDeviceCodeHash(
    deviceCodeHash: string,
  ): Effect.Effect<Option.Option<CliLoginRequest>, DatabaseError, any>;
  /** `UPDATE … SET status='approved' WHERE id=? AND status='pending' AND
   * expires_at > now RETURNING` — some() only for the approve that won. */
  approveRequest(input: {
    now: Date;
    requestId: string;
    userId: string;
  }): Effect.Effect<Option.Option<CliLoginRequest>, DatabaseError, any>;
  /** `DELETE … WHERE id=? AND status='approved' AND expires_at > now
   * RETURNING` — some() only for the poll that won. */
  claimApprovedRequest(input: {
    now: Date;
    requestId: string;
  }): Effect.Effect<Option.Option<CliLoginRequest>, DatabaseError, any>;
  deleteRequest(id: string): Effect.Effect<void, DatabaseError, any>;
  findDeviceOwner(deviceId: string): Effect.Effect<Option.Option<string>, DatabaseError, any>;
  findRequestUser(userId: string): Effect.Effect<Option.Option<CurrentUser>, DatabaseError, any>;
  /**
   * One batch: upsert the device for the user (never reassigning a device
   * another user owns) and insert the hashed CLI token only if the device
   * is the user's. Returns false when the ownership guard blocked it.
   */
  issueCliToken(input: {
    deviceArch: string | null;
    deviceId: string;
    deviceName: string;
    devicePlatform: string;
    deviceVersion: string | null;
    now: Date;
    tokenHash: string;
    tokenId: string;
    userId: string;
  }): Effect.Effect<boolean, DatabaseError, any>;
}

/** Defect: the resolved device was claimed by another user mid-poll. */
class DeviceOwnershipConflict extends Data.TaggedError("DeviceOwnershipConflict")<{
  readonly deviceId: string;
}> {}

class CliLoginService extends Context.Service<CliLoginService, CliLoginServiceShape>()(
  "@tokenmaxxing/api/CliLoginService",
) {}

class CliLoginRepository extends Context.Service<CliLoginRepository, CliLoginRepositoryShape>()(
  "@tokenmaxxing/api/CliLoginRepository",
) {}

const makeCliLoginService = Effect.fn("makeCliLoginService")(function* () {
  const repository = yield* CliLoginRepository;

  const rejectExpired = Effect.fn("CliLoginService.rejectExpired")(function* (
    request: CliLoginRequest,
  ) {
    if (request.expiresAt.getTime() > Date.now()) {
      return request;
    }
    yield* repository.deleteRequest(request.id).pipe(Effect.orDie);
    return yield* Effect.fail(new LoginCodeExpired({ code: request.code }));
  });

  const loadByUserCode = Effect.fn("CliLoginService.loadByUserCode")(function* (rawCode: string) {
    const code = normalizeLoginCode(rawCode);
    const request = yield* repository.findRequestByCode(code).pipe(Effect.orDie);
    if (Option.isNone(request)) {
      return yield* Effect.fail(new LoginCodeNotFound({ code }));
    }

    return yield* rejectExpired(request.value);
  });

  /** Poll lookup: by deviceCode hash, or by userCode for legacy rows only. */
  const loadForPoll = Effect.fn("CliLoginService.loadForPoll")(function* (
    input: CliLoginPollInput,
  ) {
    if ("deviceCode" in input) {
      const deviceCodeHash = yield* hashDeviceCode(input.deviceCode);
      const request = yield* repository
        .findRequestByDeviceCodeHash(deviceCodeHash)
        .pipe(Effect.orDie);
      if (Option.isNone(request)) {
        return yield* Effect.fail(new LoginCodeNotFound({ code: "" }));
      }

      return yield* rejectExpired(request.value);
    }

    const code = normalizeLoginCode(input.code);
    const request = yield* repository.findRequestByCode(code).pipe(Effect.orDie);
    // A request started with a deviceCode must never be collectable by
    // whoever saw its userCode (URL, screen, browser history).
    if (
      Option.isNone(request) ||
      request.value.deviceCodeHash !== null ||
      Date.now() >= LEGACY_LOGIN_SUNSET.getTime()
    ) {
      return yield* Effect.fail(new LoginCodeNotFound({ code }));
    }

    return yield* rejectExpired(request.value);
  });

  /**
   * The device this login writes to. A client-supplied id owned by another
   * account is never reassigned (that would hand over its history); the
   * login gets a per-user derived id instead.
   */
  const resolveDeviceId = Effect.fn("CliLoginService.resolveDeviceId")(function* (
    clientDeviceId: string,
    userId: string,
  ) {
    const isAvailable = (deviceId: string) =>
      repository.findDeviceOwner(deviceId).pipe(
        Effect.orDie,
        Effect.map((owner) => Option.isNone(owner) || owner.value === userId),
      );

    if (yield* isAvailable(clientDeviceId)) {
      return clientDeviceId;
    }
    const derived = yield* deriveDeviceId(clientDeviceId, userId);
    if (yield* isAvailable(derived)) {
      return derived;
    }

    return crypto.randomUUID();
  });

  return CliLoginService.of({
    start: Effect.fn("CliLoginService.start")(function* (input, wwwOrigin) {
      const legacy = input.flow !== "device_code";
      if (legacy && Date.now() >= LEGACY_LOGIN_SUNSET.getTime()) {
        return yield* Effect.fail(
          new CliUpgradeRequired({
            message: "This tokenmaxxing CLI is too old to log in. Upgrade it and try again.",
          }),
        );
      }

      const code = generateLoginCode();
      const deviceCode = legacy ? undefined : generateDeviceCode();
      const deviceCodeHash = deviceCode === undefined ? null : yield* hashDeviceCode(deviceCode);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + LOGIN_REQUEST_TTL_MS);
      yield* repository
        .insertRequest({
          code,
          createdAt,
          deviceArch: input.deviceArch,
          deviceCodeHash,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          devicePlatform: input.devicePlatform,
          deviceVersion: input.deviceVersion,
          expiresAt,
          id: crypto.randomUUID(),
        })
        .pipe(Effect.orDie);

      return {
        code,
        ...(deviceCode === undefined ? {} : { deviceCode }),
        expiresAt: expiresAt.toISOString(),
        intervalSeconds: POLL_INTERVAL_SECONDS,
        userCode: code,
        verificationUri: cliLoginVerificationUri(wwwOrigin, code),
      };
    }),
    poll: Effect.fn("CliLoginService.poll")(function* (input) {
      const request = yield* loadForPoll(input);
      if (request.status !== "approved") {
        return { status: "pending" } as const;
      }

      const claimed = yield* repository
        .claimApprovedRequest({ now: new Date(), requestId: request.id })
        .pipe(Effect.orDie);
      // Lost the race to a concurrent poll (or the row expired meanwhile):
      // the token belongs to whoever claimed it.
      if (Option.isNone(claimed) || claimed.value.userId === null) {
        return yield* Effect.fail(new LoginCodeNotFound({ code: request.code }));
      }

      const approved = claimed.value;
      const userId = claimed.value.userId;
      const user = yield* repository.findRequestUser(userId).pipe(Effect.orDie);
      if (Option.isNone(user)) {
        return yield* Effect.fail(new LoginCodeNotFound({ code: approved.code }));
      }

      const deviceId = yield* resolveDeviceId(approved.deviceId, userId);
      const token = generateCliToken();
      const issued = yield* repository
        .issueCliToken({
          deviceArch: approved.deviceArch,
          deviceId,
          deviceName: approved.deviceName,
          devicePlatform: approved.devicePlatform,
          deviceVersion: approved.deviceVersion,
          now: new Date(),
          tokenHash: yield* hashCliToken(token),
          tokenId: crypto.randomUUID(),
          userId,
        })
        .pipe(Effect.orDie);
      if (!issued) {
        return yield* Effect.die(new DeviceOwnershipConflict({ deviceId }));
      }

      return { status: "complete", token, user: user.value } as const;
    }),
    describe: Effect.fn("CliLoginService.describe")(function* (rawCode) {
      const request = yield* loadByUserCode(rawCode);

      return {
        code: request.code,
        createdAt: request.createdAt.toISOString(),
        deviceArch: request.deviceArch,
        deviceName: request.deviceName,
        devicePlatform: request.devicePlatform,
        deviceVersion: request.deviceVersion,
        expiresAt: request.expiresAt.toISOString(),
        legacyClient: request.deviceCodeHash === null,
        status: request.status,
      };
    }),
    approve: Effect.fn("CliLoginService.approve")(function* (user, rawCode) {
      const request = yield* loadByUserCode(rawCode);
      const approved = yield* repository
        .approveRequest({ now: new Date(), requestId: request.id, userId: user.id })
        .pipe(Effect.orDie);
      if (Option.isSome(approved)) {
        return { deviceName: approved.value.deviceName };
      }

      // Lost the conditional update. A repeat approve by the same user
      // (double click, refreshed tab) is fine — nothing is minted twice.
      const current = yield* repository.findRequestByCode(request.code).pipe(Effect.orDie);
      if (
        Option.isSome(current) &&
        current.value.status === "approved" &&
        current.value.userId === user.id
      ) {
        return { deviceName: current.value.deviceName };
      }

      return yield* Effect.fail(new LoginCodeNotFound({ code: request.code }));
    }),
  });
});

function cliLoginVerificationUri(wwwOrigin: string, code: string): string {
  return `${wwwOrigin}/login/cli?code=${encodeURIComponent(code)}`;
}

export {
  CliLoginRepository,
  CliLoginService,
  cliLoginVerificationUri,
  LEGACY_LOGIN_SUNSET,
  LOGIN_REQUEST_TTL_MS,
  makeCliLoginService,
};

export type { CliLoginRepositoryShape };
