import { Context, Effect } from "effect";

import {
  AdminUserNotFound,
  Forbidden,
  type AdminUsersResponse,
  type ShadowBan,
} from "@tokenmaxxing/api-contract";

import { AppConfig } from "../config";
import type { DatabaseError } from "../database";
import { adminUsersReport, type AdminUserSnapshot } from "./fleet";
import { NpmRegistry } from "./npm-registry";

interface AdminServiceShape {
  listUsers(userId: string): Effect.Effect<typeof AdminUsersResponse.Type, Forbidden>;
  shadowBanUser(
    adminUserId: string,
    targetUserId: string,
  ): Effect.Effect<{ shadowBan: ShadowBan; userId: string }, AdminUserNotFound | Forbidden>;
  shadowUnbanUser(
    adminUserId: string,
    targetUserId: string,
  ): Effect.Effect<{ shadowBan: null; userId: string }, AdminUserNotFound | Forbidden>;
}

interface AdminRepositoryShape {
  hasAnyVerifiedEmail(
    userId: string,
    emails: readonly string[],
  ): Effect.Effect<boolean, DatabaseError>;
  listUserSnapshots(): Effect.Effect<AdminUserSnapshot[], DatabaseError>;
  setShadowBan(input: {
    at: Date | null;
    byUserId: string | null;
    userId: string;
  }): Effect.Effect<boolean, DatabaseError>;
}

class AdminService extends Context.Service<AdminService, AdminServiceShape>()(
  "@tokenmaxxing/api/AdminService",
) {}

class AdminRepository extends Context.Service<AdminRepository, AdminRepositoryShape>()(
  "@tokenmaxxing/api/AdminRepository",
) {}

const makeAdminService = Effect.fn("makeAdminService")(function* (
  options: { now?: (() => Date) | undefined } = {},
) {
  const repository = yield* AdminRepository;
  const npmRegistry = yield* NpmRegistry;
  const { adminEmails } = yield* AppConfig;
  const now = options.now ?? (() => new Date());

  const requireInternalAdmin = Effect.fn("AdminService.requireInternalAdmin")(function* (
    userId: string,
  ) {
    const allowed = yield* repository.hasAnyVerifiedEmail(userId, adminEmails).pipe(Effect.orDie);
    if (!allowed) {
      return yield* Effect.fail(new Forbidden({ message: "Not found." }));
    }
  });

  const setShadowBan = Effect.fn("AdminService.setShadowBan")(function* (input: {
    at: Date | null;
    byUserId: string | null;
    userId: string;
  }) {
    const updated = yield* repository.setShadowBan(input).pipe(Effect.orDie);
    if (!updated) {
      return yield* Effect.fail(new AdminUserNotFound({ id: input.userId }));
    }
  });

  return AdminService.of({
    listUsers: Effect.fn("AdminService.listUsers")(function* (userId) {
      yield* requireInternalAdmin(userId);

      const generatedAt = now();
      const [latestCliRelease, snapshots] = yield* Effect.all([
        npmRegistry.latestCliRelease,
        repository.listUserSnapshots().pipe(Effect.orDie),
      ]);

      return {
        ...adminUsersReport(snapshots, latestCliRelease, generatedAt),
        generatedAt: generatedAt.toISOString(),
        latestCliPublishedAt: latestCliRelease.publishedAt,
        latestCliVersion: latestCliRelease.version,
        latestCliVersions: latestCliRelease.versions,
      };
    }),
    shadowBanUser: Effect.fn("AdminService.shadowBanUser")(function* (adminUserId, targetUserId) {
      yield* requireInternalAdmin(adminUserId);

      const at = now();
      yield* setShadowBan({ at, byUserId: adminUserId, userId: targetUserId });

      return {
        shadowBan: { at: at.toISOString(), byUserId: adminUserId },
        userId: targetUserId,
      };
    }),
    shadowUnbanUser: Effect.fn("AdminService.shadowUnbanUser")(
      function* (adminUserId, targetUserId) {
        yield* requireInternalAdmin(adminUserId);
        yield* setShadowBan({ at: null, byUserId: null, userId: targetUserId });

        return { shadowBan: null, userId: targetUserId };
      },
    ),
  });
});

export { AdminRepository, AdminService, makeAdminService };

export type { AdminRepositoryShape };
