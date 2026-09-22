import { users, type User } from "@tokenmaxxing/db";

import { UserId } from "@tokenmaxxing/api-contract";
import type { AuthUser, PublicUser } from "@tokenmaxxing/api-contract";

/**
 * The only user fields public endpoints may expose. Select through
 * `publicUserColumns` rather than whole `users` rows so moderation and audit
 * columns — and the internal user id — never leave the database on public
 * paths. `authUserColumns` adds the id for self/admin surfaces and for
 * server-side checks that must never reach the wire.
 */

const publicUserColumns = {
  avatarUrl: users.avatarUrl,
  login: users.login,
  name: users.name,
};

const authUserColumns = {
  ...publicUserColumns,
  id: users.id,
};

function toAuthUser(user: Pick<User, "avatarUrl" | "id" | "login" | "name">): AuthUser {
  return {
    avatarUrl: user.avatarUrl,
    id: UserId.make(user.id),
    login: user.login,
    name: user.name,
  };
}

function toPublicUser(user: Pick<User, "avatarUrl" | "login" | "name">): PublicUser {
  return { avatarUrl: user.avatarUrl, login: user.login, name: user.name };
}

export { authUserColumns, publicUserColumns, toAuthUser, toPublicUser };
